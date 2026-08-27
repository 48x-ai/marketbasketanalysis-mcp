/**
 * propose_subscription_bundle, given a customer's first-order items,
 * propose a recurring kit they're likely to subscribe to.
 *
 * Composes two MBA capabilities:
 *   1. /recommendations (cross-platform) for each seed, used to find
 *      complementary products and compute kit cohesion (same math
 *      as get_bundle_for_cart / analyze_basket).
 *   2. /accounts/:id/reorder-predictions for cadence signal, when a
 *      customer_id is supplied. Per-product mean intervals tell us
 *      which items the customer actually reorders on a steady
 *      rhythm vs which are one-off purchases.
 *
 * Output is a single ranked kit (with optional alternates surfaced in
 * the JSON block) of 3-6 products including the seeds, with a
 * predicted cadence (median of per-item cadences), a 0..1 confidence
 * score, and a rough monthly_value when prices are known.
 *
 * Targets the subscription-commerce / replenishment workflow: a
 * merchant agent asks "what should this customer subscribe to?",
 * "build a monthly bundle from their first order", or
 * "what's a recurring kit for these items?".
 */

import {
  ApiError,
  activeContext,
  getSubscriptionProposals,
  missingKeyReply,
  type Recommendation,
} from "../lib/api.js";
import type { ReorderPrediction } from "../lib/accounts.js";
import { computeBasketCohesion } from "../lib/cohesion.js";

/**
 * Default monthly cadence used when neither the customer-history
 * predictions nor the seed defaults give us a usable cadence.
 * 30 days is the subscription-industry median (groceries, pet food,
 * personal care all cluster around this). Better than NaN.
 */
const DEFAULT_CADENCE_DAYS = 30;

export const definition = {
  name: "propose_subscription_bundle",
  description:
    "Propose a recurring subscription bundle for a customer based on their first-order items. Given 1-5 seed products the customer has bought, returns a recurring subscription bundle (3-6 items) of the seeds plus complementary products, with a predicted cadence (median days between reorders), a 0..1 confidence score, and a rough monthly_value when prices are known. Use this when a merchant agent asks 'what should they subscribe to?', 'build a monthly subscription bundle from this order', 'propose a subscription bundle', 'recommend a recurring replenishment bundle', or 'what's the right subscription frequency for this customer?'. If a customer_id is supplied the tool blends in the customer's per-SKU reorder cadence; without one it falls back to the seed catalog cohesion alone. Works for all five platforms: Shopify, BigCommerce, WooCommerce, Magento, and OroCommerce (the optional reorder-cadence blend needs a customer_id and is not available on OroCommerce).",
  inputSchema: {
    type: "object" as const,
    properties: {
      seed_product_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Products the customer bought in their first order (1-5). The proposed subscription bundle will include these plus complementary items.",
        minItems: 1,
        maxItems: 5,
      },
      customer_id: {
        type: "string",
        description:
          "Optional customer id (numeric storefront id or GID). When supplied, the tool pulls the customer's reorder-prediction history to anchor the cadence and confidence. Without this, the proposal uses seed-only catalog cohesion.",
      },
      cadence_days: {
        type: "integer",
        description:
          "Optional target subscription frequency in days (e.g. 30 for monthly, 14 for biweekly). When supplied, the tool snaps the predicted cadence toward this target and weights candidates whose individual cadences are close to it.",
        minimum: 7,
        maximum: 180,
      },
      kit_size: {
        type: "integer",
        description: "Target total items in the subscription bundle (seeds + complements). Default 4, clamped to [3, 6].",
        default: 4,
        minimum: 3,
        maximum: 6,
      },
    },
    required: ["seed_product_ids"],
  },
};

