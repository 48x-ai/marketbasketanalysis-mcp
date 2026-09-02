#!/usr/bin/env node
/**
 * marketbasketanalysis-mcp, MCP server exposing the MBA hosted
 * recommendations API as tools any MCP-compatible agent (Claude
 * Desktop, Claude Code, OpenAI Agent SDK, Cline, Cursor, etc.)
 * can call.
 *
 * Transport: stdio. The hosted streamable-HTTP entry lives in
 * src/http.ts (bin: mba-mcp-http; production:
 * https://mcp.marketbasketanalysis.com/mcp).
 *
 * Tools exposed (v0.7):
 *   Discovery:
 *     - get_recommendations     → complements for a single product
 *     - find_substitutes        → replacement options for a product
 *     - get_rationale           → one-sentence "why" for a pair
 *   Bundle:
 *     - get_bundle_for_cart     → kit completion given a cart
 *     - propose_subscription_bundle → recurring subscription kit
 *   Insight:
 *     - score_cross_sell        → strength of a (a, b) pair
 *     - score_return_risk       → bundle return-risk score
 *     - analyze_basket          → cohesion score for a proposed bundle
 *   Replenishment + forecasting:
 *     - predict_reorder         → B2B reorder cadence prediction
 *     - forecast_bundle         → Holt-Winters bundle forecast
 *   Merchant ops:
 *     - get_weekly_plan         → ranked actions for the week
 *     - execute_weekly_plan_action → dispatch a specific action
 *     - get_opportunities       → mined opportunities, ranked
 *     - explain_opportunity     → stats + templated "why" for one op
 *     - triage_opportunity      → pause/activate/archive an op
 *     - get_drift_alerts        → rules that have drifted
 *     - explain_drift           → stats + templated "why" for one alert
 *     - get_forecast_alerts     → bundles at risk of stockout
 *   Advanced mining:
 *     - mine_hui_itemsets       → high-utility itemset mining
 *
 * Setup:
 *   1. Mint an API key in the MBA admin (Shopify app → API keys,
 *      or Magento/WooCommerce admin → API keys).
 *   2. Add this server to your MCP-host config:
 *
 *      Claude Desktop / Claude Code:
 *        ~/Library/Application Support/Claude/claude_desktop_config.json
 *      {
 *        "mcpServers": {
 *          "marketbasketanalysis": {
 *            "command": "npx",
 *            "args": ["-y", "@marketbasketanalysis/mcp"],
 *            "env": {
 *              "MBA_API_KEY": "mba_live_..."
 *            }
 *          }
 *        }
 *      }
 *
 *   3. Restart your MCP host. The "marketbasketanalysis" server
 *      should appear in the tools list with all 19 tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readContext, setApiContext } from "./lib/api.js";
import { initSentry } from "./lib/sentry.js";
import { dispatch, toolDefinitions } from "./tools/index.js";

// Resolve and cache the API context ONCE at startup. Env-var changes
// (MBA_API_KEY, MBA_API_BASE) won't be picked up mid-session, the
// merchant must restart the MCP host to reload. This is intentional
// so a key removal can't go silently unnoticed.
const startupContext = readContext();
setApiContext(startupContext);

// Initialize Sentry. Opt-in via MBA_SENTRY_DSN; no-ops without it.
// We do NOT bake a DSN into the published npm package; telemetry
// stays merchant-opt-in.
initSentry();

const server = new Server(
  {
    name: "marketbasketanalysis",
    version: "0.7.1",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "MarketBasketAnalysis exposes a merchant's own mined order-history " +
      "affinities: every confidence, lift, and support value is computed from " +
      "THIS merchant's orders, not a generic model, so recommendations are " +
      "explainable and store-specific. Discovery tools (get_recommendations, " +
      "find_substitutes, get_bundle_for_cart) work on all five platforms. The " +
      "merchant-ops tools (get_opportunities, triage_opportunity, " +
      "get_weekly_plan, drift and forecast alerts) are BigCommerce today and " +
      "return a clear not-available message elsewhere; call get_opportunities " +
      "before triage_opportunity.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  return dispatch(request.params.name, args);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // No stdout prints, stdout is the JSON-RPC channel for stdio
  // transports. Logs go to stderr.
  //
  // Startup breadcrumb: include the resolved apiBase so a
  // misconfigured MBA_API_BASE shows up in the host log immediately.
  // NEVER log the apiKey, it's a bearer credential.
  if (startupContext) {
    console.error(
      `[mba-mcp] started; apiBase=${startupContext.apiBase}; ${toolDefinitions.length} tools registered`,
    );
  } else {
    console.error(
      `[mba-mcp] started; no API key configured; ${toolDefinitions.length} tools registered`,
    );
  }
}

main().catch((err) => {
  console.error("[marketbasketanalysis-mcp] fatal:", err);
  process.exit(1);
});
