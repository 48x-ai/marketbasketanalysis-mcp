/**
 * Server-side PostHog capture for the HOSTED HTTP entrypoint only.
 *
 * Policy: the npm/stdio distribution ships NO baked-in telemetry
 * (same stance as Sentry in sentry.ts). This module no-ops unless
 * MBA_POSTHOG_KEY is set, and only the Fly deployment sets it, so
 * local `npx @marketbasketanalysis/mcp` users are never phoned home.
 *
 * Capture is fire-and-forget over the plain /capture API (no
 * posthog-node dependency): a failed or slow analytics call must
 * never delay or fail an MCP request, so errors are swallowed
 * (logged to stderr only under MBA_DEBUG_ERRORS=1) and the request
 * path never awaits the result.
 *
 * Privacy: API keys are never sent. Merchants are identified by a
 * truncated SHA-256 of their bearer key ("store:abc123def456"),
 * which is stable per key but not reversible. No request bodies, no
 * tool arguments, no customer data.
 */

import { createHash } from "node:crypto";

const DEFAULT_HOST = "https://us.i.posthog.com";

/** Capture timeout: generous for a background call, bounded so a
 * PostHog outage cannot pile up sockets. */
const CAPTURE_TIMEOUT_MS = 3000;

function config(): { key: string; host: string } | null {
  const key = process.env.MBA_POSTHOG_KEY?.trim();
  if (!key) return null;
  const host = (process.env.MBA_POSTHOG_HOST?.trim() || DEFAULT_HOST).replace(/\/+$/, "");
  return { key, host };
}

/** Stable pseudonymous id for a bearer key. Never log or send the key. */
export function distinctIdForKey(apiKey: string | null): string {
  if (!apiKey) return "anon";
  return `store:${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}`;
}

/**
 * Fire-and-forget event capture. Synchronous from the caller's view;
 * the network call runs detached. Safe to call unconditionally, it
 * no-ops without MBA_POSTHOG_KEY.
 */
export function capture(
  event: string,
  distinctId: string,
  properties: Record<string, string | number | boolean | null> = {},
): void {
  const cfg = config();
  if (!cfg) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
  void fetch(`${cfg.host}/capture/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: cfg.key,
      event,
      distinct_id: distinctId,
      properties: {
        ...properties,
        // Server-side events should not create anonymous person
        // profiles for every agent request; keep persons for
        // identified stores only.
        $process_person_profile: distinctId !== "anon",
      },
      timestamp: new Date().toISOString(),
    }),
    signal: controller.signal,
  })
    .catch((e) => {
      if (process.env.MBA_DEBUG_ERRORS === "1") {
        console.error(
          `[mba-mcp-http] posthog capture failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })
    .finally(() => clearTimeout(timer));
}
