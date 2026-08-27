/**
 * score_return_risk, for a candidate bundle of products, predict
 * the probability the bundle gets returned based on each item's
 * historical return rate.
 *
 * Composite model: max(item returnRate) for the bundle, since a
 * single returned item in a bundle almost always means the whole
 * bundle is returned (shipping label asymmetry, customer can't
 * partial-return a "buy this set" promo). When a future model
 * version moves to a weighted average or a logistic combination,
 * the contract stays the same: one composite number + per-item
 * detail.
 *
 * Tool description is engineered for agent tool selection: includes
 * the phrasings shopping + fashion agents use ("will this bundle
 * get returned?", "predict return risk", "fashion bundle risk")
 * so the MCP host picks this tool over generic recommendation
 * lookups when the agent's intent is return-rate assessment.
 */

import {
  ApiError,
  activeContext,
  getReturnRiskForBundle,
  missingKeyReply,
  type ProductReturnRate,
} from "../lib/api.js";

const DEFAULT_THRESHOLD = 0.15;

export const definition = {
  name: "score_return_risk",
  description:
    "Predict return risk for a candidate bundle of 2-6 products. Returns the composite bundle return rate (max of items, since one returned item typically returns the whole bundle), each item's historical return rate, and a low/medium/high risk recommendation. Use this when the user asks 'will this bundle get returned?', 'predict return risk for these items', 'fashion bundle risk', 'is this set risky to ship together?', or when an agent is composing a bundle and wants to verify it won't tank the merchant's return KPIs. Backed by return-aware mining over the merchant's real order + refund history.",
  inputSchema: {
    type: "object" as const,
    properties: {
      product_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Product ids for the candidate bundle. 2-6 items. Each id is either the numeric storefront id (e.g. '8472918765') or the platform-specific GID/SKU.",
        minItems: 2,
        maxItems: 6,
      },
      threshold: {
        type: "number",
        description:
          "Optional override for the 'high risk' cutoff. Defaults to 0.15 (15%). Items above this contribute to a stronger warning in the recommendation text. The low/medium/high classification itself uses fixed bands (<10% / 10-25% / >25%).",
        default: DEFAULT_THRESHOLD,
        minimum: 0,
        maximum: 1,
      },
    },
    required: ["product_ids"],
  },
};

type RiskLevel = "low" | "medium" | "high" | "unknown";

function classify(rate: number | null): RiskLevel {
  if (rate === null || !Number.isFinite(rate)) return "unknown";
  if (rate < 0.10) return "low";
  if (rate <= 0.25) return "medium";
  return "high";
}

function coerceThreshold(raw: unknown): number {
  if (raw === null || raw === undefined) return DEFAULT_THRESHOLD;
  if (typeof raw === "string" && raw.trim() === "") return DEFAULT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.max(0, Math.min(1, n));
}

function coerceProductIds(raw: unknown): string[] | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: "product_ids must be an array of 2-6 product id strings." };
  }
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") {
      return { error: "product_ids must contain only string ids." };
    }
    const trimmed = v.trim();
    if (trimmed !== "") ids.push(trimmed);
  }
  // De-duplicate while preserving order. A bundle with the same item
  // twice is a UI bug, not a return-risk signal.
  const seen = new Set<string>();
  const deduped = ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (deduped.length < 2) {
    return { error: "product_ids must contain at least 2 distinct product ids." };
  }
  if (deduped.length > 6) {
    return { error: "product_ids must contain at most 6 product ids." };
  }
  return deduped;
}

function recommendationText(
  level: RiskLevel,
  composite: number | null,
  threshold: number,
  itemsAboveThreshold: ProductReturnRate[],
): string {
  if (level === "unknown") {
    return (
      "Return-rate data not available for this bundle. " +
      "Ask the merchant to run a fresh mining job so return-aware rules are emitted, " +
      "then retry. Until then, treat the bundle as 'unknown risk' rather than 'low risk'."
    );
  }
  const pct = composite !== null ? `${(composite * 100).toFixed(1)}%` : "n/a";
  if (level === "low") {
    return `Low return risk (composite ${pct}). Safe to ship this bundle as-is.`;
  }
  if (level === "medium") {
    const offenders = itemsAboveThreshold
      .map((i) => i.title ?? i.sku ?? i.productId)
      .join(", ");
    const tail = offenders
      ? ` Items pulling the risk up: ${offenders}.`
      : "";
    return (
      `Medium return risk (composite ${pct}). Consider tightening the size guide, ` +
      `adding a 'fits true to size' callout, or swapping one item for a lower-return alternative.${tail}`
    );
  }
  // high
  const offenders = itemsAboveThreshold
    .map((i) => `${i.title ?? i.sku ?? i.productId} (${((i.returnRate ?? 0) * 100).toFixed(1)}%)`)
    .join(", ");
  const tail = offenders
    ? ` High-return items in this bundle: ${offenders}.`
    : "";
  return (
    `High return risk (composite ${pct}, threshold ${(threshold * 100).toFixed(0)}%). ` +
    `Do not ship this bundle without a return-reducing intervention: swap the high-return item, ` +
    `add a fit-check step, or convert the promo from 'bundle' to 'separate items so partial returns are allowed'.${tail}`
  );
}

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const ids = coerceProductIds(args.product_ids);
  if (!Array.isArray(ids)) {
    return {
      content: [{ type: "text" as const, text: `Error: ${ids.error}` }],
      isError: true,
    };
  }
  const threshold = coerceThreshold(args.threshold);

  try {
    const items = await getReturnRiskForBundle(ctx, ids);
    const known = items.filter((i) => i.returnRate !== null) as Array<
      ProductReturnRate & { returnRate: number }
    >;

    // Composite: max of available rates. With zero known items we
    // surface "unknown" rather than guess.
    const composite =
      known.length === 0
        ? null
        : known.reduce((acc, i) => (i.returnRate > acc ? i.returnRate : acc), 0);
    const level: RiskLevel = composite === null ? "unknown" : classify(composite);
    const itemsAboveThreshold = known.filter((i) => i.returnRate > threshold);
    const recText = recommendationText(level, composite, threshold, itemsAboveThreshold);

    const lines: string[] = [];
    lines.push(`Return risk for bundle of ${ids.length} products: ${level.toUpperCase()}.`);
    lines.push("");
    lines.push("Per-item return rates:");
    for (const item of items) {
      const label = item.title ?? item.sku ?? item.productId;
      if (item.returnRate === null) {
        lines.push(`  - ${label} (id: ${item.productId}): data not available`);
      } else {
        const itemLevel = classify(item.returnRate);
        lines.push(
          `  - ${label} (id: ${item.productId}): ${(item.returnRate * 100).toFixed(1)}% (${itemLevel})`,
        );
      }
    }
    lines.push("");
    lines.push(recText);
    lines.push("");
    lines.push("Structured JSON:");
    lines.push("```json");
    lines.push(
      JSON.stringify(
        {
          product_ids: ids,
          composite_return_rate: composite,
          risk_level: level,
          threshold,
          items: items.map((i) => ({
            product_id: i.productId,
            sku: i.sku,
            title: i.title,
            return_rate: i.returnRate,
            returned_count: i.returnedCount,
            risk_level: classify(i.returnRate),
          })),
          recommendation: recText,
        },
        null,
        2,
      ),
    );
    lines.push("```");

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (e) {
    const message = e instanceof ApiError ? e.message : String(e);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
}