interface KitCandidate {
  productId: string;
  sku: string;
  title: string | null;
  pairs: number;
  avgConfidence: number;
  price: number | null;
  currency: string | null;
  /** Per-product mean reorder cadence in days, when known from
   * customer history. Null when the customer hasn't reordered this
   * SKU twice, or no customer_id was provided. */
  cadenceDays: number | null;
}

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const rawSeeds = Array.isArray(args.seed_product_ids) ? args.seed_product_ids : [];
  const seeds = rawSeeds.map((id) => String(id).trim()).filter((id) => id !== "");
  if (seeds.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: seed_product_ids must contain at least one product.",
        },
      ],
      isError: true,
    };
  }
  if (seeds.length > 5) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: seed_product_ids accepts at most 5 items.",
        },
      ],
      isError: true,
    };
  }
  const seedSet = new Set(seeds);

  const customerId = String(args.customer_id ?? "").trim() || undefined;

  const rawCadence = args.cadence_days;
  const targetCadence =
    typeof rawCadence === "number" && Number.isFinite(rawCadence) && rawCadence > 0
      ? Math.max(7, Math.min(180, Math.trunc(rawCadence)))
      : undefined;

  const rawKit = Number(args.kit_size ?? 4);
  const kitSize = Number.isFinite(rawKit)
    ? Math.max(3, Math.min(6, Math.trunc(rawKit)))
    : 4;

  try {
    const { recsBySeed, predictions } = await getSubscriptionProposals(
      ctx,
      seeds,
      customerId,
    );

    // Index predictions by both productId and sku so we can match
    // however the recommendations endpoint chose to identify items.
    const predictionByKey = new Map<string, ReorderPrediction>();
    for (const p of predictions) {
      predictionByKey.set(p.productId, p);
      if (p.sku) predictionByKey.set(p.sku, p);
    }

    // Aggregate complement candidates (same heuristic as
    // get_bundle_for_cart: pairs * avgConfidence + pairs).
    const aggregates = new Map<
      string,
      { pairs: number; confidenceSum: number; sample: Recommendation }
    >();
    for (const recs of recsBySeed) {
      for (const r of recs) {
        if (seedSet.has(r.productId) || seedSet.has(r.sku)) continue;
        const existing = aggregates.get(r.productId);
        if (existing) {
          existing.pairs += 1;
          existing.confidenceSum += r.confidence;
        } else {
          aggregates.set(r.productId, {
            pairs: 1,
            confidenceSum: r.confidence,
            sample: r,
          });
        }
      }
    }

    // Build kit-candidate objects with cadence signal. When a
    // candidate has both co-purchase support AND appears in the
    // customer's reorder history, it's a strong subscription pick.
    const candidates: KitCandidate[] = [...aggregates.values()].map((agg) => {
      const pred =
        predictionByKey.get(agg.sample.productId) ??
        predictionByKey.get(agg.sample.sku);
      return {
        productId: agg.sample.productId,
        sku: agg.sample.sku,
        title: agg.sample.title,
        pairs: agg.pairs,
        avgConfidence: agg.confidenceSum / agg.pairs,
        price: agg.sample.price ?? null,
        currency: agg.sample.currency ?? null,
        cadenceDays: pred?.meanIntervalDays ?? null,
      };
    });

    // Rank candidates. Base score is the bundle-cohesion heuristic
    // (confidenceSum + pairs); we add a cadence bonus when the
    // candidate's individual cadence is close to the target (or to
    // the global subscription default when no target is set), and
    // a "customer actually reorders this" bonus when we have a
    // prediction at all.
    const referenceCadence = targetCadence ?? DEFAULT_CADENCE_DAYS;
    candidates.sort((a, b) => {
      const sa = scoreCandidate(a, referenceCadence);
      const sb = scoreCandidate(b, referenceCadence);
      return sb - sa;
    });

    const complementSlots = Math.max(0, kitSize - seeds.length);
    const chosen = candidates.slice(0, complementSlots);

    const kitItems: Array<{
      productId: string;
      sku: string | null;
      title: string | null;
      role: "seed" | "complement";
      cadenceDays: number | null;
      price: number | null;
      currency: string | null;
    }> = [];

    // Seeds. Look up their own cadence + price from any rec that
    // mentions them.
    for (const seedId of seeds) {
      const meta = findSeedMeta(seedId, recsBySeed);
      const pred = predictionByKey.get(seedId);
      kitItems.push({
        productId: seedId,
        sku: meta?.sku ?? null,
        title: meta?.title ?? null,
        role: "seed",
        cadenceDays: pred?.meanIntervalDays ?? null,
        price: meta?.price ?? null,
        currency: meta?.currency ?? null,
      });
    }
    for (const c of chosen) {
      kitItems.push({
        productId: c.productId,
        sku: c.sku,
        title: c.title,
        role: "complement",
        cadenceDays: c.cadenceDays,
        price: c.price,
        currency: c.currency,
      });
    }

    // Cadence: median of per-item known cadences. When no item has
    // a known cadence, fall back to target (or DEFAULT_CADENCE_DAYS).
    const knownCadences = kitItems
      .map((i) => i.cadenceDays)
      .filter((c): c is number => typeof c === "number" && Number.isFinite(c) && c > 0);
    const predictedCadence =
      knownCadences.length > 0
        ? median(knownCadences)
        : (targetCadence ?? DEFAULT_CADENCE_DAYS);

    // Confidence blends three signals on [0, 1]:
    //   - seed cohesion (do the seeds hang together in carts?)
    //   - complement-pair coverage (how many seeds does each chosen
    //     complement pair with, normalized)
    //   - customer-history hit rate (how many kit items did we have
    //     reorder predictions for?)
    const seedCohesion = computeBasketCohesion(seeds, recsBySeed);
    const complementCoverage =
      chosen.length === 0
        ? 0
        : chosen.reduce((s, c) => s + c.pairs / Math.max(1, seeds.length), 0) /
          chosen.length;
    const historyHitRate =
      kitItems.length === 0
        ? 0
        : kitItems.filter((i) => i.cadenceDays != null).length / kitItems.length;
    const customerWeight = customerId ? 0.3 : 0;
    const cohesionWeight = customerId ? 0.4 : 0.6;
    const coverageWeight = customerId ? 0.3 : 0.4;
    const confidence = Math.max(
      0,
      Math.min(
        1,
        cohesionWeight * seedCohesion.cohesion +
          coverageWeight * complementCoverage +
          customerWeight * historyHitRate,
      ),
    );

    // Monthly value: if any kit item has a price, sum the known
    // prices and scale by (30 / predictedCadence). Items with null
    // prices contribute 0 (we surface a note when this happens).
    const knownPriceItems = kitItems.filter(
      (i) => typeof i.price === "number" && Number.isFinite(i.price) && (i.price ?? 0) > 0,
    );
    const kitOrderTotal = knownPriceItems.reduce((s, i) => s + (i.price ?? 0), 0);
    const monthlyValue =
      knownPriceItems.length > 0
        ? Math.round((kitOrderTotal * (30 / Math.max(1, predictedCadence))) * 100) /
          100
        : null;
    const currency = knownPriceItems.find((i) => i.currency)?.currency ?? null;

    const rationale = buildRationale({
      seedCount: seeds.length,
      complementCount: chosen.length,
      predictedCadence,
      targetCadence,
      hasCustomer: Boolean(customerId),
      historyHitRate,
      seedCohesion: seedCohesion.cohesion,
    });

    const proposal = {
      items: kitItems,
      cadence_days: Math.round(predictedCadence),
      confidence: Number(confidence.toFixed(3)),
      monthly_value: monthlyValue,
      currency,
      rationale,
    };

    // Alternate complements (those that didn't make the kit) are
    // included in the JSON block for agents that want to offer the
    // shopper a swap.
    const alternates = candidates.slice(complementSlots).slice(0, 4).map((c) => ({
      productId: c.productId,
      sku: c.sku,
      title: c.title,
      cadenceDays: c.cadenceDays,
      pairs: c.pairs,
      avg_confidence: Number(c.avgConfidence.toFixed(3)),
    }));

    const lines: string[] = [];
    lines.push(
      `Subscription kit proposal: ${proposal.items.length} item${proposal.items.length === 1 ? "" : "s"}, predicted cadence ${proposal.cadence_days}d, confidence ${(proposal.confidence * 100).toFixed(0)}%.`,
    );
    lines.push("");
    lines.push("**Kit**");
    for (const item of proposal.items) {
      const cad =
        item.cadenceDays != null
          ? `cadence ${Math.round(item.cadenceDays)}d`
          : "cadence unknown";
      const pr =
        item.price != null
          ? `${item.currency ?? ""}${item.price}`.trim()
          : "price unknown";
      lines.push(
        `  - [${item.role}] ${item.title ?? item.sku ?? item.productId} (${cad}, ${pr})`,
      );
    }
    if (proposal.monthly_value != null) {
      lines.push("");
      lines.push(
        `Estimated monthly value: ${proposal.currency ?? ""}${proposal.monthly_value}`.trim(),
      );
    }
    lines.push("");
    lines.push(`Rationale: ${proposal.rationale}`);

    return {
      content: [
        {
          type: "text" as const,
          text:
            lines.join("\n") +
            "\n\nStructured JSON:\n```json\n" +
            JSON.stringify(
              {
                proposal,
                alternates,
                signals: {
                  seed_cohesion: Number(seedCohesion.cohesion.toFixed(3)),
                  complement_coverage: Number(complementCoverage.toFixed(3)),
                  history_hit_rate: Number(historyHitRate.toFixed(3)),
                  customer_predictions_available: predictions.length,
                },
              },
              null,
              2,
            ) +
            "\n```",
        },
      ],
    };
  } catch (e) {
    const message = e instanceof ApiError ? e.message : String(e);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
}

