/**
 * explain_opportunity, return the stats + a short templated narrative
 * for ONE mined opportunity. Wraps GET /api/v1/explain-opportunity.
 *
 * Where get_opportunities lists the ranked set, this tool drills into a
 * single opportunity_id and answers "why is this a good cross-sell?":
 * it returns the rule's support, confidence, lift, and sample count
 * plus a deterministic, plain-language sentence built from those exact
 * numbers (the backend templates it, no LLM, no fabricated metrics).
 *
 * BigCommerce and Shopify both expose api.v1.explain-opportunity today;
 * the tool surfaces the upstream 404 cleanly on platforms that lack it
 * (WooCommerce, Magento, OroCommerce), exactly like get_opportunities.
 */

import {
  ApiError,
  activeContext,
  apiGet,
  missingKeyReply,
} from "../lib/api.js";
import { z } from "zod";

const ExplainOpportunitySchema = z.object({
  opportunity_id: z.string().optional(),
  rule_id: z.string().optional(),
  antecedent_sku: z.string().nullable().optional(),
  antecedent_title: z.string().nullable().optional(),
  consequent_sku: z.string().nullable().optional(),
  consequent_title: z.string().nullable().optional(),
  support: z.number().optional(),
  confidence: z.number().optional(),
  lift: z.number().optional(),
  sample_count: z.number().optional(),
  narrative: z.string().optional(),
});

export const definition = {
  name: "explain_opportunity",
  description:
    "Explain ONE mined opportunity: return its support, confidence, lift, and order sample count plus a short plain-language narrative of why the pair is a good cross-sell. Use this when a merchant asks 'why is this a good cross-sell?', 'explain this opportunity', or 'why should I bundle these?' after seeing it in get_opportunities. Different from get_opportunities: that lists the ranked set, this drills into a single opportunity_id with the stats spelled out in a sentence. Different from get_rationale: rationale is a generic pair 'why', this is the specific mined opportunity's own numbers. BigCommerce only today.",
  inputSchema: {
    type: "object" as const,
    properties: {
      opportunity_id: {
        type: "string",
        description: "The id of the opportunity to explain, from get_opportunities.",
      },
    },
    required: ["opportunity_id"],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const opportunityId = String(args.opportunity_id ?? "").trim();
  if (opportunityId === "") {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: opportunity_id is required.",
        },
      ],
      isError: true,
    };
  }

  try {
    const data = await apiGet(
      ctx,
      "/api/v1/explain-opportunity",
      { opportunity_id: opportunityId },
      ExplainOpportunitySchema,
    );
    // The backend always templates the narrative; fall back to a stat
    // line only if a future backend omits it.
    const text =
      data.narrative ??
      buildFallback(data.confidence, data.lift, data.support, data.sample_count);
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
 * Defensive client-side stat line if the backend ever omits the
 * narrative. Uses only the real stats, no invented values.
 */
function buildFallback(
  confidence: number | undefined,
  lift: number | undefined,
  support: number | undefined,
  sampleCount: number | undefined,
): string {
  const conf = confidence != null ? `${(confidence * 100).toFixed(0)}%` : "unknown";
  const liftStr = lift != null ? `${lift.toFixed(2)}x` : "unknown";
  const supp = support != null ? `${(support * 100).toFixed(0)}%` : "unknown";
  const n = sampleCount != null ? String(sampleCount) : "an unknown number of";
  return (
    `This pair co-occurs in ${n} orders at ${conf} confidence and ${liftStr} lift, ` +
    `appearing in ${supp} of all orders.`
  );
}
