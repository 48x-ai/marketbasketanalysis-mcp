/**
 * Per-platform path resolution.
 *
 * The hosted plane (Shopify, BigCommerce, OroCommerce) serves the
 * canonical `/api/v1/...` paths. WooCommerce and Magento run the backend
 * inside the store on their own REST conventions, so the same endpoint
 * lives elsewhere. These tests pin the exact mapping, because getting it
 * wrong does not fail loudly: it produces a 404 the agent cannot act on.
 *
 * Route sources these assertions are derived from:
 *   packages/woocommerce/includes/Rest/RestApi.php  (NAMESPACE
 *     'marketbasketanalysis/v1') plus each controller's ROUTE const
 *   packages/magento/etc/webapi.xml
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePlatformPath, UnsupportedOnPlatformError } from "./api.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function on(platform: string) {
  vi.stubEnv("MBA_PLATFORM", platform);
}

describe("resolvePlatformPath, hosted plane", () => {
  it.each(["", "shopify", "bigcommerce", "orocommerce"])(
    "passes canonical paths through untouched on %s",
    (platform) => {
      on(platform);
      expect(resolvePlatformPath("/api/v1/recommendations")).toBe("/api/v1/recommendations");
      expect(resolvePlatformPath("/api/v1/opportunities")).toBe("/api/v1/opportunities");
      expect(resolvePlatformPath("/api/v1/accounts/c1/reorder-predictions")).toBe(
        "/api/v1/accounts/c1/reorder-predictions",
      );
    },
  );
});

describe("resolvePlatformPath, WooCommerce", () => {
  const ROOT = "/wp-json/marketbasketanalysis/v1";

  it.each([
    ["/api/v1/recommendations", `${ROOT}/recommendations`],
    ["/api/v1/substitutions", `${ROOT}/substitutions`],
    ["/api/v1/rationale", `${ROOT}/rationale`],
    ["/api/v1/forecast/bundle-inventory", `${ROOT}/forecast/bundle-inventory`],
  ])("maps %s", (canonical, expected) => {
    on("woocommerce");
    expect(resolvePlatformPath(canonical)).toBe(expected);
  });

  it("rewrites the accounts prefix to customers, preserving the id and tail", () => {
    on("woocommerce");
    expect(resolvePlatformPath("/api/v1/accounts/c1/reorder-predictions")).toBe(
      `${ROOT}/customers/c1/reorder-predictions`,
    );
  });
});

describe("resolvePlatformPath, Magento", () => {
  const ROOT = "/V1/marketbasketanalysis";

  it.each([
    ["/api/v1/recommendations", `${ROOT}/recommendations`],
    ["/api/v1/substitutions", `${ROOT}/substitutions`],
    ["/api/v1/forecast/bundle-inventory", `${ROOT}/forecast/bundle-inventory`],
  ])("maps %s", (canonical, expected) => {
    on("magento");
    expect(resolvePlatformPath(canonical)).toBe(expected);
  });

  it("serves rationale from the /V1/mba namespace, not /V1/marketbasketanalysis", () => {
    on("magento");
    // Magento registers rationale under a different namespace than its
    // other MBA routes. This asserts we do not "tidy" it into ROOT.
    expect(resolvePlatformPath("/api/v1/rationale")).toBe("/V1/mba/rationale");
  });

  it("rewrites the accounts prefix to customers", () => {
    on("magento");
    expect(resolvePlatformPath("/api/v1/accounts/c1/reorder-predictions")).toBe(
      `${ROOT}/customers/c1/reorder-predictions`,
    );
  });
});

describe("resolvePlatformPath, endpoints absent on the self-hosted backends", () => {
  // The merchant-ops surface exists only on the hosted plane. Returning
  // null lets the caller say so; silently passing the canonical path
  // through would 404 instead.
  const ABSENT = [
    "/api/v1/opportunities",
    "/api/v1/opportunities/o1/action",
    "/api/v1/weekly-plan/current",
    "/api/v1/weekly-plan/execute",
    "/api/v1/drift-alerts",
    "/api/v1/forecast-alerts",
    "/api/v1/explain-opportunity",
    "/api/v1/explain-drift",
    "/api/v1/hosted/hui-mine",
  ];

  it.each(ABSENT)("returns null for %s on woocommerce", (path) => {
    on("woocommerce");
    expect(resolvePlatformPath(path)).toBeNull();
  });

  it.each(ABSENT)("returns null for %s on magento", (path) => {
    on("magento");
    expect(resolvePlatformPath(path)).toBeNull();
  });
});

describe("UnsupportedOnPlatformError", () => {
  it("names the path and the platform so an agent can explain itself", () => {
    const e = new UnsupportedOnPlatformError("/api/v1/opportunities", "woocommerce");
    expect(e.message).toContain("/api/v1/opportunities");
    expect(e.message).toContain("woocommerce");
    // It should point at where the endpoint DOES live, not just refuse.
    expect(e.message).toMatch(/Shopify, BigCommerce, and OroCommerce/);
  });
});

describe("a real tool handler degrades gracefully on an absent endpoint", () => {
  // The whole point of returning null instead of letting the canonical
  // path through is that the agent gets something it can act on. This
  // asserts the end-to-end behavior, not just the resolver: no throw
  // escaping to the MCP transport, isError set, and a message that
  // explains where the endpoint actually lives.
  it("get_opportunities returns isError with an explanatory message on woocommerce", async () => {
    vi.stubEnv("MBA_PLATFORM", "woocommerce");
    vi.resetModules();
    const freshApi = await import("./api.js");
    const mod = await import("../tools/getOpportunities.js");
    freshApi.setApiContext({ apiKey: "k", apiBase: "https://store.example.com" });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await mod.handler({});

    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toContain("/api/v1/opportunities");
    expect(text).toMatch(/Shopify, BigCommerce, and OroCommerce/);
    // And it never reached the network: no 404 round trip, no retries.
    expect(fetchSpy).not.toHaveBeenCalled();

    freshApi.setApiContext(null);
    vi.restoreAllMocks();
  });
});
