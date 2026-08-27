# `get_bundle_for_cart`

> Agent role: **Bundle Agent**.
> Source code: [`src/tools/getBundleForCart.ts`](../../src/tools/getBundleForCart.ts).
> Backing REST endpoint: composes `GET /api/v1/recommendations` per cart item.

## What it does

Given the products already in a shopper's cart, suggests what's still missing to complete a high-confidence kit. Internally fans out to `GET /api/v1/recommendations` for each cart item, then re-ranks candidates by how many cart items they pair with multiplied by average confidence. Products already in the cart are filtered out of suggestions. This is the multi-item complement of [`get_recommendations`](./get-recommendations.md).

## When to use it

Trigger this tool when the user (or another agent) asks one of:

- "I have a camera body, 32GB SD card, and a tripod in my cart. What's likely missing to make this a complete kit?"
- "What else do I need?"
- "What completes this set?"
- "What's missing from this kit?"

Use [`get_recommendations`](./get-recommendations.md) for a single-product question when you only have one product rather than a multi-item cart.

## Parameters

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `product_ids` | `string[]` | yes | | List of products currently in the cart. Each id is numeric or GID / SKU. 1 to 20 items. |
| `limit` | `integer` | no | `3` | Max suggestions to return. Clamped to `[1, 6]`. |

## Example call

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_bundle_for_cart",
    "arguments": {
      "product_ids": ["8472918765", "8472918766", "8472918767"],
      "limit": 3
    }
  }
}
```

## Example response (typical)

```text
Top 3 kit-completion suggestions for cart of 3 items:

1. Camera Cleaning Kit (SKU: CLN-001, pairs with 3/3 cart items, avg confidence: 58%)
2. Lens Filter Kit (SKU: FLT-006, pairs with 2/3 cart items, avg confidence: 47%)
3. Camera Strap (SKU: STR-002, pairs with 2/3 cart items, avg confidence: 35%)

Structured JSON:
{
  "suggestions": [
    {
      "productId": "9182734651",
      "sku": "CLN-001",
      "title": "Camera Cleaning Kit",
      "pairs_with": 3,
      "avg_confidence": 0.58
    },
    {
      "productId": "9182734660",
      "sku": "FLT-006",
      "title": "Lens Filter Kit",
      "pairs_with": 2,
      "avg_confidence": 0.47
    },
    {
      "productId": "9182734653",
      "sku": "STR-002",
      "title": "Camera Strap",
      "pairs_with": 2,
      "avg_confidence": 0.35
    }
  ],
  "cart": ["8472918765", "8472918766", "8472918767"]
}
```

## Example response (edge case: no signal)

When the cart items don't have qualifying co-purchase rules:

```text
No kit-completion suggestions for the cart [8472918765, 8472918766, 8472918767]. This usually means the cart items don't have qualifying co-purchase rules yet, or the merchant's mining job hasn't run.
```

Returned as a normal (non-error) reply.

## Error patterns

| Surface | Cause | Recovery |
|---|---|---|
| `Error: product_ids must contain at least one product.` | Empty or all-blank `product_ids`. | Ask the user for at least one item. |
| `Error: MBA_API_KEY environment variable not set.` | Server started without a key. | User edits MCP host config and restarts. |
| Per-item upstream errors are silently swallowed and that item is dropped from aggregation. | Helps when one SKU is brand-new and not in the catalog yet. | None needed; the agent sees whatever signal was available from the rest of the cart. |

## Composition tips

- **Validate before recommending.** Pipe the suggestions into [`analyze_basket`](./analyze-basket.md) treating `cart + top_suggestion` as the candidate basket. If cohesion drops, that's a sign the suggestion is plausible but weak.
- **Pre-filter for returns.** Pass the top suggestions through [`score_return_risk`](./score-return-risk.md) before showing them to the shopper. A 70%-confidence pair that gets returned 30% of the time isn't a win.
- **Subscription pivot.** If the cart looks like a starter pack for a recurring category (groceries, supplements, pet food), follow up with [`propose_subscription_bundle`](./propose-subscription-bundle.md) using the same cart as seeds.
