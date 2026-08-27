/**
 * Sentry wiring for the MCP server.
 *
 * No-ops when MBA_SENTRY_DSN is unset. The env var is namespaced so
 * merchants who run the server locally don't risk colliding with a
 * Sentry DSN they already have in their environment for other tools.
 *
 * The MCP server runs as a per-host stdio subprocess on the
 * merchant's developer machine, NOT as a hosted service. That has
 * two implications for Sentry config:
 *
 *   1. Sample rate kept very low (0.01) so a heavy LLM session
 *      doesn't blow through Sentry's free-tier quota
 *   2. Personally-identifying network data is scrubbed by default
 *      (sendDefaultPii: false). We do not transmit prompts or tool
 *      responses to Sentry, only the error context.
 *
 * Setup for the operator (us, not merchants):
 *   - Get a DSN from sentry.io for the `marketbasketanalysis-mcp`
 *     project
 *   - Bake it into the published npm package via the build pipeline
 *     (NOT recommended for an open-source CLI; merchants would
 *     unknowingly send telemetry to us)
 *   - OR document MBA_SENTRY_DSN as an optional env var merchants
 *     opt into for support tickets
 *
 * Current stance: MBA_SENTRY_DSN is opt-in by the merchant. We do
 * NOT bake a DSN into the package.
 */

import * as Sentry from "@sentry/node";

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.MBA_SENTRY_DSN?.trim();
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "production",
    tracesSampleRate: 0.01,
    sendDefaultPii: false,
    beforeSend(event) {
      // Drop info/warning/debug events. The MCP runs on merchant
      // dev machines where transient network errors are common
      // (apiBase unreachable, retry succeeded, etc.). Only ship
      // error + fatal so Sentry quota goes to actionable signal.
      // Sentry's issue-alert UI doesn't expose a level filter, so
      // we do it here at the SDK boundary.
      const level = event.level ?? "error";
      if (level !== "error" && level !== "fatal") {
        return null;
      }

      // Strip the apiBase + apiKey from any contextual data. The
      // apiKey shouldn't reach Sentry under normal operation; this
      // is defense-in-depth.
      if (event.extra) {
        for (const k of Object.keys(event.extra)) {
          const lower = k.toLowerCase();
          if (lower.includes("apikey") || lower.includes("token") || lower.includes("secret")) {
            event.extra[k] = "[REDACTED]";
          }
        }
      }
      return event;
    },
  });
  initialized = true;
}

/**
 * Capture an exception with optional context tags. Safe before init.
 */
export function captureException(
  err: unknown,
  context?: { toolName?: string; productId?: string },
): void {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (context?.toolName) scope.setTag("tool", context.toolName);
    if (context?.productId) scope.setTag("product_id", context.productId);
    Sentry.captureException(err);
  });
}
