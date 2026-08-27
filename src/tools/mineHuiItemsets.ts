/**
 * mine_hui_itemsets, run high-utility itemset mining on a payload of
 * orders + per-line unit_profit. Wraps POST /api/v1/hosted/hui-mine.
 *
 * The hosted endpoint runs the canonical HUI algorithm on the
 * payload and returns the top-K itemsets ranked by aggregate utility
 * (sum of profit across all occurrences of the itemset). Thin-client
 * platforms (Oro, MCP-driven agents) use this so they don't have to
 * port the algorithm themselves.
 *
 * Tier-gated on the backend (Pro / Enterprise only); merchants on
 * starter get a 402. Async path for payloads > 100k orders: caller
 * polls jobId via a future MCP tool when that ships.
 */

import {
  ApiError,
  activeContext,
  apiPost,
  coerceLimit,
  missingKeyReply,
} from "../lib/api.js";
import { z } from "zod";

const HuiItemsetSchema = z.object({
  items: z.array(z.string()),
  utility: z.number(),
  occurrence_count: z.number().optional(),
});

const HuiResponseSchema = z.object({
  jobId: z.string().optional(),
  itemsets: z.array(HuiItemsetSchema).optional(),
  status: z.string().optional(),
});

export const definition = {
  name: "mine_hui_itemsets",
  description:
    "Run high-utility itemset (HUI) mining on a caller-supplied payload of orders + per-line unit_profit. Returns top-K itemsets ranked by aggregate utility (sum of profit across all occurrences). Use this when an agent needs to evaluate which item combinations drive the most profit (not just frequency) for a specific time window or product subset. Plus or Enterprise tier required on the merchant account.",
  inputSchema: {
    type: "object" as const,
    properties: {
      orders: {
        type: "array",
        description:
          "Order payload: each order has order_id + items[]. Each item has sku, quantity, unit_profit.",
        items: {
          type: "object",
          properties: {
            order_id: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sku: { type: "string" },
                  quantity: { type: "number" },
                  unit_profit: { type: "number" },
                },
                required: ["sku", "quantity", "unit_profit"],
              },
            },
          },
          required: ["order_id", "items"],
        },
      },
      top_k: {
        type: "integer",
        description: "How many top-utility itemsets to return. Default 20, max 100.",
        default: 20,
        minimum: 1,
        maximum: 100,
      },
      min_utility: {
        type: "number",
        description: "Minimum utility threshold; itemsets below this are dropped.",
      },
    },
    required: ["orders"],
  },
};

export async function handler(args: Record<string, unknown>) {
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const orders = args.orders;
  if (!Array.isArray(orders) || orders.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: orders must be a non-empty array of { order_id, items[] }.",
        },
      ],
      isError: true,
    };
  }
  const topK = coerceLimit(args.top_k, 20, 100);
  const body: Record<string, unknown> = { orders, top_k: topK };
  if (typeof args.min_utility === "number") body.min_utility = args.min_utility;

  try {
    const data = await apiPost(
      ctx,
      "/api/v1/hosted/hui-mine",
      body,
      HuiResponseSchema,
    );
    if (data.jobId && !data.itemsets) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `HUI mining accepted as async job (jobId: ${data.jobId}). ` +
              "Poll the backend or call again later for results; this happens for payloads with more than 100k orders.",
          },
        ],
      };
    }
    const itemsets = data.itemsets ?? [];
    const lines = itemsets.map(
      (s, i) =>
        `${i + 1}. [${s.items.join(", ")}] utility=${s.utility.toFixed(2)}` +
        (s.occurrence_count != null ? ` (n=${s.occurrence_count})` : ""),
    );
    return {
      content: [
        {
          type: "text" as const,
          text:
            (itemsets.length === 0
              ? "No itemsets cleared the utility threshold."
              : `Top ${itemsets.length} high-utility itemsets:\n\n` + lines.join("\n")) +
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
