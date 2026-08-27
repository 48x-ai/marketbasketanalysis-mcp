/**
 * get_opportunities, list the merchant's ranked bundle / cross-sell
 * opportunities. Wraps GET /api/v1/opportunities.
 *
 * Opportunities are mining-job outputs scored by revenue-weighted
 * support * confidence * lift, with status (proposed / active /
 * paused / archived). The agent surfaces these so a merchant can
 * triage from chat without opening the admin grid.
 */

import {
  ApiError,
  activeContext,
  apiGet,
  coerceLimit,
  missingKeyReply,
} from "../lib/api.js";
import { z } from "zod";

const OpportunitySchema = z.object({
  id: z.string(),
  rule_id: z.string().optional(),
  antecedent_sku: z.string().nullable().optional(),
  consequent_sku: z.string().nullable().optional(),
  antecedent_title: z.string().nullable().optional(),
  consequent_title: z.string().nullable().optional(),
  support: z.number().optional(),
  confidence: z.number().optional(),
  lift: z.number().optional(),
  revenue_weighted_score: z.number().nullable().optional(),
  status: z.enum(["proposed", "active", "paused", "archived"]).optional(),
});

const OpportunitiesResponseSchema = z.object({
  opportunities: z.array(OpportunitySchema).optional(),
  total: z.number().optional(),
});

export const definition = {
  name: "get_opportunities",
  description:
    "List the merchant's ranked bundle / cross-sell opportunities mined from order history, with support / confidence / lift / revenue-weighted score. Use this when a merchant asks 'what are my top opportunities?', 'show me the best bundles I haven't published yet', or 'what should I prioritize?'. Pair with triage_opportunity to act on a specific one. Merchant-ops surface: BigCommerce today; on other platforms merchants manage this from the admin, and the tool returns a clear not-available message.",
  inputSchema: {
    type: "object" as const,
    properties: {
      status: {
        type: "string",
        enum: ["proposed", "active", "paused", "archived", "all"],
        description: "Filter by opportunity status. Defaults to 'proposed' (untriaged).",
        default: "proposed",
      },
      limit: {
        type: "integer",
        description: "Max opportunities to return. Default 10, max 50.",
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

  const status = String(args.status ?? "proposed").trim();
  const limit = coerceLimit(args.limit, 10, 50);

  try {
    const params: Record<string, string | number> = { limit };
    if (status && status !== "all") params.status = status;
    const data = await apiGet(
      ctx,
      "/api/v1/opportunities",
      params,
      OpportunitiesResponseSchema,
    );
    const opps = data.opportunities ?? [];
    if (opps.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No ${status} opportunities found. ` +
              "Either the merchant hasn't run a mining job yet, all opportunities have already been triaged, " +
              "or no rules cleared the support / confidence thresholds.",
          },
        ],
      };
    }
    const lines = opps.map((o, i) => {
      const a = o.antecedent_title ?? o.antecedent_sku ?? "?";
      const b = o.consequent_title ?? o.consequent_sku ?? "?";
      const conf = o.confidence != null ? `${(o.confidence * 100).toFixed(0)}%` : "?";
      const lift = o.lift != null ? o.lift.toFixed(2) : "?";
      return `${i + 1}. ${a} -> ${b} (id: ${o.id}, conf: ${conf}, lift: ${lift}, status: ${o.status ?? "?"})`;
    });
    return {
      content: [
        {
          type: "text" as const,
          text:
            `${opps.length} ${status} opportunit${opps.length === 1 ? "y" : "ies"}:\n\n` +
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
