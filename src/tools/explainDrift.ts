/**
 * explain_drift, return the stats + a short templated narrative for ONE
 * drift alert. Wraps GET /api/v1/explain-drift.
 *
 * Where get_drift_alerts lists the feed, this tool drills into a single
 * alert_id and answers "why did this pair drift?": it returns the prior
 * / current confidence (plus support, lift, and sample count when the
 * alert still joins a live rule) and a deterministic, plain-language
 * sentence built from those exact numbers (the backend templates it, no
 * LLM, no fabricated metrics).
 *
 * A "disappeared" alert has no live rule, so support / lift /
 * sample_count come back null and the narrative says the pair stopped
 * co-occurring; the tool surfaces that gracefully rather than erroring.
 *
 * BigCommerce only today (Shopify has no api.v1.explain-drift route);
 * the tool surfaces the upstream 404 cleanly on platforms that lack it,
 * exactly like get_drift_alerts.
 */

import {
  ApiError,
  activeContext,
  apiGet,
  missingKeyReply,
} from "../lib/api.js";
import { z } from "zod";

const ExplainDriftSchema = z.object({
  alert_id: z.string().optional(),
  rule_id: z.string().nullable().optional(),
  antecedent: z.string().nullable().optional(),
  consequent: z.string().nullable().optional(),
  direction: z
    .enum(["weakened", "strengthened", "disappeared", "emerged"])
    .optional(),
  prior_confidence: z.number().nullable().optional(),
  current_confidence: z.number().nullable().optional(),
  support: z.number().nullable().optional(),
  lift: z.number().nullable().optional(),
  sample_count: z.number().nullable().optional(),
  severity: z.enum(["high", "medium", "low"]).optional(),
  detected_at: z.string().optional(),
  narrative: z.string().optional(),
});

export const definition = {
  name: "explain_drift",
  description:
    "Explain ONE drift alert: return its prior and current confidence (plus support, lift, and order sample count when the rule is still live) and a short plain-language narrative of how the pair moved versus the prior mining run. Use this when a merchant asks 'why did this pair drift?', 'explain this alert', or 'what changed for these two products?' after seeing it in get_drift_alerts. Different from get_drift_alerts: that lists the feed, this drills into a single alert_id with the change spelled out in a sentence. Handles a disappeared pair gracefully (only the prior confidence is available). BigCommerce only today.",
  inputSchema: {
    type: "object" as const,
    properties: {
      alert_id: {
        type: "string",
        description: "The id of the drift alert to explain, from get_drift_alerts.",
      },
    },
    required: ["alert_id"],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const alertId = String(args.alert_id ?? "").trim();
  if (alertId === "") {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: alert_id is required.",
        },
      ],
      isError: true,
    };
  }

  try {
    const data = await apiGet(
      ctx,
      "/api/v1/explain-drift",
      { alert_id: alertId },
      ExplainDriftSchema,
    );
    const text =
      data.narrative ??
      buildFallback(
        data.direction,
        data.prior_confidence ?? null,
        data.current_confidence ?? null,
      );
    return {
      content: [
        {
          type: "text" as const,
          text:
            text +
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

/**
 * Defensive client-side line if the backend ever omits the narrative.
 * Uses only the real stats, no invented values.
 */
function buildFallback(
  direction: string | undefined,
  prior: number | null,
  current: number | null,
): string {
  const dir = direction ?? "drifted";
  const priorStr = prior != null ? `${(prior * 100).toFixed(0)}%` : "unknown";
  const currentStr = current != null ? `${(current * 100).toFixed(0)}%` : "unknown";
  return `This pair ${dir} versus the prior mining run (confidence ${priorStr} to ${currentStr}).`;
}
