/**
 * Tool registry. Adding a new tool: implement it in its own file
 * under src/tools/, then register here.
 *
 * The list order is the order tools appear in the agent's
 * tool-discovery list, keep the most-frequently-used tools first
 * so they have prime real-estate.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiError } from "../lib/api.js";
import * as getRecommendations from "./getRecommendations.js";
import * as getBundleForCart from "./getBundleForCart.js";
import * as scoreCrossSell from "./scoreCrossSell.js";
import * as analyzeBasket from "./analyzeBasket.js";
import * as predictReorder from "./predictReorder.js";
import * as proposeSubscriptionBundle from "./proposeSubscriptionBundle.js";
import * as findSubstitutes from "./findSubstitutes.js";
import * as scoreReturnRisk from "./scoreReturnRisk.js";
import * as getRationale from "./getRationale.js";
import * as getWeeklyPlan from "./getWeeklyPlan.js";
import * as executeWeeklyPlanAction from "./executeWeeklyPlanAction.js";
import * as forecastBundle from "./forecastBundle.js";
import * as getOpportunities from "./getOpportunities.js";
import * as explainOpportunity from "./explainOpportunity.js";
import * as triageOpportunity from "./triageOpportunity.js";
import * as mineHuiItemsets from "./mineHuiItemsets.js";
import * as getDriftAlerts from "./getDriftAlerts.js";
import * as explainDrift from "./explainDrift.js";
import * as getForecastAlerts from "./getForecastAlerts.js";

export interface ToolModule {
  definition: {
    name: string;
    description: string;
    inputSchema: object;
  };
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/**
 * Platforms recognized by MBA_PLATFORM. Empty / unset is treated as
 * the legacy default ("any") so existing installs don't lose tools
 * on upgrade.
 *
 * predict_reorder is gated at registration time to the backends that
 * actually implement reorder predictions. All four below ship the
 * endpoint; they disagree on its URL, which is why the path is resolved
 * per platform in lib/accounts.ts (reorderPredictionsPath) rather than
 * hardcoded. OroCommerce does not implement it at all, so the tool
 * stays hidden there instead of surfacing an opaque 404 an agent can't
 * recover from.
 */
const platform = (process.env.MBA_PLATFORM ?? "").trim().toLowerCase();
const REORDER_PLATFORMS = new Set(["shopify", "bigcommerce", "woocommerce", "magento"]);
const predictReorderVisible = platform === "" || REORDER_PLATFORMS.has(platform);

const allModules: ToolModule[] = [
  // Discovery agent role
  getRecommendations,
  findSubstitutes,
  getRationale,
  // Bundle agent role
  getBundleForCart,
  proposeSubscriptionBundle,
  // Insight agent role
  scoreCrossSell,
  scoreReturnRisk,
  analyzeBasket,
  // Replenishment agent role
  predictReorder,
  forecastBundle,
  // Merchant operations (weekly plan + opportunity triage + alerts)
  getWeeklyPlan,
  executeWeeklyPlanAction,
  getOpportunities,
  explainOpportunity,
  triageOpportunity,
  getDriftAlerts,
  explainDrift,
  getForecastAlerts,
  // Advanced mining
  mineHuiItemsets,
];

const modules: ToolModule[] = allModules.filter((m) => {
  if (m.definition.name === "predict_reorder" && !predictReorderVisible) {
    return false;
  }
  return true;
});

export const toolDefinitions = modules.map((m) => m.definition);

/**
 * Dispatches an MCP tools/call to the matching handler. Any thrown
 * error is converted into a sanitized `isError: true` reply so a
 * stray bug or upstream surprise can't crash the MCP host's
 * JSON-RPC connection. ApiError messages are surfaced verbatim (they
 * are already sanitized, see lib/api.ts), anything else is mapped to
 * a generic "internal error" so we don't leak arbitrary stack traces
 * or library messages to the agent. Same protective principle we
 * applied in PR #7 for upstream error bodies.
 */
export async function dispatch(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const mod = modules.find((m) => m.definition.name === name);
  if (!mod) {
    return {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    return await mod.handler(args);
  } catch (e) {
    const sanitized =
      e instanceof ApiError ? e.message : "An internal error occurred.";
    // Surface to ops via stderr, never to the agent.
    console.error(`[mba-mcp] dispatch error tool=${name}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    return {
      content: [{ type: "text" as const, text: `Error: ${sanitized}` }],
      isError: true,
    };
  }
}
