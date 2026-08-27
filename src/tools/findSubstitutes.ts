/**
 * find_substitutes, for a single product, return ranked replacement
 * options. Substitutes are the inverse of cross-sells; this tool
 * answers "what should I buy instead?" not "what should I buy with?".
 *
 * Tool description is engineered for agent tool selection: includes
 * the natural-language phrasings procurement and shopping agents use
 * ("out of stock", "alternative to X", "replacement for Y") so the
 * MCP host picks this tool over get_recommendations when the agent's
 * intent is substitution rather than complementing.
 */

import {
  ApiError,
  activeContext,
  coerceLimit,
  getSubstitutes,
  missingKeyReply,
  renderSubstitutes,
} from "../lib/api.js";

export const definition = {
  name: "find_substitutes",
  description:
    "For a given product, recommend the top substitute items that could REPLACE it (not complement it). Substitutes are the inverse of cross-sell: this answers 'what to buy instead', not 'what to buy with'. Use this when the user asks 'what's a substitute for X?', 'X is out of stock, what's a good alternative?', 'recommend a replacement for Y', 'find an equivalent product', or when a procurement agent needs to swap an unavailable SKU. Returns a ranked list with a similarity score and a reason (context_similar / category_match / vendor_match). Works for all five platforms: Shopify, BigCommerce, WooCommerce, Magento, and OroCommerce.",
  inputSchema: {
    type: "object" as const,
    properties: {
      product_id: {
        type: "string",
        description:
          "Product id, either the numeric storefront id (e.g. '8472918765') or the platform-specific GID/SKU. The id of the product the user wants to REPLACE.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of substitutes to return. Default 3, max 6.",
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
      content: [
        { type: "text" as const, text: "Error: product_id is required." },
      ],
      isError: true,
    };
  }
  const limit = coerceLimit(args.limit, 3, 6);

  try {
    const subs = await getSubstitutes(ctx, productId, limit);
    if (subs.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No substitutes found for product ${productId}. This usually means either ` +
              "(a) the product isn't in the most-recent mining job's catalog, " +
              "(b) the catalog has no items with similar basket context (typical for the only-of-its-kind product in a niche store), or " +
              "(c) the merchant hasn't run a mining job yet.",
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: renderSubstitutes(
            subs,
            `Top ${subs.length} substitutes for ${productId} (ranked by similarity to original):`,
          ),
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
