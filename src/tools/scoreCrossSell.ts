/**
 * score_cross_sell, for a (product_a, product_b) pair, return the
 * cross-sell strength.
 *
 * Implementation: ask /recommendations for product_a with a wide
 * limit and check whether product_b appears + at what confidence.
 * If it doesn't appear, the pair has no qualifying rule (signal is
 * effectively zero). If it does, the confidence value IS the
 * answer.
 *
 * Useful for AI agents validating a recommendation before suggesting
 * it ("is X actually a good pair with Y, or am I making that up?")
 * and for merchandisers vetting a hand-picked bundle.
 */

import {
  ApiError,
  activeContext,
  getRecommendations,
  missingKeyReply,
} from "../lib/api.js";

export const definition = {
  name: "score_cross_sell",
  description:
    "Score the cross-sell strength (product affinity) between two specific products. Returns the confidence the merchant's real co-purchase data supports for the pair, or a clear 'no signal' result when there's no qualifying rule. Use this to validate a proposed pair before recommending it, or to answer 'is X a good cross-sell for Y?', 'how strong is the affinity between X and Y?', or 'how often are X and Y bought together?'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      product_a: {
        type: "string",
        description: "The 'antecedent' product (the one the customer already has).",
      },
      product_b: {
        type: "string",
        description: "The 'consequent' product (the one being evaluated as a cross-sell).",
      },
    },
    required: ["product_a", "product_b"],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const a = String(args.product_a ?? "").trim();
  const b = String(args.product_b ?? "").trim();
  if (a === "" || b === "") {
    return {
      content: [
        { type: "text" as const, text: "Error: product_a and product_b are both required." },
      ],
      isError: true,
    };
  }
  if (a === b) {
    return {
      content: [
        { type: "text" as const, text: "Error: product_a and product_b must be different products." },
      ],
      isError: true,
    };
  }

  try {
    // Pull more than the default so we can find b even if it's not
    // the top recommendation for a. 6 is the hosted API's max.
    const recs = await getRecommendations(ctx, a, 6);
    const match = recs.find((r) => r.productId === b || r.sku === b);

    if (!match) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No qualifying co-purchase rule found between product ${a} and product ${b}. ` +
              "This means either (a) the pair never co-occurs in the merchant's order history, " +
              "(b) the co-occurrence is too sparse to clear support/confidence thresholds, " +
              "or (c) the merchant hasn't run a mining job yet. " +
              "Treat this as 'no statistical signal for the pair', not 'the pair is bad.'\n\n" +
              "Structured JSON:\n```json\n" +
              JSON.stringify({ product_a: a, product_b: b, has_signal: false }, null, 2) +
              "\n```",
          },
        ],
      };
    }

    const strength =
      match.confidence >= 0.6 ? "strong" : match.confidence >= 0.3 ? "moderate" : "weak";
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Cross-sell strength for ${a} → ${b}: **${strength}** ` +
            `(confidence: ${(match.confidence * 100).toFixed(0)}%).\n\n` +
            "Structured JSON:\n```json\n" +
            JSON.stringify(
              {
                product_a: a,
                product_b: b,
                has_signal: true,
                confidence: match.confidence,
                strength,
                product_b_title: match.title,
                product_b_sku: match.sku,
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
