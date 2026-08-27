# `score_return_risk`

> Agent role: **Insight Agent**.
> Source code: [`src/tools/scoreReturnRisk.ts`](../../src/tools/scoreReturnRisk.ts).
> Backing REST endpoint: composes `GET /api/v1/recommendations` per bundle item. Return-aware mining embeds `returnRate` + `returnedCount` on each *consequent* (the recommended product) of a rule, so a given product's own return rate is observable only when that product itself appears as a consequent in another bundle item's rule list. There is currently no dedicated per-product return-rate endpoint.

## What it does

For a candidate bundle of 2-6 products, predicts the probability the bundle gets returned based on each item's **own** historical return rate. Composite score is `max(item.returnRate)` since a single returned item in a bundle almost always means the whole bundle is returned (shipping label asymmetry, no partial-return on "buy this set" promos). Output includes the composite, per-item rates, and a `low | medium | high | unknown` recommendation.

**How a per-item rate is sourced.** Because the only return-aware datum the backend exposes is the `returnRate` on each *consequent*, this tool fetches every bundle item's recommendations, then reads each item's rate from the rule whose consequent is that item (typically surfaced in a sibling item's recommendation list). Every per-item record describes one product only: its `product_id`, `sku`, `title`, `return_rate`, and `returned_count` all belong to the same item. An item that never surfaces as a mined consequent reports `return_rate: null` (see "data not available" below) rather than borrowing a neighbor's rate.

## When to use it

Trigger this tool when the user (or another agent) asks one of:

- "Will this bundle get returned?"
- "Predict return risk for these items."
- "Fashion bundle risk on this set."
- "Is this set risky to ship together?"
- "Audit this proposed bundle for returns before I publish."

Use [`analyze_basket`](./analyze-basket.md) when the question is about cohesion ("do these go together?"), not returns. Pair both for the full picture.

## Parameters

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `product_ids` | `string[]` | yes | | 2 to 6 distinct ids. Numeric, GID, or SKU. |
| `threshold` | `number` | no | `0.15` | "High risk" cutoff used in the recommendation text. Items above this are listed as offenders in the medium / high message. The low / medium / high classification itself uses fixed bands (see below). |

## Example call

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "score_return_risk",
    "arguments": {
      "product_ids": ["8472918765", "8472918766", "8472918767"],
      "threshold": 0.15
    }
  }
}
```

## Example response (typical: high-risk bundle)

```text
Return risk for bundle of 3 products: HIGH.

Per-item return rates:
  - Wool Sweater (id: 8472918765): 32.0% (high)
  - Slim Jeans 32x32 (id: 8472918766): 14.0% (medium)
  - Knit Beanie (id: 8472918767): 6.0% (low)

High return risk (composite 32.0%, threshold 15%). Do not ship this bundle without a return-reducing intervention: swap the high-return item, add a fit-check step, or convert the promo from 'bundle' to 'separate items so partial returns are allowed'. High-return items in this bundle: Wool Sweater (32.0%), Slim Jeans 32x32 (14.0%).

Structured JSON:
{
  "product_ids": ["8472918765", "8472918766", "8472918767"],
  "composite_return_rate": 0.32,
  "risk_level": "high",
  "threshold": 0.15,
  "items": [
    {
      "product_id": "8472918765",
      "sku": "SWTR-WOOL",
      "title": "Wool Sweater",
      "return_rate": 0.32,
      "returned_count": 88,
      "risk_level": "high"
    }
  ],
  "recommendation": "High return risk (composite 32.0%, threshold 15%). Do not ship this bundle..."
}
```

## Example response (edge case: data not available)

When none of the bundle items have return-rate data populated (older mining job, or a brand-new catalog without enough refund history):

```text
Return risk for bundle of 3 products: UNKNOWN.

Per-item return rates:
  - Camera Body (id: 8472918765): data not available
  - 32GB SD Card (id: 8472918766): data not available
  - Camera Strap (id: 8472918767): data not available

Return-rate data not available for this bundle. Ask the merchant to run a fresh mining job so return-aware rules are emitted, then retry. Until then, treat the bundle as 'unknown risk' rather than 'low risk'.

Structured JSON:
{
  "product_ids": ["8472918765", "8472918766", "8472918767"],
  "composite_return_rate": null,
  "risk_level": "unknown",
  "threshold": 0.15,
  "items": [
    { "product_id": "8472918765", "sku": null, "title": null, "return_rate": null, "returned_count": null, "risk_level": "unknown" }
  ]
}
```

Returned as a normal (non-error) reply. Agents should NOT treat `unknown` as `low`, the right action is to ask the merchant to run a fresh mining job.

## Risk bands

| Composite return rate | Risk level |
|---|---|
| `< 0.10` | `low` |
| `0.10 to 0.25` | `medium` |
| `> 0.25` | `high` |
| `null` | `unknown` |

`threshold` only changes the recommendation text (which items get called out as offenders); the band classification itself is fixed.

## Error patterns

| Surface | Cause | Recovery |
|---|---|---|
| `Error: product_ids must contain at least 2 distinct product ids.` | Empty, single-item, or all-duplicate list. | Ask for at least 2 distinct ids. |
| `Error: product_ids must contain at most 6 product ids.` | More than 6 ids. | Drop low-priority items, retry. |
| `Error: product_ids must contain only string ids.` | Array contains non-string values. | Coerce to strings before calling. |
| `Error: MBA_API_KEY environment variable not set.` | Server started without a key. | User edits MCP host config and restarts. |
| Per-item upstream errors are silently swallowed and that item is surfaced as `null`. | One missing SKU shouldn't kill the whole assessment. | None; the composite is computed from the items with known rates. |

## Composition tips

- **Discovery -> Insight gate.** Standard pattern: call [`get_recommendations`](./get-recommendations.md), then run `score_return_risk` on the top picks. Drop any with `risk_level: "high"` before surfacing to the shopper.
- **Bundle vetting two-step.** Call [`analyze_basket`](./analyze-basket.md) first for cohesion, then `score_return_risk` for return risk. A bundle is publish-worthy when cohesion is moderate-or-better AND return risk is low-or-medium.
- **Subscription audit.** Pass the proposed subscription items from [`propose_subscription_bundle`](./propose-subscription-bundle.md) through this tool; high-return items in a subscription compound the cancellation problem.
- **Fashion-specific.** Apparel categories have inherently higher return rates than electronics. Consider raising `threshold` to 0.25 for fashion stores, the low / medium / high classification doesn't move, but the offenders list becomes less noisy.
- **Procurement / B2B framing.** A returned B2B bundle costs reverse logistics + a damaged customer relationship. Reps using this tool on a proposed B2B order can surface the risk to the buyer proactively ("we recommend separating these two items because...").
