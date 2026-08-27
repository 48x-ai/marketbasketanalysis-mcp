/**
 * predict_reorder, for a B2B account, predict which SKUs are due
 * for reorder, when, and with what confidence.
 *
 * Mean inter-order interval per SKU. Returns overdue / due_soon /
 * on_track / not_predictable buckets so an agent can take a
 * different action on each.
 *
 * Headline use case: a sales rep agent asks "what's Acme Corp due
 * to reorder this week?" before a check-in call.
 */

import { ApiError, activeContext, missingKeyReply } from "../lib/api.js";
import { getReorderPredictions } from "../lib/accounts.js";

// Platform gate. Reorder predictions ship on the Shopify, BigCommerce,
// WooCommerce, and Magento backends. All four return the same response
// shape but mount the endpoint at different URLs, so the path is
// resolved per platform in lib/accounts.ts (reorderPredictionsPath).
// OroCommerce does not implement it, so there the tool short-circuits
// with a clear message instead of letting an upstream 404 leak through.
// Empty / unset MBA_PLATFORM keeps the tool callable for backward
// compatibility with installs that pre-date the env var, and resolves
// to the hosted-plane path.
const platform = (process.env.MBA_PLATFORM ?? "").trim().toLowerCase();
const REORDER_PLATFORMS = new Set(["shopify", "bigcommerce", "woocommerce", "magento"]);
const platformUnsupported = platform !== "" && !REORDER_PLATFORMS.has(platform);

export const definition = {
  name: "predict_reorder",
  description:
    "For a sales-rep or inventory / account-management agent: predict when a B2B customer / account is due to reorder. Returns predicted next-order dates for every SKU the customer has ordered >=2 times, with confidence based on the regularity of their cadence (reorder prediction / replenishment forecasting). Bucketed into 'overdue' / 'due_soon' / 'on_track' / 'not_predictable'. Use this when the agent asks 'what's Acme Corp due to reorder?', 'when will customer X need more of Y?', 'show me stockout risks for my B2B accounts', or for proactive replenishment workflows. Works on the Shopify, BigCommerce, WooCommerce, and Magento backends. Not available on OroCommerce.",
  inputSchema: {
    type: "object" as const,
    properties: {
      customer_id: {
        type: "string",
        description:
          "The customer id on the store's own platform. Shopify accepts either the numeric storefront id (e.g. '7654321') or the full GID (gid://shopify/Customer/7654321). BigCommerce, WooCommerce, and Magento take their numeric customer id.",
      },
      product_id: {
        type: "string",
        description:
          "Optional: filter to a single product. Useful for 'when will customer X reorder product Y?'.",
      },
    },
    required: ["customer_id"],
  },
};

export async function handler(args: Record<string, unknown>) {
  if (platformUnsupported) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "Error: B2B reorder predictions are available on the Shopify, BigCommerce, WooCommerce, and Magento backends. " +
            `MBA_PLATFORM is set to "${platform}"; this tool is gated to MBA_PLATFORM unset, shopify, bigcommerce, woocommerce, or magento.`,
        },
      ],
      isError: true,
    };
  }
  const ctx = activeContext();
  if (!ctx) return missingKeyReply();

  const customerId = String(args.customer_id ?? "").trim();
  if (customerId === "") {
    return {
      content: [{ type: "text" as const, text: "Error: customer_id is required." }],
      isError: true,
    };
  }
  const productFilter = String(args.product_id ?? "").trim() || undefined;

  try {
    const result = await getReorderPredictions(ctx, customerId, productFilter);
    if (result.predictions.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No reorder predictions available for customer ${customerId}. ` +
              "This usually means the customer has fewer than 2 orders for the same SKU, " +
              "or their order cadence is too irregular to predict (CV > 1).",
          },
        ],
      };
    }

    // Group by status for human-readable output. Most agents need
    // overdue + due_soon first.
    const groups = new Map<string, typeof result.predictions>();
    for (const p of result.predictions) {
      const list = groups.get(p.status) ?? [];
      list.push(p);
      groups.set(p.status, list);
    }

    const sections: string[] = [];
    for (const status of ["overdue", "due_soon", "on_track", "not_predictable"] as const) {
      const items = groups.get(status) ?? [];
      if (items.length === 0) continue;
      sections.push(`**${formatStatus(status)} (${items.length})**`);
      for (const p of items) {
        const due =
          p.daysUntilPredicted < 0
            ? `${Math.abs(p.daysUntilPredicted)}d overdue`
            : p.daysUntilPredicted === 0
              ? "due today"
              : `due in ${p.daysUntilPredicted}d`;
        sections.push(
          `  - ${p.title ?? p.sku ?? p.productId}, ${due} (mean cadence ${p.meanIntervalDays}d, confidence ${(p.confidence * 100).toFixed(0)}%, ${p.totalOrders} prior orders)`,
        );
      }
      sections.push("");
    }

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Reorder predictions for customer ${customerId} (${result.windowOrders} orders scanned):\n\n` +
            sections.join("\n") +
            "\nStructured JSON:\n```json\n" +
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

function formatStatus(status: string): string {
  return {
    overdue: "Overdue",
    due_soon: "Due soon",
    on_track: "On track",
    not_predictable: "Irregular (not predictable)",
  }[status] ?? status;
}
