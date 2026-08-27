# `predict_reorder`

> Agent role: **Replenishment Agent** (B2B).
> Source code: [`src/tools/predictReorder.ts`](../../src/tools/predictReorder.ts).
> Backing REST endpoint: `GET /api/v1/accounts/:customerId/reorder-predictions`.
> **Platform gate.** Shopify only in v0.3 (Magento + WooCommerce coming). When `MBA_PLATFORM` is set to anything else, the tool short-circuits with a clear message instead of letting upstream 404s leak through.

## What it does

For a B2B account, predicts which SKUs are due for reorder, when, and with what confidence. Mean inter-order interval per SKU drives the prediction; output is bucketed into `overdue`, `due_soon`, `on_track`, `not_predictable` so an agent can take a different action on each. Headline use case: a sales rep agent asks "what's Acme Corp due to reorder this week?" before a check-in call.

## When to use it

Trigger this tool when the user (or another agent) asks one of:

- "What's Acme Corp due to reorder?"
- "When will customer X need more of Y?"
- "Show me overdue reorders for this account."
- "Who's due for a check-in call this week?" (the agent loops this over a customer list).

## Parameters

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `customer_id` | `string` | yes | | Shopify customer id (numeric storefront id like `"7654321"` or full GID `"gid://shopify/Customer/7654321"`). |
| `product_id` | `string` | no | | Filter to a single product. Useful for "when will customer X reorder product Y?". |

## Example call

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "predict_reorder",
    "arguments": {
      "customer_id": "7654321"
    }
  }
}
```

## Example response (typical)

```text
Reorder predictions for customer 7654321 (38 orders scanned):

**Overdue (2)**
  - Cleaning Solvent 1L (SKU: SOLV-1L), 4d overdue (mean cadence 28d, confidence 82%, 11 prior orders)
  - Microfiber Cloths 50pk (SKU: CLOTH-50), 1d overdue (mean cadence 35d, confidence 71%, 8 prior orders)

**Due soon (1)**
  - Lens Wipes Box (SKU: WIPES-100), due in 3d (mean cadence 21d, confidence 88%, 14 prior orders)

**On track (3)**
  - Tripod Replacement Plate (SKU: PLATE-A), due in 18d (mean cadence 60d, confidence 64%, 5 prior orders)
  - SD Card 64GB (SKU: SD-064), due in 22d (mean cadence 45d, confidence 59%, 6 prior orders)
  - Battery Pack 7.4V (SKU: BAT-074), due in 31d (mean cadence 50d, confidence 51%, 4 prior orders)

Structured JSON:
{
  "customerId": "7654321",
  "totalOrders": 41,
  "windowOrders": 38,
  "predictions": [
    {
      "productId": "9182739001",
      "sku": "SOLV-1L",
      "title": "Cleaning Solvent 1L",
      "totalOrders": 11,
      "lastOrderedAt": "2026-05-04T14:22:00Z",
      "meanIntervalDays": 28,
      "stdevDays": 4.2,
      "predictedNextAt": "2026-05-28T14:22:00Z",
      "daysUntilPredicted": -4,
      "confidence": 0.82,
      "status": "overdue"
    }
  ]
}
```

## Example response (edge case: insufficient history)

When the customer has fewer than 2 orders for any SKU, or every cadence is too irregular (coefficient of variation > 1) to predict:

```text
No reorder predictions available for customer 7654321. This usually means the customer has fewer than 2 orders for the same SKU, or their order cadence is too irregular to predict (CV > 1).
```

Returned as a normal (non-error) reply.

## Status buckets

| Status | Meaning | Suggested agent action |
|---|---|---|
| `overdue` | `daysUntilPredicted < 0` | Reach out, flag, or trigger an outbound order draft. |
| `due_soon` | within `0.5 * meanIntervalDays` of due | Add to upcoming-quote draft. |
| `on_track` | within `1.5 * meanIntervalDays` of due | Hold for the next replenishment cycle. |
| `not_predictable` | high cadence variance | Surface to a human, the cadence is too noisy. |

## Error patterns

| Surface | Cause | Recovery |
|---|---|---|
| `Error: B2B reorder predictions are Shopify-only in v0.3.` | `MBA_PLATFORM` set to something other than `shopify` (or unset). | Wait for Magento / WooCommerce ports, or call the Shopify-only install. |
| `Error: customer_id is required.` | Empty `customer_id`. | Ask the user for the customer id. |
| `Error: MBA API 404` | Customer doesn't exist on this merchant, or the endpoint isn't enabled for this account. | Verify the customer id and the merchant's plan. |
| `Error: MBA_API_KEY environment variable not set.` | Server started without a key. | User edits MCP host config and restarts. |

## Composition tips

- **Sales-rep pre-call brief.** Run `predict_reorder` per account on the rep's call list each morning; pipe `overdue` and `due_soon` into the daily prep doc.
- **Subscription pivot.** If a customer has 5+ on-track SKUs at similar cadences, [`propose_subscription_bundle`](./propose-subscription-bundle.md) can convert them into a recurring kit instead of one-off orders.
- **Single-SKU question.** When the rep asks "when will Acme reorder solvent specifically?", pass `product_id` to filter the response down to that SKU, the JSON shape is identical, just shorter.
