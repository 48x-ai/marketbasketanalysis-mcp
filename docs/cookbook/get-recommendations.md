# `get_recommendations`

> Agent role: **Discovery Agent**.
> Source code: [`src/tools/getRecommendations.ts`](../../src/tools/getRecommendations.ts).
> Backing REST endpoint: `GET /api/v1/recommendations`.

## What it does

For a single product, returns the top complementary products customers also bought, derived from association rules mined from the merchant's own order history. Each recommendation carries a `confidence` score (0..1) representing the probability a basket containing the input also contains the recommended item. Works for Shopify, Magento, and WooCommerce merchants.

## When to use it

Trigger this tool when the user (or another agent) asks one of:

- "What goes with the gym backpack?"
- "What should I bundle with product 8472918765?"
- "What do customers also buy with the DSLR body?"
- "Show me the top complementary products for this SKU."

Use [`get_bundle_for_cart`](./get-bundle-for-cart.md) instead when the user already has more than one product in mind, this tool is single-product.

## Parameters

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `product_id` | `string` | yes | | Numeric storefront id (e.g. `"8472918765"`) or the platform-specific GID / SKU. Both accepted. |
| `limit` | `integer` | no | `3` | Max items to return. Clamped to `[1, 6]`. |

## Example call

A literal JSON-RPC `tools/call` payload an MCP host would send:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_recommendations",
    "arguments": {
      "product_id": "8472918765",
      "limit": 3
    }
  }
}
```

## Example response (typical)

```text
Top 3 complementary products for 8472918765:

1. Camera Cleaning Kit (SKU: CLN-001, confidence: 64%)
2. 32GB SD Card (SKU: SD-032, confidence: 51%)
3. Camera Strap (SKU: STR-002, confidence: 38%)

Structured JSON:
{
  "recommendations": [
    {
      "productId": "9182734651",
      "sku": "CLN-001",
      "title": "Camera Cleaning Kit",
      "confidence": 0.64,
      "price": 24.99,
      "currency": "USD"
    },
    {
      "productId": "9182734652",
      "sku": "SD-032",
      "title": "32GB SD Card",
      "confidence": 0.51,
      "price": 19.99,
      "currency": "USD"
    },
    {
      "productId": "9182734653",
      "sku": "STR-002",
      "title": "Camera Strap",
      "confidence": 0.38,
      "price": 14.99,
      "currency": "USD"
    }
  ]
}
```

## Example response (edge case: no data)

When the product has no qualifying co-purchase rules (new SKU, niche product, or no mining job has run yet):

```text
No recommendations found for product 8472918765. This usually means either
(a) the product isn't in the most-recent mining job's catalog,
(b) no qualifying co-purchase rules pair it with anything yet, or
(c) the merchant hasn't run a mining job yet.
```

The tool returns this as a normal (non-error) reply. Agents should treat it as "no statistical signal", not a failure.

## Error patterns

| Surface | Cause | Recovery |
|---|---|---|
| `Error: product_id is required.` | Missing or blank `product_id`. | Ask the user for the product id. |
| `Error: MBA_API_KEY environment variable not set.` | Server started without a key. | User edits MCP host config and restarts. |
| `Error: MBA API 401` | Key revoked or wrong environment. | User rotates key in admin. |
| `Error: MBA API 429` | Rate limited. The client already retries with backoff up to 3 attempts. | Slow down concurrent calls. |
| `Error: MBA API unreachable` | Network failure or upstream down. | Retry after a short delay. |

## Composition tips

- **Filter for return risk.** Pipe the top picks into [`score_return_risk`](./score-return-risk.md) before suggesting them to a shopper. A high-confidence recommendation that gets returned half the time is a net negative on margin.
- **Fall back to substitutes.** If the response is empty, call [`find_substitutes`](./find-substitutes.md) with the same `product_id`. Sometimes the cleaner question for an agent is "what's like this?" rather than "what pairs with this?".
- **Validate a hand-picked pair.** When the agent already has a target pair in mind, use [`score_cross_sell`](./score-cross-sell.md) instead, it's a direct yes/no with a confidence number rather than a top-k list.
- **Aggregate over a cart.** For multi-item carts use [`get_bundle_for_cart`](./get-bundle-for-cart.md), which fans this call out and re-ranks by multi-pair coverage.
