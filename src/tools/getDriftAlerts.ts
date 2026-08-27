/**
 * get_drift_alerts, list active drift alerts where a previously
 * strong rule has weakened (or a previously weak rule has strengthened)
 * vs the prior mining job. Wraps GET /api/v1/drift-alerts.
 *
 * Drift alerts are the merchant's "your model needs attention" feed:
 * a stable rule going dark usually means a SKU changed, a vendor went
 * out, or seasonality flipped. Surfacing them in chat means the
 * merchant doesn't have to remember to open the admin.
 */

import {
  ApiError,
  activeContext,
  apiGet,
  coerceLimit,
  missingKeyReply,
} from "../lib/api.js";
import { z } from "zod";

const DriftAlertSchema = z.object({
  id: z.string(),
  rule_id: z.string().optional(),
  antecedent: z.string().nullable().optional(),
  consequent: z.string().nullable().optional(),
  direction: z.enum(["weakened", "strengthened", "disappeared", "emerged"]).optional(),
  prior_confidence: z.number().nullable().optional(),
  current_confidence: z.number().nullable().optional(),
  detected_at: z.string().optional(),
  severity: z.enum(["high", "medium", "low"]).optional(),
});

const DriftAlertsResponseSchema = z.object({
  alerts: z.array(DriftAlertSchema).optional(),
  total: z.number().optional(),
});

export const definition = {
  name: "get_drift_alerts",
  description:
    "For a merchant-ops or analytics agent: list active drift alerts, the recommendation rules whose confidence has materially changed (weakened, strengthened, disappeared, emerged) versus the prior mining job. Use this when a merchant asks 'what's changed?', 'is my model still accurate?', 'are any rules drifting?', or wants to investigate a SKU swap / seasonal shift. Merchant-ops surface: BigCommerce today; on other platforms merchants manage this from the admin, and the tool returns a clear not-available message.",
  inputSchema: {
    type: "object" as const,
    properties: {
      severity: {
        type: "string",
        enum: ["high", "medium", "low", "all"],
        description: "Filter alerts by severity. Default 'all'.",
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

  const severity = String(args.severity ?? "all").trim();
  const limit = coerceLimit(args.limit, 10, 50);
  const params: Record<string, string | number> = { limit };
  if (severity && severity !== "all") params.severity = severity;

  try {
    const data = await apiGet(
      ctx,
      "/api/v1/drift-alerts",
      params,
      DriftAlertsResponseSchema,
    );
    const alerts = data.alerts ?? [];
    if (alerts.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "No active drift alerts. Either the model is stable across the last two mining jobs, " +
              "or only one mining job has run (drift detection needs a prior baseline).",
          },
        ],
      };
    }
    const lines = alerts.map((a, i) => {
      const a0 = a.antecedent ?? "?";
      const c0 = a.consequent ?? "?";
      const sev = a.severity ? ` [${a.severity}]` : "";
      const dir = a.direction ?? "?";
      const prior = a.prior_confidence != null ? `${(a.prior_confidence * 100).toFixed(0)}%` : "?";
      const curr = a.current_confidence != null ? `${(a.current_confidence * 100).toFixed(0)}%` : "?";
      return `${i + 1}.${sev} ${a0} -> ${c0}: ${dir} (${prior} -> ${curr}, id: ${a.id})`;
    });
    return {
      content: [
        {
          type: "text" as const,
          text:
            `${alerts.length} drift alert${alerts.length === 1 ? "" : "s"}:\n\n` +
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
