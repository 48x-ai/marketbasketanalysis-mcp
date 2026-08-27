/**
 * Tests for the hosted-only PostHog capture layer.
 *
 * The invariants that matter: no key -> no network call at all (the
 * npm/stdio privacy stance), the payload shape PostHog expects, key
 * hashing (the bearer key must never appear in a payload), and
 * failure swallowing (a PostHog outage cannot break a request).
 */

import { describe, expect, it, vi } from "vitest";
import { capture, distinctIdForKey } from "./analytics.js";

describe("distinctIdForKey", () => {
  it("returns anon for null", () => {
    expect(distinctIdForKey(null)).toBe("anon");
  });

  it("hashes keys stably and never echoes the key", () => {
    const a = distinctIdForKey("mba_live_secret123");
    const b = distinctIdForKey("mba_live_secret123");
    expect(a).toBe(b);
    expect(a).toMatch(/^store:[0-9a-f]{12}$/);
    expect(a).not.toContain("secret");
  });

  it("distinguishes different keys", () => {
    expect(distinctIdForKey("key-one")).not.toBe(distinctIdForKey("key-two"));
  });
});

describe("capture", () => {
  it("does nothing without MBA_POSTHOG_KEY", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockClear();
    capture("mcp_request", "anon", {});
    expect(spy).not.toHaveBeenCalled();
  });

  it("POSTs the PostHog capture payload when configured", async () => {
    process.env.MBA_POSTHOG_KEY = "phc_test_key";
    process.env.MBA_POSTHOG_HOST = "https://ph.example.com";
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    capture("mcp_request", "store:abc123def456", { tool: "get_recommendations", status: 200 });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("https://ph.example.com/capture/");
    const body = JSON.parse(String(init?.body));
    expect(body.api_key).toBe("phc_test_key");
    expect(body.event).toBe("mcp_request");
    expect(body.distinct_id).toBe("store:abc123def456");
    expect(body.properties.tool).toBe("get_recommendations");
    expect(body.properties.$process_person_profile).toBe(true);
    delete process.env.MBA_POSTHOG_KEY;
    delete process.env.MBA_POSTHOG_HOST;
  });

  it("swallows network failures", async () => {
    process.env.MBA_POSTHOG_KEY = "phc_test_key";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("posthog down"));
    expect(() => capture("mcp_request", "anon", {})).not.toThrow();
    // Let the rejected promise settle; an unhandled rejection here
    // would fail the test file.
    await new Promise((r) => setTimeout(r, 0));
    delete process.env.MBA_POSTHOG_KEY;
  });
});
