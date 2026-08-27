/**
 * get_bundle_for_cart, given the current cart contents, suggest
 * what's still missing to complete a high-confidence kit.
 *
 * Implementation: call /recommendations for each item in the cart,
 * aggregate results, and rank candidates by how many cart items they
 * pair with × average confidence. Products already in the cart are
 * filtered out. This composes the cart-completion behavior on top
 * of the single-product recommendations endpoint, no new hosted
 * endpoint needed.
 *
 * Useful for: AI shopping agents that need to suggest "you also
 * need X" mid-conversation. The natural inverse of
 * get_recommendations: there one product is the input; here many
 * products are.
 */

import {
  ApiError,
  activeContext,
  coerceLimit,
  getRecommendations,
  missingKeyReply,
  type Recommendation,
} from "../lib/api.js";

export const definition = {
  name: "get_bundle_for_cart",
  description:
    "Given a list of products already in the cart, recommend products that frequently bundle with the cart to complete a high-confidence bundle. This is multi-item basket analysis for cart completion. Use when the user describes a multi-item cart and asks 'what else do I need?', 'what completes this set?', 'what's missing from this bundle?', 'recommend add-ons for this cart', or similar. Different from get_recommendations: this takes MULTIPLE products and returns items that pair with the cart as a whole, not single-item pairings.",
  inputSchema: {
    type: "object" as const,
    properties: {
      product_ids: {
        type: "array",
        items: { type: "string" },
        description: "List of product ids currently in the cart (numeric or GID/SKU).",
        minItems: 1,
        maxItems: 20,
      },
      limit: {
        type: "integer",
        description: "Max suggestions to return. Default 3, max 6.",
        default: 3,
        minimum: 1,
        maximum: 6,
      },
    },
    required: ["product_ids"],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const rawIds = Array.isArray(args.product_ids) ? args.product_ids : [];
  const cart = rawIds.map((id) => String(id).trim()).filter((id) => id !== "");
  if (cart.length === 0) {
    return {
      content: [
        { type: "text" as const, text: "Error: product_ids must contain at least one product." },
      ],
      isError: true,
    };
  }
  const cartSet = new Set(cart);
  const limit = coerceLimit(args.limit, 3, 6);

  try {
    // Fan out: ask /recommendations for each cart item with a wide
    // limit (6) so we can find products that pair with MULTIPLE
    // items even if they're not the top match for any single one.
    // Concurrency capped at 6 to be polite to the API.
    const all: Array<{ source: string; rec: Recommendation }> = [];
    const chunks = chunkArray(cart, 6);
    for (const chunk of chunks) {
      const responses = await Promise.all(
        chunk.map((id) => getRecommendations(ctx, id, 6).catch(() => [])),
      );
      for (let i = 0; i < chunk.length; i++) {
        for (const rec of responses[i] ?? []) {
          all.push({ source: chunk[i], rec });
        }
      }
    }

    // Aggregate by recommended product. Score below is
    // `pairs × avgConfidence + pairs` (= confidenceSum + pairs), so
    // a product paired with many cart items beats a product paired
    // with one high-confidence cart item: each additional pair adds
    // both its confidence AND a +1 multi-pair bonus.
    const aggregates = new Map<
      string,
      { pairs: number; confidenceSum: number; sample: Recommendation }
    >();
    for (const { rec } of all) {
      if (cartSet.has(rec.productId)) continue;
      const existing = aggregates.get(rec.productId);
      if (existing) {
        existing.pairs += 1;
        existing.confidenceSum += rec.confidence;
      } else {
        aggregates.set(rec.productId, {
          pairs: 1,
          confidenceSum: rec.confidence,
          sample: rec,
        });
      }
    }

    const ranked = [...aggregates.values()]
      .sort((a, b) => {
        // pairs * avgConfidence + pairs  ==  confidenceSum + pairs
        // The +pairs term is the multi-pair-product boost: a
        // candidate that paired with 3 cart items at 0.4 each
        // (score 1.5) beats one that paired with a single cart
        // item at 0.9 (score 1.0).
        const sa = a.confidenceSum + a.pairs;
        const sb = b.confidenceSum + b.pairs;
        return sb - sa;
      })
      .slice(0, limit);

    if (ranked.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No kit-completion suggestions for the cart [${cart.join(", ")}]. ` +
              "This usually means the cart items don't have qualifying co-purchase rules yet, " +
              "or the merchant's mining job hasn't run.",
          },
        ],
      };
    }

    const lines = ranked.map((agg, i) => {
      const avgConf = agg.confidenceSum / agg.pairs;
      return `${i + 1}. ${agg.sample.title ?? agg.sample.sku} (SKU: ${agg.sample.sku}, pairs with ${agg.pairs}/${cart.length} cart items, avg confidence: ${(avgConf * 100).toFixed(0)}%)`;
    });

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Top ${ranked.length} kit-completion suggestions for cart of ${cart.length} items:\n\n` +
            lines.join("\n") +
            "\n\nStructured JSON:\n```json\n" +
            JSON.stringify(
              {
                suggestions: ranked.map((agg) => ({
                  productId: agg.sample.productId,
                  sku: agg.sample.sku,
                  title: agg.sample.title,
                  pairs_with: agg.pairs,
                  avg_confidence: agg.confidenceSum / agg.pairs,
                })),
                cart,
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

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
