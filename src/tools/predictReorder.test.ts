import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { definition, handler } from "./predictReorder.js";

/**
 * Integration test for the predict_reorder tool handler. The handler
 * wraps lib/accounts.getReorderPredictions (which calls
 * /api/v1/accounts/:id/reorder-predictions) and groups the result by
 * status bucket into the agent-readable `{content, isError}` shape.
 *
 * We mock fetch (not the lib/accounts layer) so the zod response
 * validation + auth-header wiring is exercised end-to-end, same
 * pattern as findSubstitutes.test.ts.
 */

const VALID_CTX = { apiKey: "k", apiBase: "https://app.marketbasketanalysis.com" };

function mockOnce(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

describe("predict_reorder definition", () => {
  it("declares the tool name + B2B reorder-intent phrasings the router keys on", () => {
    expect(definition.name).toBe("predict_reorder");
    // Agent routers (LLMs) pick this tool by description match. The
    // task spec requires reorder/cadence phrasings show up so a
    // sales-rep agent asking "what's Acme Corp due to reorder?" lands
    // here, not on get_recommendations.
    expect(definition.description).toMatch(/reorder/i);
    expect(definition.description).toMatch(/B2B/);
    expect(definition.description).toMatch(/overdue/);
    expect(definition.description).toMatch(/Shopify/);
    expect(definition.inputSchema.required).toEqual(["customer_id"]);
  });
});

describe("predict_reorder handler", () => {
  beforeEach(() => {
    setApiContext(VALID_CTX);
  });

  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ customer_id: "c1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("returns a typed error when customer_id is missing", async () => {
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/customer_id is required/);
  });

  it("returns a typed error when customer_id is whitespace-only", async () => {
    const result = await handler({ customer_id: "   " });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/customer_id is required/);
  });

  it("renders 'no predictions' guidance when upstream returns an empty predictions array", async () => {
    mockOnce(200, {
      customerId: "c1",
      totalOrders: 1,
      windowOrders: 1,
      predictions: [],
    });
    const result = await handler({ customer_id: "c1" });
    // Empty result is NOT an error - the tool surfaces it as
    // human-readable guidance ("fewer than 2 orders for the same SKU,
    // or cadence too irregular to predict") so the agent can pivot.
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/No reorder predictions available for customer c1/);
    expect(text).toMatch(/CV > 1/);
  });

  it("groups predictions by status bucket and includes a structured JSON block", async () => {
    mockOnce(200, {
      customerId: "c1",
      totalOrders: 12,
      windowOrders: 12,
      predictions: [
        {
          productId: "p1",
          sku: "BEANS",
          title: "Coffee Beans",
          totalOrders: 5,
          lastOrderedAt: "2026-04-01T00:00:00Z",
          meanIntervalDays: 28,
          stdevDays: 2,
          predictedNextAt: "2026-04-29T00:00:00Z",
          daysUntilPredicted: -3,
          confidence: 0.92,
          status: "overdue",
        },
        {
          productId: "p2",
          sku: "FILTER",
          title: "Coffee Filter",
          totalOrders: 4,
          lastOrderedAt: "2026-05-10T00:00:00Z",
          meanIntervalDays: 30,
          stdevDays: 3,
          predictedNextAt: "2026-06-09T00:00:00Z",
          daysUntilPredicted: 5,
          confidence: 0.81,
          status: "due_soon",
        },
        {
          productId: "p3",
          sku: "MILK",
          title: "Oat Milk",
          totalOrders: 3,
          lastOrderedAt: "2026-05-15T00:00:00Z",
          meanIntervalDays: 21,
          stdevDays: 4,
          predictedNextAt: "2026-06-05T00:00:00Z",
          daysUntilPredicted: 21,
          confidence: 0.66,
          status: "on_track",
        },
      ],
    });
    const result = await handler({ customer_id: "c1" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/Reorder predictions for customer c1 \(12 orders scanned\)/);
    // Overdue bucket renders first
    expect(text).toMatch(/\*\*Overdue \(1\)\*\*/);
    expect(text).toMatch(/Coffee Beans, 3d overdue/);
    expect(text).toMatch(/mean cadence 28d, confidence 92%, 5 prior orders/);
    // Due-soon bucket
    expect(text).toMatch(/\*\*Due soon \(1\)\*\*/);
    expect(text).toMatch(/Coffee Filter, due in 5d/);
    // On-track bucket
    expect(text).toMatch(/\*\*On track \(1\)\*\*/);
    // Structured JSON for sophisticated hosts
    expect(text).toMatch(/```json/);
    // Buckets must appear in priority order so agents process overdue
    // before on_track.
    expect(text.indexOf("Overdue")).toBeLessThan(text.indexOf("Due soon"));
    expect(text.indexOf("Due soon")).toBeLessThan(text.indexOf("On track"));
  });

  it("renders 'due today' when daysUntilPredicted is exactly 0", async () => {
    mockOnce(200, {
      customerId: "c1",
      totalOrders: 4,
      windowOrders: 4,
      predictions: [
        {
          productId: "p1",
          sku: "BEANS",
          title: "Coffee Beans",
          totalOrders: 4,
          lastOrderedAt: "2026-05-01T00:00:00Z",
          meanIntervalDays: 30,
          stdevDays: 1,
          predictedNextAt: "2026-05-31T00:00:00Z",
          daysUntilPredicted: 0,
          confidence: 0.95,
          status: "due_soon",
        },
      ],
    });
    const result = await handler({ customer_id: "c1" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/Coffee Beans, due today/);
  });

  it("forwards customer_id in the URL path (encoded)", async () => {
    const fetchSpy = mockOnce(200, {
      customerId: "gid://shopify/Customer/7654321",
      totalOrders: 0,
      windowOrders: 0,
      predictions: [],
    });
    await handler({ customer_id: "gid://shopify/Customer/7654321" });
    const calledUrl = fetchSpy.mock.calls[0][0] as URL;
    // URL constructor decodes single-encoded segments back into the
    // pathname property, so check the pre-decoded representation.
    expect(calledUrl.pathname).toBe(
      "/api/v1/accounts/gid%3A%2F%2Fshopify%2FCustomer%2F7654321/reorder-predictions",
    );
  });

  it("forwards product_id as a query-string filter when supplied", async () => {
    const fetchSpy = mockOnce(200, {
      customerId: "c1",
      totalOrders: 0,
      windowOrders: 0,
      predictions: [],
    });
    await handler({ customer_id: "c1", product_id: "p42" });
    const calledUrl = fetchSpy.mock.calls[0][0] as URL;
    expect(calledUrl.searchParams.get("product_id")).toBe("p42");
  });

  it("does NOT send a product_id param when product_id is empty/whitespace", async () => {
    const fetchSpy = mockOnce(200, {
      customerId: "c1",
      totalOrders: 0,
      windowOrders: 0,
      predictions: [],
    });
    await handler({ customer_id: "c1", product_id: "   " });
    const calledUrl = fetchSpy.mock.calls[0][0] as URL;
    expect(calledUrl.searchParams.has("product_id")).toBe(false);
  });

  it("surfaces a sanitized 500 message (no upstream body leaked)", async () => {
    mockOnce(500, { error: "internal", trace_id: "trace-xyz", hint: "sk_live_abc" });
    const result = await handler({ customer_id: "c1" });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    // ApiError surface: "MBA API <status>", never the upstream body.
    // The lib retries 5xx 3 times before throwing; the retry sleep is
    // ~250ms-1.75s + jitter total, which is fine for a unit test.
    expect(text).toMatch(/MBA API 500/);
    expect(text).not.toMatch(/trace-xyz/);
    expect(text).not.toMatch(/sk_live_abc/);
  }, 10_000);

  it("surfaces a sanitized 401 message (no upstream auth hint leaked)", async () => {
    mockOnce(401, { error: "invalid_token", hint: "rotate sk_live_xyz" });
    const result = await handler({ customer_id: "c1" });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/MBA API 401/);
    expect(text).not.toMatch(/sk_live_xyz/);
    expect(text).not.toMatch(/invalid_token/);
  });
});

describe("predict_reorder platform gate", () => {
  // The platformUnsupported check is evaluated at module load against
  // MBA_PLATFORM. To test the gate we have to reset module state and
  // re-import after setting the env var.
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("short-circuits with a clear error when MBA_PLATFORM=orocommerce", async () => {
    vi.stubEnv("MBA_PLATFORM", "orocommerce");
    vi.resetModules();
    // Re-import lib/api too so we set the apiContext on the SAME
    // module instance that the freshly-loaded predictReorder reads
    // from. With vi.resetModules() each `await import(...)` returns a
    // brand-new module record, so the top-level `setApiContext` from
    // this test file would be wired to a stale lib/api copy.
    const freshApi = await import("../lib/api.js");
    const mod = await import("./predictReorder.js");
    freshApi.setApiContext(VALID_CTX);
    const result = await mod.handler({ customer_id: "c1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(
      /Shopify, BigCommerce, WooCommerce, and Magento backends/,
    );
    expect(result.content[0].text).toMatch(/MBA_PLATFORM is set to "orocommerce"/);
    freshApi.setApiContext(null);
  });

  it("allows the call through when MBA_PLATFORM=shopify", async () => {
    vi.stubEnv("MBA_PLATFORM", "shopify");
    vi.resetModules();
    const freshApi = await import("../lib/api.js");
    const mod = await import("./predictReorder.js");
    freshApi.setApiContext(VALID_CTX);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        customerId: "c1",
        totalOrders: 0,
        windowOrders: 0,
        predictions: [],
      }),
      text: async () => "",
    } as unknown as Response);
    const result = await mod.handler({ customer_id: "c1" });
    // No isError set; the empty-predictions guidance is rendered.
    expect(result.isError).toBeUndefined();
    freshApi.setApiContext(null);
  });

  it("allows the call through when MBA_PLATFORM=bigcommerce", async () => {
    vi.stubEnv("MBA_PLATFORM", "bigcommerce");
    vi.resetModules();
    const freshApi = await import("../lib/api.js");
    const mod = await import("./predictReorder.js");
    freshApi.setApiContext(VALID_CTX);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        customerId: "c1",
        totalOrders: 0,
        windowOrders: 0,
        predictions: [],
      }),
      text: async () => "",
    } as unknown as Response);
    const result = await mod.handler({ customer_id: "c1" });
    // The BC route shares the Shopify contract, so the tool is callable
    // and renders the empty-predictions guidance rather than the gate.
    expect(result.isError).toBeUndefined();
    freshApi.setApiContext(null);
  });

  // The four supporting backends agree on the response shape but NOT on
  // the URL. Gating a platform in without mapping its path just moves
  // the failure from a clear gate message to an opaque upstream 404, so
  // these assert the actual URL each platform is called on.
  it.each([
    ["shopify", "https://app.marketbasketanalysis.com/api/v1/accounts/c1/reorder-predictions"],
    ["bigcommerce", "https://app.marketbasketanalysis.com/api/v1/accounts/c1/reorder-predictions"],
    [
      "woocommerce",
      "https://app.marketbasketanalysis.com/wp-json/marketbasketanalysis/v1/customers/c1/reorder-predictions",
    ],
    [
      "magento",
      "https://app.marketbasketanalysis.com/V1/marketbasketanalysis/customers/c1/reorder-predictions",
    ],
  ])("calls the %s backend on its own path", async (plat, expectedUrl) => {
    vi.stubEnv("MBA_PLATFORM", plat);
    vi.resetModules();
    const freshApi = await import("../lib/api.js");
    const mod = await import("./predictReorder.js");
    freshApi.setApiContext(VALID_CTX);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        customerId: "c1",
        totalOrders: 0,
        windowOrders: 0,
        predictions: [],
      }),
      text: async () => "",
    } as unknown as Response);

    await mod.handler({ customer_id: "c1" });

    const called = String(fetchSpy.mock.calls[0]?.[0]);
    expect(called).toBe(expectedUrl);
    freshApi.setApiContext(null);
  });
});
