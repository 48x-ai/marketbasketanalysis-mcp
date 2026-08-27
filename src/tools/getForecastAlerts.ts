/**
 * get_forecast_alerts, list bundles whose forecast trend has flagged
 * a stockout risk or a falling-demand pattern. Wraps
 * GET /api/v1/forecast-alerts.
 *
 * Forecast alerts are the "buy more / sell off" feed: a bundle whose
 * Holt-Winters fit has flipped negative gets surfaced so the merchant
 * can either reorder, run a clearance, or retire the kit. Pair with
 * forecast_bundle to drill into a specific bundle's curve.
 */

import {
  ApiError,
  activeContext,
  apiGet,
  coerceLimit,
  missingKeyReply,
} from "../lib/api.js";
import { z } from "zod";

const ForecastAlertSchema = z.object({
  id: z.string(),
  bundle_id: z.string().optional(),
  bundle_title: z.string().nullable().optional(),
  kind: z.enum(["stockout_risk", "demand_drop", "demand_spike", "unreliable_forecast"]).optional(),
  severity: z.enum(["high", "medium", "low"]).optional(),
  weeks_of_stock: z.number().nullable().optional(),
  current_inventory: z.number().nullable().optional(),
  detected_at: z.string().optional(),
});

const ForecastAlertsResponseSchema = z.object({
  alerts: z.array(ForecastAlertSchema).optional(),
  total: z.number().optional(),
});

export const definition = {
  name: "get_forecast_alerts",
  description:
    "For an inventory or merchant-ops agent: list forecast-based alerts, the bundles with stockout risk, demand drop, demand spike, or an unreliable forecast curve. Use this when a merchant asks 'what's at risk of stockout?', 'which bundles are losing demand?', 'do I need to reorder anything?', or 'what should I restock?'. Pair with forecast_bundle to drill into a specific bundle. Merchant-ops surface: BigCommerce today; on other platforms merchants manage this from the admin, and the tool returns a clear not-available message.",
  inputSchema: {
    type: "object" as const,
    properties: {
      kind: {
        type: "string",
        enum: ["stockout_risk", "demand_drop", "demand_spike", "unreliable_forecast", "all"],
        description: "Filter by alert kind. Default 'all'.",
        default: "all",
      },
      severity: {
        type: "string",
        enum: ["high", "medium", "low", "all"],
        description: "Filter by severity. Default 'all'.",
        default: "all",
      },
      limit: {
        type: "integer",
        description: "Max alerts to return. Default 10, max 50.",
        default: 10,
        minimum: 1,
        maximum: 50,
      },
    },
    required: [],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const kind = String(args.kind ?? "all").trim();
  const severity = String(args.severity ?? "all").trim();
  const limit = coerceLimit(args.limit, 10, 50);
  const params: Record<string, string | number> = { limit };
  if (kind && kind !== "all") params.kind = kind;
  if (severity && severity !== "all") params.severity = severity;

  try {
    const data = await apiGet(
      ctx,
      "/api/v1/forecast-alerts",
      params,
      ForecastAlertsResponseSchema,
    );
    const alerts = data.alerts ?? [];
    if (alerts.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "No active forecast alerts. Either all bundles have healthy forecast trends " +
              "or the merchant has not yet run a forecast cron job.",
          },
        ],
      };
    }
    const lines = alerts.map((a, i) => {
      const title = a.bundle_title ?? a.bundle_id ?? "?";
      const sev = a.severity ? ` [${a.severity}]` : "";
      const kindStr = a.kind ?? "?";
      const woS =
        a.weeks_of_stock != null ? ` weeks_of_stock=${a.weeks_of_stock.toFixed(1)}` : "";
      return `${i + 1}.${sev} ${title}: ${kindStr}${woS} (id: ${a.id})`;
    });
    return {
      content: [
        {
          type: "text" as const,
          text:
            `${alerts.length} forecast alert${alerts.length === 1 ? "" : "s"}:\n\n` +
            lines.join("\n") +
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
