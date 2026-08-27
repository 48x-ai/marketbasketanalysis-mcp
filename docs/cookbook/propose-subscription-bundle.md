# `propose_subscription_bundle`

> Agent role: **Replenishment Agent**.
> Source code: [`src/tools/proposeSubscriptionBundle.ts`](../../src/tools/proposeSubscriptionBundle.ts).
> Backing REST endpoints: composes `GET /api/v1/recommendations` per seed + `GET /api/v1/accounts/:customerId/reorder-predictions` (when `customer_id` is supplied).

## What it does

Given 1-5 seed products the customer has bought (typically from a first order), proposes a recurring subscription kit (3-6 items): the seeds plus complementary products, with a predicted cadence (median days between reorders), a 0..1 confidence score, and a rough monthly value when prices are known. When `customer_id` is supplied, the tool blends the customer's own per-SKU reorder cadence into the proposal; without one, it falls back to seed catalog cohesion alone.

## When to use it

Trigger this tool when the user (or another agent) asks one of:

- "What should they subscribe to?"
- "Build a monthly bundle from this order."
- "Propose a subscription bundle from these items."
- "Recommend a recurring kit for this customer."
- "What's the right subscription frequency for this customer?"

Use [`predict_reorder`](./predict-reorder.md) when the question is purely "when?", not "what kit?". Use [`get_bundle_for_cart`](./get-bundle-for-cart.md) for a one-off cart-completion, not a recurring kit.

## Parameters

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `seed_product_ids` | `string[]` | yes | | 1 to 5 products the customer has bought. |
| `customer_id` | `string` | no | | Numeric storefront id or GID. Anchors cadence + confidence to the customer's own history when supplied. |
| `cadence_days` | `integer` | no | | Target subscription frequency (e.g. `30` monthly, `14` biweekly). Snaps the predicted cadence toward this and weights candidates whose individual cadences are close. Clamped to `[7, 180]`. |
| `kit_size` | `integer` | no | `4` | Target total items (seeds + complements). Clamped to `[3, 6]`. |

## Example call

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "propose_subscription_bundle",
    "arguments": {
      "seed_product_ids": ["8472918765", "8472918766"],
      "customer_id": "7654321",
      "cadence_days": 30,
      "kit_size": 4
    }
  }
}
```

## Example response (typical)

```text
Subscription kit proposal: 4 items, predicted cadence 30d, confidence 71%.

**Kit**
  - [seed] Coffee Beans 1lb (cadence 28d, USD18.99)
  - [seed] Coffee Filters 100ct (cadence 32d, USD6.50)
  - [complement] Coffee Grinder Cleaner (cadence 30d, USD8.99)
  - [complement] Reusable Filter (cadence unknown, USD11.99)

Estimated monthly value: USD46.47

Rationale: 75% of kit items match this customer's reorder cadence; seeds co-occur strongly in carts.

Structured JSON:
{
  "proposal": {
    "items": [
      {
        "productId": "8472918765",
        "sku": "BEAN-1LB",
        "title": "Coffee Beans 1lb",
        "role": "seed",
        "cadenceDays": 28,
        "price": 18.99,
        "currency": "USD"
      }
    ],
    "cadence_days": 30,
    "confidence": 0.71,
    "monthly_value": 46.47,
    "currency": "USD",
    "rationale": "75% of kit items match this customer's reorder cadence; seeds co-occur strongly in carts."
  },
  "alternates": [
    {
      "productId": "9182734960",
      "sku": "MILK-OAT",
      "title": "Oat Milk 32oz",
      "cadenceDays": 14,
      "pairs": 1,
      "avg_confidence": 0.42
    }
  ],
  "signals": {
    "seed_cohesion": 0.46,
    "complement_coverage": 0.75,
    "history_hit_rate": 0.75,
    "customer_predictions_available": 8
  }
}
```

## Example response (edge case: no customer history)

When `customer_id` is omitted (or the customer has no qualifying reorder history), the tool falls back to catalog-only signal:

```text
Subscription kit proposal: 4 items, predicted cadence 30d, confidence 38%.

**Kit**
  - [seed] Coffee Beans 1lb (cadence unknown, USD18.99)
  - [seed] Coffee Filters 100ct (cadence unknown, USD6.50)
  - [complement] Coffee Grinder Cleaner (cadence unknown, USD8.99)
  - [complement] Reusable Filter (cadence unknown, USD11.99)

Estimated monthly value: USD46.47

Rationale: cadence derived from catalog defaults (no customer_id supplied); seeds co-occur strongly in carts.
```

`cadence_days: 30` is the default subscription-industry median used when no per-item cadence is known. Confidence is lower because the tool has no customer signal to anchor.

## Output fields

| Field | Notes |
|---|---|
| `proposal.cadence_days` | Median of per-item known cadences; falls back to `cadence_days` arg or 30 days. |
| `proposal.confidence` | Blend of seed cohesion (40-60% weight), complement coverage (30-40%), customer history hit rate (0% when no `customer_id`, 30% when supplied). |
| `proposal.monthly_value` | Sum of known item prices, scaled by `30 / cadence_days`. `null` when no item has a known price. |
| `alternates` | Up to 4 complement candidates that didn't make the kit, for swap UIs. |
| `signals` | Raw inputs the confidence is built from; useful for debugging "why this confidence?". |

## Error patterns

| Surface | Cause | Recovery |
|---|---|---|
| `Error: seed_product_ids must contain at least one product.` | Empty seeds. | Ask the user for first-order items. |
| `Error: seed_product_ids accepts at most 5 items.` | Too many seeds. | Trim to the most-representative items. |
| `Error: MBA_API_KEY environment variable not set.` | Server started without a key. | User edits MCP host config and restarts. |
| The customer reorder-prediction fetch is best-effort: 404 / empty / validation drift all collapse silently to "no customer signal". | Lets the tool work cross-platform even before Magento / WooCommerce ship the predictions endpoint. | None; the rationale string explicitly notes when customer history was missing. |

## Composition tips

- **First-order trigger.** Wire this to a post-order webhook: on first order, pass the line items as `seed_product_ids` and the new customer id as `customer_id`. The proposal goes into a "you might love a subscription" follow-up email.
- **Cadence honesty.** If `customer_predictions_available` is 0 in the response, the predicted cadence is a catalog guess, not a customer-specific one. Surface that nuance to the merchant ("we don't have enough history yet, here's our best guess").
- **Combine with return risk.** Run [`score_return_risk`](./score-return-risk.md) on the proposed kit, a recurring high-return kit is a churn machine.
- **Swap via alternates.** When the shopper rejects an item, look up `alternates` in the structured JSON and offer the top one as a swap, no second tool call needed.
- **Manual cadence override.** If the merchant has a target cadence (e.g. "we want all subscriptions to be monthly"), pass `cadence_days: 30` and let the tool re-rank candidates whose individual cadences are close to 30.
