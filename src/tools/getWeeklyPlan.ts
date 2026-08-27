/**
 * get_weekly_plan, fetch the merchant's current weekly action plan.
 *
 * Wraps GET /api/v1/weekly-plan/current. The hosted backend runs a
 * cron job each week that summarizes the top opportunities, drift
 * alerts, and forecast warnings into a typed list of actions the
 * merchant should take. The agent surfaces this so a merchant can ask
 * Claude "what should I work on this week?" without opening the admin.
 *
 * Tool description is engineered for the merchant-asks-the-agent
 * intent: "weekly plan", "what should I do", "this week's tasks".
 */

import {
  ApiError,
  activeContext,
  apiGet,
  missingKeyReply,
} from "../lib/api.js";
import { z } from "zod";

const WeeklyPlanActionSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  estimated_impact_usd: z.number().nullable().optional(),
  link: z.string().nullable().optional(),
});

const WeeklyPlanSchema = z.object({
  week_start: z.string().optional(),
  generated_at: z.string().optional(),
  actions: z.array(WeeklyPlanActionSchema).optional(),
});

export const definition = {
  name: "get_weekly_plan",
  description:
    "Fetch the current weekly action plan for the merchant: a ranked list of typed actions (publish opportunity, retire stale bundle, reorder inventory, investigate drift, etc.) the merchant should take this week. Use this when a merchant asks 'what should I work on this week?', 'what's on my plate?', 'show me my weekly plan', or wants a summary of pending tasks before opening the admin. Merchant-ops surface: BigCommerce today; on other platforms merchants manage this from the admin, and the tool returns a clear not-available message.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

export async function handler(_args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  try {
    const plan = await apiGet(
      ctx,
      "/api/v1/weekly-plan/current",
      {},
      WeeklyPlanSchema,
    );
    const actions = plan.actions ?? [];
    if (actions.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "No actions in this week's plan. The hosted cron job may not have run yet, " +
              "or the merchant has no pending opportunities, drift alerts, or forecast warnings.",
          },
        ],
      };
    }
    const lines = actions.map((a, i) => {
      const prio = a.priority ? ` [${a.priority}]` : "";
      const impact =
        a.estimated_impact_usd != null
          ? ` (est. impact: $${a.estimated_impact_usd.toFixed(0)})`
          : "";
      return `${i + 1}.${prio} ${a.title}${impact} (action_id: ${a.id}, type: ${a.type})`;
    });
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Weekly plan (${actions.length} action${actions.length === 1 ? "" : "s"}):\n\n` +
            lines.join("\n") +
            "\n\nStructured JSON:\n```json\n" +
            JSON.stringify(plan, null, 2) +
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
