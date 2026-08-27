# `score_cross_sell`

> Agent role: **Insight Agent**.
> Source code: [`src/tools/scoreCrossSell.ts`](../../src/tools/scoreCrossSell.ts).
> Backing REST endpoint: composes `GET /api/v1/recommendations` for `product_a`.

## What it does

Scores the cross-sell strength between two specific products. Returns the confidence the merchant's real co-purchase data supports for the pair, plus a `strong | moderate | weak` verdict (or a clear `no_signal` result when there's no qualifying rule). Internally calls `GET /api/v1/recommendations?product_id=A&limit=6` and checks whether `product_b` appears in the result, the confidence value is the answer.

## When to use it

Trigger this tool when the user (or another agent) asks one of:

- "Is X a good cross-sell for Y?"
- "How often are these two products bought together?"
- "Validate this proposed pair before I recommend it."
- "Should I bundle X with Y?"

Use [`get_recommendations`](./get-recommendations.md) when the user hasn't picked a target yet ("what goes with X?"). Use [`analyze_basket`](./analyze-basket.md) when there are more than two products.

## Parameters

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `product_a` | `string` | yes | | The antecedent product (the one the customer already has). |
| `product_b` | `string` | yes | | The consequent product (the one being evaluated as a cross-sell). |

## Example call

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "score_cross_sell",
    "arguments": {
      "product_a": "8472918765",
      "product_b": "9182734651"
    }
  }
}
```

## Example response (typical: strong pair)

```text
Cross-sell strength for 8472918765 -> 9182734651: **strong** (confidence: 64%).

Structured JSON:
{
  "product_a": "8472918765",
  "product_b": "9182734651",
  "has_signal": true,
  "confidence": 0.64,
  "strength": "strong",
  "product_b_title": "Camera Cleaning Kit",
  "product_b_sku": "CLN-001"
}
```

## Example response (edge case: no qualifying rule)

```text
No qualifying co-purchase rule found between product 8472918765 and product 8472918999. This means either (a) the pair never co-occurs in the merchant's order history, (b) the co-occurrence is too sparse to clear support/confidence thresholds, or (c) the merchant hasn't run a mining job yet. Treat this as 'no statistical signal for the pair', not 'the pair is bad.'

Structured JSON:
{
  "product_a": "8472918765",
  "product_b": "8472918999",
  "has_signal": false
}
```

The `has_signal: false` reply is a normal (non-error) result. Agents should NOT interpret it as "the pair is a bad idea", only as "we have no data to support it".

## Strength bands

| Confidence | Verdict |
|---|---|
| >= 0.6 | `strong` |
| 0.3 to 0.6 | `moderate` |
| < 0.3 | `weak` |

Treat these as informational, not contractual; future versions may rebalance.

## Error patterns

| Surface | Cause | Recovery |
|---|---|---|
| `Error: product_a and product_b are both required.` | One or both empty. | Ask the user for both ids. |
| `Error: product_a and product_b must be different products.` | Same id passed twice. | Ask the user for two distinct products. |
| `Error: MBA_API_KEY environment variable not set.` | Server started without a key. | User edits MCP host config and restarts. |

## Composition tips

- **Validate before suggesting.** A frequent pattern: agent generates a recommendation, calls `score_cross_sell` to verify, only ships it if `has_signal: true` and `strength != "weak"`.
- **Backstop empty top-k.** If [`get_recommendations`](./get-recommendations.md) for `product_a` was empty but the agent has a hand-picked `product_b` in mind, this tool gives a direct answer without changing the question.
- **N-pair vetting on a small basket.** For 2-3 products, hand-roll a loop calling `score_cross_sell` on every pair. For 4+, use [`analyze_basket`](./analyze-basket.md), it's the same math but parallelized server-side.
- **B2B negotiation.** Sales reps using `score_cross_sell` in real time can answer "yes this pair is supported by real data" instead of "I think it's a good idea", which lands very differently with B2B buyers.
