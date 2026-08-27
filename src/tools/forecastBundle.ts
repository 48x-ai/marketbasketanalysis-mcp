/**
 * forecast_bundle, fetch the additive Holt-Winters forecast +
 * buy-quantity recommendation for a bundle. Wraps
 * GET /api/v1/forecast/bundle-inventory?bundleId=X&horizon=N.
 *
 * The GET variant pulls the merchant's stored historical-weeks
 * series for the bundle off the backend rather than requiring the
 * caller to POST it. Used by inventory + purchasing agents asking
 * "how many of bundle X should I buy for the next 8 weeks?".
 *
 * UNIT CONTRACT: the tool's public input is `horizon_weeks` (weeks),
 * because that's the natural unit for bundle forecasting and the
 * documented unit agents reason in. The backend `horizon` query
 * param is in DAYS (it validates 1..365 and treats the value as
 * `horizonDays`). We convert weeks to days (x7) at the boundary so a
 * caller asking for 8 weeks gets 56 days of forecast, not 8 days.
 * Keep this conversion here, in the one place that talks to the
 * endpoint, rather than leaking the day-based unit into the tool's
 * contract.
 */

const DAYS_PER_WEEK = 7;

import {
  ApiError,
  activeContext,
  apiGet,
  coerceLimit,
  missingKeyReply,
} from "../lib/api.js";
import { z } from "zod";

const ForecastWeekSchema = z.object({
  weekStart: z.string(),
  point_estimate: z.number(),
  p10: z.number().optional(),
  p90: z.number().optional(),
});

const ForecastResponseSchema = z.object({
  bundleId: z.string().optional(),
  forecastWeeks: z.array(ForecastWeekSchema).optional(),
  recommendation: z
    .object({
      buy_quantity: z.number(),
      safety_stock_weeks: z.number().optional(),
    })
    .optional(),
  reliable: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
});

export const definition = {
  name: "forecast_bundle",
  description:
    "For an inventory, purchasing, or merchant-ops agent: forecast weekly sales and recommend a buy quantity for a specific bundle over a configurable horizon. Uses additive Holt-Winters on the bundle's stored historical sales (demand forecasting). Use this when the agent asks 'how many of bundle X should I order?', 'what should I stock for the next N weeks?', 'what's the demand outlook for bundle Y?', or 'forecast the next 8 weeks for the camera bundle'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      bundle_id: {
        type: "string",
        description: "Bundle identifier (the platform-specific bundle/kit id).",
      },
      horizon_weeks: {
        type: "integer",
        description:
          "Forecast horizon in WEEKS. Default 8, range 1..52. The server converts this to days for the backend, so pass the number of weeks, not days.",
        default: 8,
        minimum: 1,
        maximum: 52,
      },
    },
    required: ["bundle_id"],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const bundleId = String(args.bundle_id ?? "").trim();
  if (bundleId === "") {
    return {
      content: [{ type: "text" as const, text: "Error: bundle_id is required." }],
      isError: true,
    };
  }
  const horizonWeeks = coerceLimit(args.horizon_weeks, 8, 52);
  // The backend `horizon` param is in DAYS; convert from the tool's
  // documented weeks unit so the forecast covers the requested span.
  const horizonDays = horizonWeeks * DAYS_PER_WEEK;

  try {
    const data = await apiGet(
      ctx,
      "/api/v1/forecast/bundle-inventory",
      { bundleId, horizon: horizonDays },
      ForecastResponseSchema,
    );
    const weeks = data.forecastWeeks ?? [];
    const rec = data.recommendation;
    const headline = rec
      ? `Recommended buy quantity: ${rec.buy_quantity}` +
        (rec.safety_stock_weeks ? ` (${rec.safety_stock_weeks} weeks safety stock)` : "") +
        "."
      : "No buy-quantity recommendation (insufficient history).";
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Forecast for bundle ${bundleId} over ${weeks.length} week(s).\n` +
            headline +
            (data.reliable === false ? "\n\nWARNING: forecast flagged as unreliable." : "") +
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
