# `analyze_basket`

> Agent role: **Insight Agent**.
> Source code: [`src/tools/analyzeBasket.ts`](../../src/tools/analyzeBasket.ts).
> Backing REST endpoint: composes `GET /api/v1/recommendations` per basket item.

## What it does

For an arbitrary set of 2-6 products, returns the basket's overall cohesion: how strongly the products bind together in the merchant's actual order history. Cohesion is `coverage * mean_confidence`, where coverage is the fraction of ordered pairs that have a qualifying rule and mean_confidence is the average confidence of matched pairs. Output is a 0..1 score with a `strong | moderate | weak` verdict and the per-pair breakdown.

## When to use it

Trigger this tool when the user (or another agent) asks one of:

- "Is this a good bundle?"
- "Do these products go together?"
- "I'm thinking of bundling X, Y, Z, vet this for me."
- "Audit this proposed kit before I publish it."

Use [`score_cross_sell`](./score-cross-sell.md) when there are only two products. Use [`score_return_risk`](./score-return-risk.md) when the question is about returns specifically rather than cohesion.

## Parameters

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `product_ids` | `string[]` | yes | | 2 to 6 product ids. Numeric, GID, or SKU. |

## Example call

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "analyze_basket",
    "arguments": {
      "product_ids": ["8472918765", "8472918766", "8472918767", "8472918768"]
    }
  }
}
```

## Example response (typical: strong cohesion)

```text
Basket cohesion: **0.456** (46%), strong cohesion, this is a good bundle candidate.

Pairs matched: 10 / 12 (83% coverage).
Average confidence of matched pairs: 55%.

Structured JSON:
{
  "basket": ["8472918765", "8472918766", "8472918767", "8472918768"],
  "cohesion": 0.456,
  "coverage": 0.833,
  "avg_confidence": 0.55,
  "matched_pairs": 10,
  "total_pairs": 12,
  "pair_scores": [
    { "from": "8472918765", "to": "8472918766", "confidence": 0.64 },
    { "from": "8472918765", "to": "8472918767", "confidence": 0.51 }
  ],
  "verdict": "strong cohesion, this is a good bundle candidate"
}
```

## Example response (edge case: no signal)

When most pairs have no qualifying rule, cohesion is near zero:

```text
Basket cohesion: **0.025** (3%), weak / no cohesion, the basket lacks co-purchase signal.

Pairs matched: 1 / 12 (8% coverage).
Average confidence of matched pairs: 30%.

Structured JSON:
{
  "basket": ["8472918765", "8472918999", "8472919001", "8472919002"],
  "cohesion": 0.025,
  "coverage": 0.083,
  "avg_confidence": 0.30,
  "matched_pairs": 1,
  "total_pairs": 12,
  "verdict": "weak / no cohesion, the basket lacks co-purchase signal"
}
```

Returned as a normal (non-error) reply. Treat low cohesion as "this kit is speculative", not "this kit is bad", and consider showing the user that nuance explicitly.

## Verdict bands

| Cohesion | Verdict |
|---|---|
| >= 0.4 | `strong` |
| 0.15 to 0.4 | `moderate` |
| < 0.15 | `weak` |

Informational; future mining-job changes may move these thresholds.

## Error patterns

| Surface | Cause | Recovery |
|---|---|---|
| `Error: basket must contain at least 2 products.` | Fewer than 2 ids supplied. | Ask the user for more products. |
| `Error: basket size capped at 6 products.` | More than 6 ids supplied. | Drop the least-confident items, then retry. |
| `Error: MBA_API_KEY environment variable not set.` | Server started without a key. | User edits MCP host config and restarts. |
| Per-item upstream errors are silently swallowed. | One stale SKU shouldn't kill a whole-basket vet. | None; coverage will be lower but the score is still useful. |

## Composition tips

- **Vet then ship.** Standard flow: agent assembles a bundle (manually or via `get_bundle_for_cart`), runs `analyze_basket` for a cohesion verdict, only ships bundles >= 0.15.
- **Vet then improve.** If the result is weak or moderate, call [`get_bundle_for_cart`](./get-bundle-for-cart.md) with the same products as input, this swaps the weakest item for a stronger one.
- **Returns layer.** Pair with [`score_return_risk`](./score-return-risk.md): a bundle can be cohesive (people buy these together) AND high-return-risk (one item is consistently returned). Both matter; cohesion alone misses the second.
