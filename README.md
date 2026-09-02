# `@marketbasketanalysis/mcp`

[![npm version](https://img.shields.io/npm/v/@marketbasketanalysis/mcp?style=flat-square)](https://www.npmjs.com/package/@marketbasketanalysis/mcp)
[![License](https://img.shields.io/badge/license-UNLICENSED-red?style=flat-square)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-blue?style=flat-square)](https://modelcontextprotocol.io)

An [MCP](https://modelcontextprotocol.io) server that gives any AI
agent access to **real co-purchase intelligence** and **merchant ops
tooling** from an ecommerce merchant's order history. 19 tools across
discovery, bundle, insight, replenishment, merchant ops, and advanced
mining. Works with **Claude Desktop**, **Claude Code**, **Cursor**,
**Windsurf**, **Cline**, the **OpenAI Agent SDK**, and any other host
that speaks the MCP stdio protocol. Works for merchants on
**Shopify**, **BigCommerce**, **WooCommerce**, **Magento**, and
**OroCommerce**. See "Platform coverage" below for which tools reach the
self-hosted backends.

One npm package serves every marketplace. The server is platform
agnostic, it is an HTTP client that calls a store's MBA backend over
the public REST API. You re-point the whole server at any store with a
single switch (`MBA_API_BASE`, see below). Most tools work on all five
platforms; a handful depend on a backend route that not every platform
ships yet. Per-tool marketplace coverage is the
[Tool catalog](#tool-catalog) "Marketplace" column.

## Why this exists

When a customer asks an AI shopping agent "what goes with the gym
backpack?" the agent should give a real answer based on the
merchant's actual order data, not a generic "you might also like"
guess. When a merchant asks Claude "what should I work on this week?"
the agent should pull from a ranked weekly plan, not invent tasks.
This server makes both of those flows available to any MCP host in
one line of config.

## 5-line install (Claude Desktop)

```json
{
  "mcpServers": {
    "marketbasketanalysis": {
      "command": "npx",
      "args": ["-y", "@marketbasketanalysis/mcp"],
      "env": { "MBA_API_KEY": "mba_live_YOUR_KEY_HERE" }
    }
  }
}
```

Paste into `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS), restart Claude Desktop, the `marketbasketanalysis` server
appears in the tools list with all 19 tools.

## Zero-install: the hosted endpoint

The same server runs hosted at
`https://mcp.marketbasketanalysis.com/mcp` (MCP streamable HTTP).
Nothing to install; send your key as a bearer header instead of an
env var:

```bash
claude mcp add --transport http marketbasketanalysis \
  https://mcp.marketbasketanalysis.com/mcp \
  --header "Authorization: Bearer mba_live_YOUR_KEY_HERE"
```

Works with any remote-capable MCP client (Claude Code, Cursor,
Smithery, custom agents). Optional headers: `X-MBA-Base` re-points at
another MBA-operated plane (for example
`https://bigcommerce.marketbasketanalysis.com`); `X-MBA-Platform`
mirrors the MBA_PLATFORM env var. Self-hosted WooCommerce and Magento
stores are not reachable from the hosted endpoint by design, use the
npx install above with MBA_API_BASE pointed at your own site.

## Point the server at your store (MBA_API_BASE)

The base URL is per-store configuration. By default the server talks
to the shared hosted backend at `https://app.marketbasketanalysis.com`.
If your data lives anywhere else, a BigCommerce store, a self-hosted
backend, or a staging instance, set `MBA_API_BASE` so every tool
reaches your own data plane:

```json
{
  "mcpServers": {
    "marketbasketanalysis": {
      "command": "npx",
      "args": ["-y", "@marketbasketanalysis/mcp"],
      "env": {
        "MBA_API_KEY": "mba_live_YOUR_KEY_HERE",
        "MBA_API_BASE": "https://your-store-backend.example.com"
      }
    }
  }
}
```

`MBA_API_BASE` is the single switch that re-points the whole server;
all 19 tools route through it. The value must be an `https://` URL for
non-local hosts (loopback, private, link-local, and metadata-service
hosts are refused). For local development against a backend on
`localhost`, set `ALLOW_LOCAL_API_BASE=1` to allow an `http://localhost`
base. Env-var changes take effect at server startup, so restart your
MCP host after editing the value.

### MBA_API_BASE per platform

The base URL is per-store configuration. Shopify, BigCommerce, and
OroCommerce stores are served by the shared hosted backend, so they use
the default. WooCommerce and Magento run the backend locally inside the
store install, so point the server at the store's own domain:

| Platform | `MBA_API_BASE` |
|---|---|
| Shopify | unset (hosted default `https://app.marketbasketanalysis.com`) |
| BigCommerce | unset (hosted default) |
| OroCommerce | unset (thin hosted client, same hosted backend) |
| WooCommerce | `https://your-store.example.com` (WordPress site URL). Its routes live under `marketbasketanalysis/v1`; the server maps paths automatically. See "Platform coverage" for which tools apply. |
| Magento | `https://your-magento.example.com` (the `/rest` base). Its routes live under `V1/marketbasketanalysis`; the server maps paths automatically. See "Platform coverage" for which tools apply. |

### Platform coverage

The server writes canonical `/api/v1/...` paths and rewrites them per
platform, because WooCommerce and Magento run the backend inside the
store on their own REST conventions (`marketbasketanalysis/v1` and
`V1/marketbasketanalysis` respectively).

**10 of the 19 tools reach WooCommerce and Magento**: the six that derive
from `/recommendations` (`get_recommendations`, `get_bundle_for_cart`,
`score_cross_sell`, `analyze_basket`, `propose_subscription_bundle`,
`score_return_risk`), plus `find_substitutes`, `get_rationale`,
`forecast_bundle`, and `predict_reorder`.

The other 9 are the merchant-ops surface: `get_opportunities`,
`triage_opportunity`, `get_weekly_plan`, `execute_weekly_plan_action`,
`get_drift_alerts`, `get_forecast_alerts`, `explain_opportunity`,
`explain_drift`, and `mine_hui_itemsets`. Those endpoints do not exist on
the self-hosted backends. Calling one there returns a clear "not
available on this platform" error naming the endpoint, with no network
round trip, rather than an opaque 404.

For step-by-step install (config file location per OS, where to mint
an API key, troubleshooting):

- Claude Desktop: [dist/mcp/claude-desktop-setup.md](../../dist/mcp/claude-desktop-setup.md)
- Cursor: [dist/mcp/cursor-setup.md](../../dist/mcp/cursor-setup.md)
- Windsurf: [dist/mcp/windsurf-setup.md](../../dist/mcp/windsurf-setup.md)

## Authentication

The server reads `MBA_API_KEY` from the environment your MCP host
passes in and sends it as a `Bearer` token on every request. To get a
key:

1. Open the MarketBasketAnalysis admin (Shopify app drawer, or
   BigCommerce / WooCommerce / Magento / OroCommerce admin).
2. Click "API keys" in the left nav.
3. Click "Create key", name it, and copy the `mba_live_` value (it is
   shown once).

Keys are per-shop, revocable, and rotated from the same screen. Only
the SHA-256 hash is stored, so re-mint if a key leaks.

Auth model differs per marketplace, the MCP server abstracts it, but
worth knowing:

- **Shopify, BigCommerce**: `Bearer mba_live_...` straight through.
  This is the common path.
- **WooCommerce**: `Bearer` against a Woo-minted key, which must carry
  the `customer_data` scope for `predict_reorder`.
- **Magento**: tools reach the store over the Magento REST surface
  (`/V1/marketbasketanalysis/*` and `/V1/mba/*`); some routes are
  admin-token / ACL scoped on the store side.
- **OroCommerce**: the store sits behind the platform OAuth2 firewall
  for `/api/` routes; the hosted backend the thin client proxies to is
  what the MCP server actually calls, so the `mba_live_` key still
  applies.

## Tool catalog

19 tools, organized into the four **Basket AI agent** roles plus
two operational groups. The **Marketplace** column states which
backends ship the route the tool calls, which is not the same as
which backends this server can currently REACH: see "Platform
coverage" above. "All five" means Shopify, BigCommerce, WooCommerce,
Magento, OroCommerce.

### Discovery

| Tool | Description | Required params | Marketplace |
|---|---|---|---|
| `get_recommendations` | Complementary products for a single product. | `product_id` | All five |
| `find_substitutes` | Replacement options when a product is unavailable. | `product_id` | All five |
| `get_rationale` | One-sentence "why" for a recommendation pair. | `product_id`, `related_product_id` | All five |

### Bundle

These derive everything from `/recommendations` (the server composes
the bundle/scoring logic client-side), so they need no extra backend
route and work everywhere.

| Tool | Description | Required params | Marketplace |
|---|---|---|---|
| `get_bundle_for_cart` | Missing kit components for a multi-item cart. | `product_ids` | All five |
| `propose_subscription_bundle` | Recurring subscription kit proposal. | `seed_product_ids` | All five |

### Insight

Also `/recommendations`-derived, so universal.

| Tool | Description | Required params | Marketplace |
|---|---|---|---|
| `score_cross_sell` | Strength verdict for a (a, b) pair. | `product_a`, `product_b` | All five |
| `score_return_risk` | Bundle return-risk score. | `product_ids` | All five |
| `analyze_basket` | Cohesion score for a proposed bundle. | `product_ids` | All five |

### Replenishment + forecasting

| Tool | Description | Required params | Marketplace |
|---|---|---|---|
| `predict_reorder` | B2B reorder cadence per customer / SKU. | `customer_id` | Shopify, BigCommerce, WooCommerce, Magento. Hidden when `MBA_PLATFORM=orocommerce`. |
| `forecast_bundle` | Weekly Holt-Winters forecast + buy quantity. | `bundle_id` | Shopify, BigCommerce, Magento (`/forecast/bundle-inventory`). Not on OroCommerce. |

### Merchant ops

These call Bearer `/api/v1` routes that ship on BigCommerce today.
Shopify serves opportunities, drift, and the weekly plan through its
embedded admin views rather than an `/api/v1` route, so these tools
resolve against a BigCommerce backend. The one exception is
`/explain-opportunity`, which now ships on BigCommerce and Shopify;
`/explain-drift` remains BigCommerce only. The tools surface a clean
upstream 404 on platforms that lack the route.

| Tool | Description | Required params | Marketplace |
|---|---|---|---|
| `get_weekly_plan` | Ranked weekly action list. | (none) | BigCommerce |
| `execute_weekly_plan_action` | Dispatch a specific action (confirm-gated). | `action_id`, `confirm` | BigCommerce |
| `get_opportunities` | Mined opportunities, ranked. | (none) | BigCommerce |
| `explain_opportunity` | Stats (support / confidence / lift / sample count) plus a templated "why this is a good cross-sell" narrative for one opportunity. | `opportunity_id` | BigCommerce, Shopify |
| `triage_opportunity` | Activate / pause / archive (confirm-gated). | `opportunity_id`, `action`, `confirm` | BigCommerce (`POST /opportunities/{id}/action`); admin grid on other platforms. |
| `get_drift_alerts` | Rules whose confidence has drifted. | (none) | BigCommerce |
| `explain_drift` | Stats plus a templated "why this pair drifted" narrative for one drift alert (degrades gracefully for a disappeared pair). | `alert_id` | BigCommerce |
| `get_forecast_alerts` | Bundles at risk of stockout / demand drop. | (none) | BigCommerce |

### Advanced mining

| Tool | Description | Required params | Marketplace |
|---|---|---|---|
| `mine_hui_itemsets` | High-utility itemset mining (Plus / Enterprise). | `orders` | Shopify, BigCommerce, WooCommerce, OroCommerce. Plus / Enterprise tier. |

## Example prompts per tool

Paste any of these into a Claude Desktop / Claude Code / Cursor chat
after wiring up the server:

- `get_recommendations`: *"Use marketbasketanalysis to find what
  customers also buy with the gym backpack (product 8472918765)."*
- `find_substitutes`: *"The DSLR body is out of stock. What is a good
  substitute?"*
- `get_rationale`: *"Why is the water bottle recommended with the gym
  backpack?"*
- `get_bundle_for_cart`: *"I have a camera body, 32GB SD card, and a
  tripod in my cart. What is likely missing to make this a complete
  kit?"*
- `propose_subscription_bundle`: *"Build a monthly subscription kit
  for customer 9876."*
- `score_cross_sell`: *"Is a cleaning kit a good cross-sell for the
  DSLR camera body?"*
- `score_return_risk`: *"What is the return risk of the camera + lens
  + tripod + bag bundle?"*
- `analyze_basket`: *"I am thinking of bundling camera + lens + SD
  card + bag. Based on actual customer data, is that a strong
  bundle?"*
- `predict_reorder`: *"What is Acme Corp (customer 7654321) due to
  reorder this week?"*
- `forecast_bundle`: *"Forecast bundle b-camera-kit for the next 12
  weeks and recommend a buy quantity."*
- `get_weekly_plan`: *"What is on my weekly plan?"*
- `execute_weekly_plan_action`: *"Run action a-42 from my weekly
  plan, confirmed."*
- `get_opportunities`: *"Show me my top three proposed
  opportunities."*
- `explain_opportunity`: *"Why is opportunity opp-17 a good
  cross-sell?"*
- `triage_opportunity`: *"Activate opportunity opp-17, confirmed."*
- `get_drift_alerts`: *"Are any of my rules drifting?"*
- `explain_drift`: *"Why did the pair in drift alert alert-7
  drift?"*
- `get_forecast_alerts`: *"Which bundles are at risk of stockout?"*
- `mine_hui_itemsets`: *"Mine top-20 high-utility itemsets from this
  90-day order payload."* (Plus / Enterprise tier)

Per-tool narrative docs live in the [cookbook](./docs/cookbook/README.md).

## Env vars

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MBA_API_KEY` | yes | -- | The `mba_live_...` key from your admin |
| `MBA_API_BASE` | no | `https://app.marketbasketanalysis.com` | Per-store base URL. Set this for BigCommerce, self-hosted, or staging backends so the server points at your data plane. Must be `https://` for non-local hosts. |
| `MBA_PLATFORM` | no | `(any)` | Set to `shopify` or `bigcommerce` to expose platform-gated tools (e.g. `predict_reorder`) |
| `MBA_SENTRY_DSN` | no | -- | Opt-in error telemetry (merchant-controlled) |
| `MBA_DEBUG_ERRORS` | no | -- | Set to `1` to print upstream error bodies to stderr |
| `ALLOW_LOCAL_API_BASE` | no | -- | Set to `1` to permit `localhost` in `MBA_API_BASE` during dev |

## Development

```bash
git clone https://github.com/48x-ai/marketbasketanalysis
cd marketbasketanalysis
pnpm install
pnpm --filter ./packages/mcp typecheck
pnpm --filter ./packages/mcp test
pnpm --filter ./packages/mcp dev    # tsx-based local run
pnpm --filter ./packages/mcp build  # emit ./dist
```

### Adding a new tool

Each tool is a self-contained module under `src/tools/`. To add one:

1. Create `src/tools/myNewTool.ts` exporting `definition` and `handler`.
   Mirror the structure of `src/tools/getRecommendations.ts` for a
   simple GET, or `src/tools/triageOpportunity.ts` for a POST with a
   confirm gate.
2. Register it in `src/tools/index.ts` by importing and adding the
   module to the `allModules` array.
3. Add tests in `src/tools/myNewTool.test.ts`, covering: missing-key
   reply, happy path, and at least one upstream-error path. Mirror
   `src/tools/findSubstitutes.test.ts`.
4. Document it in the table above and in `dist/mcp/smithery.yaml`.

### Distribution artifacts

The `dist/mcp/` directory at the monorepo root holds the install
samples (Claude Desktop, Cursor, Windsurf), the Smithery YAML, and
the Anthropic marketplace submission content. See
`dist/mcp/README.md` for the full layout.

### Publishing

Tag-based publish via the monorepo-root
`.github/workflows/publish-mcp.yml` workflow. Bump the version in
`packages/mcp/package.json` (keep `server.json` and `src/index.ts` in
sync), merge to main, then tag `mcp-v$VERSION` and push the tag. The
workflow runs typecheck, test, build, a tag/version match check, then
`npm publish --access public --provenance` using the `NPM_TOKEN` repo
secret. A `workflow_dispatch` manual trigger is available for rescue
runs.

The full operator checklist, including the one-time `NPM_TOKEN` setup
and a no-CI manual publish fallback, lives in
[docs/RELEASE.md](./docs/RELEASE.md).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Server does not appear in tool drawer | JSON typo or `npx` not on PATH. Check the host's MCP log. |
| "Error: MBA_API_KEY environment variable not set" | `env` block missing or value empty. |
| "MBA API 401" | Key revoked or wrong; mint a fresh one. |
| "MBA API unreachable" | Network reach failed; check `https://status.marketbasketanalysis.com`. |
| Tool times out on first call | First `npx -y` cold-start downloads the package; install globally for repeat speed. |
| "MBA API returned malformed response" | Upstream backend drift; set `MBA_DEBUG_ERRORS=1` to see the body in stderr. |
| `predict_reorder` missing | The tool is platform-gated: it registers when `MBA_PLATFORM` is unset, `shopify`, or `bigcommerce`. The reorder-prediction route also exists on WooCommerce and Magento but the tool gate does not expose it there yet. |

For deeper diagnostics see each per-IDE setup doc under
[`dist/mcp/`](../../dist/mcp/).

## License

UNLICENSED, proprietary.
