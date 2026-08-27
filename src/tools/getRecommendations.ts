/**
 * get_recommendations, for a single product, return ranked
 * complementary products customers also buy.
 *
 * Tool description is engineered for agent tool selection: includes
 * the natural-language phrasings shoppers and merchandisers use
 * ("what goes with X?", "what should I bundle with X?") so the
 * agent picks this tool without explicit prompt engineering.
 */

import {
  ApiError,
  activeContext,
  coerceLimit,
  getRecommendations,
  missingKeyReply,
  renderRecommendations,
} from "../lib/api.js";

export const definition = {
  name: "get_recommendations",
  description:
    "For a given product, recommend the top complementary, frequently-bought-together products customers also bought, based on mined order-history association rules. This is the single-product cross-sell tool. Use this when the user asks 'what goes with X?', 'what should I bundle with X?', 'what do customers also buy with X?', 'recommend products to cross-sell with X', or similar single-product co-purchase questions. Works for all five platforms: Shopify, BigCommerce, WooCommerce, Magento, and OroCommerce.",
  inputSchema: {
    type: "object" as const,
    properties: {
      product_id: {
        type: "string",
        description:
          "Product id, either the numeric storefront id (e.g. '8472918765') or the platform-specific GID/SKU. Both are accepted.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of recommendations to return. Default 3, max 6.",
        default: 3,
        minimum: 1,
        maximum: 6,
      },
    },
    required: ["product_id"],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const productId = String(args.product_id ?? "").trim();
  if (productId === "") {
    return {
      content: [{ type: "text" as const, text: "Error: product_id is required." }],
      isError: true,
    };
  }
  const limit = coerceLimit(args.limit, 3, 6);

  try {
    const recs = await getRecommendations(ctx, productId, limit);
    if (recs.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No recommendations found for product ${productId}. This usually means either ` +
              "(a) the product isn't in the most-recent mining job's catalog, " +
              "(b) no qualifying co-purchase rules pair it with anything yet, or " +
              "(c) the merchant hasn't run a mining job yet.",
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: renderRecommendations(recs, `Top ${recs.length} complementary products for ${productId}:`),
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
