/**
 * execute_weekly_plan_action, kick off a specific action from the
 * merchant's weekly plan. Wraps POST /api/v1/weekly-plan/execute.
 *
 * The backend dispatches to a per-action-type handler (publish a
 * bundle, run a fresh mining job, archive a stale rule, etc.) and
 * de-duplicates by action_id so the agent can safely retry.
 *
 * Tool description is engineered for the "yes do that" follow-up
 * after get_weekly_plan. The agent should call this after the merchant
 * confirms the recommended next step, never preemptively.
 */

import {
  ApiError,
  activeContext,
  apiPost,
  missingKeyReply,
} from "../lib/api.js";
import { z } from "zod";

const ExecuteResponseSchema = z.object({
  action_id: z.string().optional(),
  status: z.enum(["queued", "running", "complete", "skipped", "error"]).optional(),
  message: z.string().nullable().optional(),
});

export const definition = {
  name: "execute_weekly_plan_action",
  description:
    "Execute a specific action from the merchant's weekly plan (publish bundle, run mining job, archive rule, etc.). Idempotent by action_id, safe to retry. Use this AFTER the merchant has confirmed which action from get_weekly_plan they want to run; do not call preemptively. Merchant-ops surface: BigCommerce today; on other platforms merchants manage this from the admin, and the tool returns a clear not-available message.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action_id: {
        type: "string",
        description: "The id of the action to execute, from get_weekly_plan.",
      },
      confirm: {
        type: "boolean",
        description: "Must be true to actually execute. Guard against accidental dispatch.",
        default: false,
      },
    },
    required: ["action_id", "confirm"],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const actionId = String(args.action_id ?? "").trim();
  if (actionId === "") {
    return {
      content: [{ type: "text" as const, text: "Error: action_id is required." }],
      isError: true,
    };
  }
  if (args.confirm !== true) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "Error: this is a state-mutating action. Pass confirm=true after the merchant " +
            "has explicitly approved running this action.",
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await apiPost(
      ctx,
      "/api/v1/weekly-plan/execute",
      { action_id: actionId },
      ExecuteResponseSchema,
    );
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Action ${actionId} dispatched (status: ${result.status ?? "unknown"}).` +
            (result.message ? ` ${result.message}` : "") +
            "\n\nStructured JSON:\n```json\n" +
            JSON.stringify(result, null, 2) +
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
