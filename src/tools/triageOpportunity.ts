/**
 * triage_opportunity, pause / activate / archive a specific
 * opportunity. Wraps POST /api/v1/opportunities/{id}/action.
 *
 * State-mutating; guarded by a confirm flag so the agent can't
 * accidentally archive a high-revenue rule. Pair with
 * get_opportunities to fetch the list, then call this on the chosen
 * id after the merchant confirms.
 */

import {
  ApiError,
  activeContext,
  apiPost,
  missingKeyReply,
} from "../lib/api.js";
import { z } from "zod";

const TriageResponseSchema = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  message: z.string().nullable().optional(),
});

const VALID_ACTIONS = ["activate", "pause", "archive"] as const;

export const definition = {
  name: "triage_opportunity",
  description:
    "Pause, activate, or archive a specific opportunity from get_opportunities. State-mutating; guarded by confirm=true. Use this after the merchant has explicitly picked an opportunity to act on. Pass action='activate' to publish a proposed rule, 'pause' to temporarily hide an active one, 'archive' to permanently retire it. Merchant-ops surface: BigCommerce today; on other platforms merchants manage this from the admin, and the tool returns a clear not-available message.",
  inputSchema: {
    type: "object" as const,
    properties: {
      opportunity_id: {
        type: "string",
        description: "Opportunity id from get_opportunities.",
      },
      action: {
        type: "string",
        enum: ["activate", "pause", "archive"],
        description: "What to do with this opportunity.",
      },
      confirm: {
        type: "boolean",
        description: "Must be true to dispatch. Guard against accidental triage.",
        default: false,
      },
    },
    required: ["opportunity_id", "action", "confirm"],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const id = String(args.opportunity_id ?? "").trim();
  const action = String(args.action ?? "").trim();
  if (id === "" || action === "") {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: opportunity_id and action are both required.",
        },
      ],
      isError: true,
    };
  }
  if (!(VALID_ACTIONS as readonly string[]).includes(action)) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: action must be one of: ${VALID_ACTIONS.join(", ")}.`,
        },
      ],
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
            "has explicitly approved triaging this opportunity.",
        },
      ],
      isError: true,
    };
  }

  // URL-encode the id to defend against path traversal / special chars
  // that backends like nginx may interpret before our route layer sees
  // them. Opportunity ids in production are UUIDs but defense in depth.
  const safeId = encodeURIComponent(id);

  try {
    const result = await apiPost(
      ctx,
      `/api/v1/opportunities/${safeId}/action`,
      { action },
      TriageResponseSchema,
    );
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Opportunity ${id} -> ${action}: ${result.status ?? "ok"}.` +
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