function scoreCandidate(c: KitCandidate, referenceCadence: number): number {
  // Base = bundle-cohesion heuristic.
  let score = c.avgConfidence * c.pairs + c.pairs;
  // Customer-history bonus: we know they actually reorder this SKU.
  if (c.cadenceDays != null) {
    score += 1.0;
    // Cadence-fit bonus: penalize candidates whose cadence is far
    // from the target. Triangular kernel, peaks at perfect match.
    const distance = Math.abs(c.cadenceDays - referenceCadence);
    const fit = Math.max(0, 1 - distance / referenceCadence);
    score += fit;
  }
  return score;
}

function findSeedMeta(
  seedId: string,
  recsBySeed: Recommendation[][],
): Recommendation | undefined {
  // A seed product won't appear in its own recs (they're its
  // complements), but it might appear in another seed's recs. Scan
  // all of them for a matching productId or sku.
  for (const recs of recsBySeed) {
    const hit = recs.find((r) => r.productId === seedId || r.sku === seedId);
    if (hit) return hit;
  }
  return undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function buildRationale(args: {
  seedCount: number;
  complementCount: number;
  predictedCadence: number;
  targetCadence: number | undefined;
  hasCustomer: boolean;
  historyHitRate: number;
  seedCohesion: number;
}): string {
  const parts: string[] = [];
  if (args.hasCustomer && args.historyHitRate > 0.4) {
    parts.push(
      `${Math.round(args.historyHitRate * 100)}% of kit items match this customer's reorder cadence`,
    );
  } else if (args.hasCustomer) {
    parts.push("limited prior reorder history for these SKUs, cadence is catalog-default");
  } else {
    parts.push("cadence derived from catalog defaults (no customer_id supplied)");
  }
  if (args.seedCohesion >= 0.3) {
    parts.push("seeds co-occur strongly in carts");
  } else if (args.seedCohesion >= 0.1) {
    parts.push("seeds have moderate co-purchase signal");
  } else {
    parts.push("weak seed co-purchase signal, kit cohesion comes from complements");
  }
  if (args.targetCadence && Math.abs(args.predictedCadence - args.targetCadence) > 5) {
    parts.push(
      `predicted ${Math.round(args.predictedCadence)}d cadence differs from the ${args.targetCadence}d target`,
    );
  }
  return parts.join("; ") + ".";
}
