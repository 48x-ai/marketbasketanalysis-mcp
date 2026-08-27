# `find_substitutes`

> Agent role: **Discovery Agent**.
> Source code: [`src/tools/findSubstitutes.ts`](../../src/tools/findSubstitutes.ts).
> Backing REST endpoint: `GET /api/v1/substitutions`.

## What it does

For a single product, returns the top items that could **replace** it (not complement it). Substitutes are the inverse of cross-sells: this tool answers "what should I buy instead?" not "what should I buy with?". Each result carries a `score` (0..1) representing similarity to the original, plus a `reason` (`context_similar`, `category_match`, or `vendor_match`) explaining why the candidate was picked.

## When to use it

Trigger this tool when the user (or another agent) asks one of:

- "What's a substitute for product X?"
- "X is out of stock, what else?"
- "Alternative to the gym backpack?"
- "Replacement for SKU CLN-001?"
- "Find a similar product in the same vendor."

Use [`get_recommendations`](./get-recommendations.md) when the intent is to complement (buy with), not substitute (buy instead of).

## Parameters

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `product_id` | `string` | yes | | Numeric storefront id or GID / SKU. The id of the product the user wants to **replace**. |
| `limit` | `integer` | no | `3` | Max substitutes to return. Clamped to `[1, 6]`. |

## Example call

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "find_substitutes",
    "arguments": {
      "product_id": "8472918765",
      "limit": 3
    }
  }
}
```

## Example response (typical)

```text
Top 3 substitutes for 8472918765 (ranked by similarity to original):

1. Hiking Daypack 25L (SKU: BAG-225, match: 78%, reason: similar basket context)
2. Travel Backpack 30L (SKU: BAG-430, match: 64%, reason: same category)
3. Outdoor Co. Tactical Pack (SKU: BAG-552, match: 41%, reason: same vendor)

Structured JSON:
{
  "substitutions": [
    {
      "productId": "9182734851",
      "sku": "BAG-225",
      "title": "Hiking Daypack 25L",
      "vendor": "PackCo",
      "productType": "Backpack",
      "score": 0.78,
      "reason": "context_similar",
      "signals": {
        "contextOverlap": 0.78,
        "coOccurrence": 0.42,
        "sameProductType": true,
        "sameVendor": false
      }
    }
  ]
}
```

## Example response (edge case: no substitutes)

When the product is the only of its kind (typical for niche stores) or the mining job hasn't shipped substitute rules for it:

```text
No substitutes found for product 8472918765. This usually means either
(a) the product isn't in the most-recent mining job's catalog,
(b) the catalog has no items with similar basket context (typical for the only-of-its-kind product in a niche store), or
(c) the merchant hasn't run a mining job yet.
```

Returned as a normal (non-error) reply.

## Error patterns

| Surface | Cause | Recovery |
|---|---|---|
| `Error: product_id is required.` | Missing or blank `product_id`. | Ask the user for the product id. |
| `Error: MBA_API_KEY environment variable not set.` | Server started without a key. | User edits MCP host config and restarts. |
| `Error: MBA API 401` | Key revoked or wrong environment. | User rotates key in admin. |
| `Error: MBA API 404` | Substitution endpoint not yet available for this merchant's platform / catalog. | Try `get_recommendations` instead; for that endpoint we cover Shopify, Magento, and WooCommerce. |

## Composition tips

- **Out-of-stock chain.** When a fulfillment agent learns an item is out of stock, call this tool to find a swap, then call [`score_cross_sell`](./score-cross-sell.md) on `(substitute, other_cart_item)` to verify the substitute still pairs with the rest of the cart.
- **Empty `get_recommendations`.** If [`get_recommendations`](./get-recommendations.md) returned no rows, this is the natural follow-up: maybe the user actually meant "find me something like this", not "find me something to go with this".
- **Reason filter.** Agents can post-filter the structured JSON by `reason` to favor `context_similar` (basket-driven) over `category_match` (catalog-driven). Context-similar substitutes tend to be the ones real customers actually pivot to.
