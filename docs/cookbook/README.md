# MCP Cookbook

Narrative docs for every tool the [`@marketbasketanalysis/mcp`](https://www.npmjs.com/package/@marketbasketanalysis/mcp) server exposes. The schema-level descriptions live in `src/tools/<name>.ts`; these pages add example JSON-RPC calls, sample responses (typical + edge case), error patterns, and composition tips.

> **What this is.** The first MCP server purpose-built for commerce intelligence. 17 tools (registered in `src/tools/index.ts`), organized into the **Basket AI agent** roles plus merchant-ops and advanced-mining groups, all backed by association rules mined from a merchant's actual Shopify / Magento / WooCommerce / BigCommerce order history. Not a generic "you might also like" guess.

## The Basket AI agents

The marketing site groups the discovery, bundle, insight, and replenishment tools into four agent roles; merchant-ops and advanced-mining tools round out the 17. The grouping is purely organizational, every tool ships in every install, and any host can call any tool at any time. The groups exist so an agent author can wire up only the surface they need. The cookbook pages below cover the four core agent roles; the merchant-ops, forecasting, and mining tools are documented inline in their `src/tools/<name>.ts` descriptions and in the top-level `README.md` tool catalog.

### Discovery Agent

Surfaces what customers buy together and what they buy instead. Powers the "what goes with X?" and "this SKU is unavailable, what's the fallback?" flows.

| Tool | One-liner |
|---|---|
| [`get_recommendations`](./get-recommendations.md) | For one product, return top complementary products customers also buy. |
| [`find_substitutes`](./find-substitutes.md) | For one product, return ranked replacement options. |

### Bundle Agent

Proposes complete kits from a partial cart. Covers consumer pre-checkout upsell and recurring subscription kits.

| Tool | One-liner |
|---|---|
| [`get_bundle_for_cart`](./get-bundle-for-cart.md) | Given a multi-item cart, suggest what's still missing to complete a high-confidence kit. |

### Insight Agent

Scores and audits proposed bundles before they ship. Returns confidence, cohesion, and return risk for any candidate basket.

| Tool | One-liner |
|---|---|
| [`score_cross_sell`](./score-cross-sell.md) | For a (product_a, product_b) pair, return the cross-sell strength. |
| [`analyze_basket`](./analyze-basket.md) | For 2-6 products, return a 0..1 cohesion score. |
| [`score_return_risk`](./score-return-risk.md) | For a candidate bundle, predict the probability it gets returned. |

### Replenishment Agent

Predicts reorder cadence per customer and proposes subscription kits tuned to their predicted refresh schedule.

| Tool | One-liner |
|---|---|
| [`predict_reorder`](./predict-reorder.md) | For a B2B account, predict which SKUs are due for reorder, when, and with what confidence. |
| [`propose_subscription_bundle`](./propose-subscription-bundle.md) | Given a customer's first-order items, propose a recurring kit they're likely to subscribe to. |

## Getting started

### 1. Install the MCP server

The server ships as an npm package. The recommended path is `npx`, which keeps it always-current without a manual upgrade step.

```bash
npx -y @marketbasketanalysis/mcp --help
```

### 2. Mint an API key

Open your MBA admin (Shopify app, Magento admin, or WooCommerce admin), navigate to **API keys**, click **Create key**, copy the plaintext (`mba_live_...`).

### 3. Wire it into your MCP host

For Claude Desktop / Claude Code, edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "marketbasketanalysis": {
      "command": "npx",
      "args": ["-y", "@marketbasketanalysis/mcp"],
      "env": {
        "MBA_API_KEY": "mba_live_YOUR_KEY_HERE"
      }
    }
  }
}
```

Restart your host. The `marketbasketanalysis` server should appear in the tools list with all 17 tools registered.

For Cursor, Cline, OpenAI Agent SDK, or other MCP hosts, the config file path differs but the `command + args + env` shape is identical. See your host's MCP docs.

### 4. (Optional) Poke at the REST endpoints directly

The tools wrap a public REST API at `https://app.marketbasketanalysis.com/api/v1/`. If you want to test the underlying calls without going through MCP, import the [Postman collection](../../postman_collection.json) at the repo root.

## Per-tool patterns

Every cookbook page follows the same structure so you can skim:

1. **What it does.** Two or three sentences.
2. **When to use it.** Three or four natural-language queries an agent should trigger this tool for.
3. **Required + optional parameters.** With types.
4. **Example call.** A literal JSON-RPC request as the agent would issue it.
5. **Example response.** A typical scenario and an edge case ("no data available").
6. **Error patterns.** What kinds of errors agents should expect.
7. **Composition tips.** When this tool should be chained with another.

## Cross-tool chains

A handful of recurring patterns:

- **Discovery -> Insight**: `get_recommendations` then `score_return_risk` on the top picks, so you don't surface high-return items.
- **Bundle -> Insight**: `get_bundle_for_cart` then `analyze_basket` on the full proposal to verify cohesion.
- **Discovery -> Discovery**: `find_substitutes` when `get_recommendations` returns no rows (the target product may be brand-new or seasonal).
- **Replenishment composite**: `propose_subscription_bundle` internally chains `get_recommendations` + `predict_reorder`; you rarely need to call them separately when building a subscription kit.

## Versioning

These docs cover the MCP server at the current major (`v0.5.x`). Tool names and parameter shapes are stable; underlying response payloads (e.g. new fields on `Recommendation`) may grow additively without a breaking-change bump. The `find_substitutes` `signals` shape and `score_return_risk` `risk_level` bands are the most-likely-to-evolve surfaces; treat both as informational, not as a contract.
