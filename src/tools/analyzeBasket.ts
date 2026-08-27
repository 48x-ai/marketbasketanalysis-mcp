/**
 * analyze_basket, for an arbitrary set of products, return the
 * basket's overall cohesion score: how strongly the products bind
 * together in the merchant's actual order history.
 *
 * Implementation: for each pair (a, b) in the basket, ask
 * /recommendations for a and check whether b appears. Average the
 * confidences of matched pairs; an unmatched pair contributes 0.
 * Cohesion = mean confidence × coverage (matched / total pairs).
 *
 * Useful for: agents proposing a bundle to a merchant ("here's a
 * proposed kit, is it a good idea?"), or merchandisers vetting a
 * hand-picked bundle before publishing.
 */

import {
  ApiError,
  activeContext,
  getRecommendations,
  missingKeyReply,
} from "../lib/api.js";
import { computeBasketCohesion } from "../lib/cohesion.js";

export const definition = {
  name: "analyze_basket",
  description:
    "Run market-basket analysis on a proposed basket / bundle to score its cohesion. Given 2+ products, returns a cohesion score 0..1 representing how strongly they bind together (their affinity) in the merchant's order data. Use this to vet a proposed bundle BEFORE recommending it, so agents can avoid suggesting bundles that look plausible but have no statistical signal. Also useful for 'is this a good bundle?', 'analyze this basket', or 'do these products go together?' questions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      product_ids: {
        type: "array",
        items: { type: "string" },
        description: "The products in the proposed basket (2-6).",
        minItems: 2,
        maxItems: 6,
      },
    },
    required: ["product_ids"],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const rawIds = Array.isArray(args.product_ids) ? args.product_ids : [];
  const basket = rawIds.map((id) => String(id).trim()).filter((id) => id !== "");
  if (basket.length < 2) {
    return {
      content: [
        { type: "text" as const, text: "Error: basket must contain at least 2 products." },
      ],
      isError: true,
    };
  }
  if (basket.length > 6) {
    return {
      content: [
        { type: "text" as const, text: "Error: basket size capped at 6 products." },
      ],
      isError: true,
    };
  }

  try {
    // Fetch /recommendations for each basket item in parallel,
    // basket is small (capped at 6), so a single batch is fine.
    // The shared helper expects results[i] to correspond to
    // basket[i].
    const results = await Promise.all(
      basket.map((id) => getRecommendations(ctx, id, 6).catch(() => [])),
    );

    // Score = coverage × mean-confidence over all ordered pairs.
    // Computed via the shared helper in src/lib/cohesion.ts.
    const {
      cohesion,
      coverage,
      avgConfidence,
      matchedPairs,
      totalPairs,
      pairScores,
    } = computeBasketCohesion(basket, results);

    const verdict =
      cohesion >= 0.4
        ? "strong cohesion, this is a good bundle candidate"
        : cohesion >= 0.15
          ? "moderate cohesion, some pairs are supported, others aren't"
          : "weak / no cohesion, the basket lacks co-purchase signal";

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Basket cohesion: **${cohesion.toFixed(3)}** (${Math.round(cohesion * 100)}%), ${verdict}.\n\n` +
            `Pairs matched: ${matchedPairs} / ${totalPairs} (${Math.round(coverage * 100)}% coverage).\n` +
            `Average confidence of matched pairs: ${(avgConfidence * 100).toFixed(0)}%.\n\n` +
            "Structured JSON:\n```json\n" +
            JSON.stringify(
              {
                basket,
                cohesion,
                coverage,
                avg_confidence: avgConfidence,
                matched_pairs: matchedPairs,
                total_pairs: totalPairs,
                pair_scores: pairScores,
                verdict,
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
