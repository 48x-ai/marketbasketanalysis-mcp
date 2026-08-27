/**
 * Hosted endpoints for B2B / account-scoped features.
 *
 * Separate from src/lib/api.ts because these endpoints carry a
 * customer_id path parameter and return different shapes, putting
 * them in api.ts would make that file feel like a god-module.
 */

import { z } from "zod";
import { apiGet, type ApiContext } from "./api.js";

const ReorderPredictionSchema = z.object({
  productId: z.string(),
  sku: z.string().nullable(),
  title: z.string().nullable(),
  totalOrders: z.number(),
  lastOrderedAt: z.string(),
  meanIntervalDays: z.number(),
  stdevDays: z.number(),
  predictedNextAt: z.string(),
  daysUntilPredicted: z.number(),
  confidence: z.number(),
  status: z.enum(["overdue", "due_soon", "on_track", "not_predictable"]),
});

const ReorderPredictionResultSchema = z.object({
  customerId: z.string(),
  totalOrders: z.number(),
  windowOrders: z.number(),
  predictions: z.array(ReorderPredictionSchema),
});

export type ReorderPrediction = z.infer<typeof ReorderPredictionSchema>;
export type ReorderPredictionResult = z.infer<typeof ReorderPredictionResultSchema>;

/**
 * Calls the reorder-predictions endpoint and returns the structured
 * prediction set.
 *
 * Writes the canonical hosted-plane path. `resolvePlatformPath` in
 * lib/api.ts rewrites it for the self-hosted backends, where the
 * resource segment is "customers" rather than "accounts":
 *
 *   shopify / bigcommerce  {apiBase}/api/v1/accounts/:id/reorder-predictions
 *   woocommerce            {siteUrl}/wp-json/marketbasketanalysis/v1/customers/:id/reorder-predictions
 *   magento                {restBase}/V1/marketbasketanalysis/customers/:id/reorder-predictions
 */
export async function getReorderPredictions(
  ctx: ApiContext,
  customerId: string,
  productIdFilter?: string,
): Promise<ReorderPredictionResult> {
  // Route through apiGet so we share the timeout, retry-on-5xx-or-429,
  // sanitized-error-surface, and zod response validation that direct
  // fetch() bypasses.
  const path = `/api/v1/accounts/${encodeURIComponent(customerId)}/reorder-predictions`;
  const params: Record<string, string> = {};
  if (productIdFilter) {
    params.product_id = productIdFilter;
  }
  return apiGet<ReorderPredictionResult>(ctx, path, params, ReorderPredictionResultSchema);
}
