/**
 * Basket-cohesion scoring used by analyze_basket.
 *
 * It scores "how well does this set of products hang together" by
 * checking each ordered pair (a, b) against the /recommendations
 * response for a and seeing whether b appears. The number is
 * coverage (matched / total pairs) × mean confidence of the matched
 * pairs. Centralized here so future tweaks (e.g. weighting recent
 * rules higher) only land in one place.
 */

import type { Recommendation } from "./api.js";

export interface BasketCohesion {
  cohesion: number;
  coverage: number;
  avgConfidence: number;
  matchedPairs: number;
  totalPairs: number;
  pairScores: Array<{ a: string; b: string; confidence: number }>;
}

/**
 * Computes cohesion for `basket` given the recommendations fetched
 * for each item. `recsByItem[i]` is expected to be the
 * `/recommendations` response for `basket[i]`.
 *
 * A basket of fewer than 2 items has no pairs and returns zeros.
 */
export function computeBasketCohesion(
  basket: string[],
  recsByItem: Recommendation[][],
): BasketCohesion {
  const totalPairs = basket.length * (basket.length - 1);
  if (basket.length < 2 || totalPairs === 0) {
    return {
      cohesion: 0,
      coverage: 0,
      avgConfidence: 0,
      matchedPairs: 0,
      totalPairs,
      pairScores: [],
    };
  }
  let matched = 0;
  let confidenceSum = 0;
  const pairScores: Array<{ a: string; b: string; confidence: number }> = [];
  for (let i = 0; i < basket.length; i++) {
    const recs = recsByItem[i] ?? [];
    for (let j = 0; j < basket.length; j++) {
      if (i === j) continue;
      const a = basket[i];
      const b = basket[j];
      const hit = recs.find((r) => r.productId === b || r.sku === b);
      if (hit) {
        matched++;
        confidenceSum += hit.confidence;
        pairScores.push({ a, b, confidence: hit.confidence });
      }
    }
  }
  const coverage = matched / totalPairs;
  const avgConfidence = matched === 0 ? 0 : confidenceSum / matched;
  return {
    cohesion: coverage * avgConfidence,
    coverage,
    avgConfidence,
    matchedPairs: matched,
    totalPairs,
    pairScores,
  };
}
