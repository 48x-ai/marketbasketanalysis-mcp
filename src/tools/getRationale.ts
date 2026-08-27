/**
 * get_rationale, fetch the one-sentence "why these go together"
 * explanation for a recommendation pair. Wraps
 * GET /api/v1/rationale?productId=X&relatedProductId=Y.
 *
 * The hosted backend caches rationales at the rule level so repeat
 * calls are single-digit ms. Used by the storefront FBT widget and
 * agent shopping flows that need a human-readable explanation
 * alongside a recommendation, not just a SKU + confidence.
 */

import {
  ApiError,
  activeContext,
  apiGet,
  missingKeyReply,
} from "../lib/api.js";
import { z } from "zod";

const RationaleSchema = z.object({
  sentence: z.string(),
  cached: z.boolean().optional(),
  fallback: z.boolean().optional(),
  ttlSeconds: z.number().optional(),
});

export const definition = {
  name: "get_rationale",
  description:
    "Fetch the one-sentence rationale for why product B is recommended alongside product A. Returns a short merchandiser-grade explanation ('these are commonly bought together by customers buying X') suitable for surfacing in a recommendation tile or chat reply. Use this after get_recommendations / get_bundle_for_cart when the agent or user asks 'why are these recommended together?' or 'explain this pairing'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      product_id: {
        type: "string",
        description: "The base product id (the antecedent in the recommendation rule).",
      },
      related_product_id: {
        type: "string",
        description: "The recommended product id (the consequent in the rule).",
      },
    },
    required: ["product_id", "related_product_id"],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const productId = String(args.product_id ?? "").trim();
  const related = String(args.related_product_id ?? "").trim();
  if (productId === "" || related === "") {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: product_id and related_product_id are both required.",
        },
      ],
      isError: true,
    };
  }

  try {
    const data = await apiGet(
      ctx,
      "/api/v1/rationale",
      { productId, relatedProductId: related },
      RationaleSchema,
    );
    return {
      content: [
        {
          type: "text" as const,
          text:
            data.sentence +
            (data.fallback ? "\n\n(generic fallback rationale, no rule-specific copy yet)" : "") +
            "\n\nStructured JSON:\n```json\n" +
            JSON.stringify(data, null, 2) +
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
