import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { definition, handler } from "./findSubstitutes.js";

/**
 * Integration test for the find_substitutes tool handler. The handler
 * wraps lib/api.getSubstitutes (which calls /api/v1/substitutions) and
 * renders the result into the agent-readable `{content, isError}`
 * shape. We mock fetch (not the lib/api layer) so the zod response
 * validation + auth-header wiring is exercised end-to-end, same
 * pattern as getRecommendations.test.ts.
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

describe("find_substitutes definition", () => {
  it("declares the tool name + substitution-intent phrasings the router keys on", () => {
    expect(definition.name).toBe("find_substitutes");
    // Agent routers (LLMs) pick this tool by description match. The
    // task spec requires substitution-intent phrasings show up so
    // "out of stock" / "alternative to X" queries land here, not on
    // get_recommendations.
    expect(definition.description).toMatch(/REPLACE/);
    expect(definition.description).toMatch(/substitute/i);
    expect(definition.description).toMatch(/out of stock/i);
    expect(definition.description).toMatch(/alternative/i);
    expect(definition.inputSchema.required).toEqual(["product_id"]);
  });
});

describe("find_substitutes handler", () => {
  beforeEach(() => {
    setApiContext(VALID_CTX);
  });

  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ product_id: "p1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("returns a typed error when product_id is missing", async () => {
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/product_id is required/);
  });

  it("returns a typed error when product_id is empty / whitespace", async () => {
    const result = await handler({ product_id: "   " });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/product_id is required/);
  });

  it("renders 'no substitutes' guidance when upstream returns []", async () => {
    mockOnce(200, { substitutions: [] });
    const result = await handler({ product_id: "p1" });
    // Empty result is NOT an error - the tool surfaces it as
    // human-readable guidance so the agent knows whether it should
    // (a) try a different product, (b) ask the merchant to run a
    // mining job, or (c) accept that the catalog has no peers.
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/No substitutes found for product p1/);
    expect(text).toMatch(/mining job/);
  });

  it("renders a ranked list with similarity scores + reasons on a successful response", async () => {
    mockOnce(200, {
      substitutions: [
        {
          productId: "sub1",
          sku: "ALT-001",
          title: "Alt Wool Socks",
          score: 0.91,
          reason: "context_similar",
        },
        {
          productId: "sub2",
          sku: "ALT-002",
          title: null,
          score: 0.74,
          reason: "category_match",
        },
        {
          productId: "sub3",
          sku: "ALT-003",
          title: "Vendor-Match Socks",
          score: 0.58,
          reason: "vendor_match",
        },
      ],
    });
    const result = await handler({ product_id: "p1", limit: 3 });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/Top 3 substitutes for p1/);
    expect(text).toMatch(/Alt Wool Socks.*SKU: ALT-001.*match: 91%.*similar basket context/s);
    // null title -> sku fallback in the rendered line
    expect(text).toMatch(/ALT-002.*same category/s);
    expect(text).toMatch(/Vendor-Match Socks.*same vendor/s);
    // Structured JSON block for sophisticated hosts
    expect(text).toMatch(/```json/);
  });

  it("forwards limit + product_id as query params and clamps out-of-range limits to max=6", async () => {
    const fetchSpy = mockOnce(200, { substitutions: [] });
    await handler({ product_id: "p1", limit: 99 });
    const calledUrl = fetchSpy.mock.calls[0][0] as URL;
    expect(calledUrl.pathname).toBe("/api/v1/substitutions");
    expect(calledUrl.searchParams.get("product_id")).toBe("p1");
    // coerceLimit(99, default=3, max=6) -> 6
    expect(calledUrl.searchParams.get("limit")).toBe("6");
  });

  it("falls back to default limit when limit is a non-numeric string (validation-error case)", async () => {
    const fetchSpy = mockOnce(200, { substitutions: [] });
    await handler({ product_id: "p1", limit: "not-a-number" });
    const calledUrl = fetchSpy.mock.calls[0][0] as URL;
    // coerceLimit treats non-finite as "unset" -> default = 3
    expect(calledUrl.searchParams.get("limit")).toBe("3");
  });

  it("surfaces a sanitized 500 error message (no raw upstream body leaked)", async () => {
    mockOnce(500, { error: "internal", trace_id: "trace-xyz", hint: "sk_live_abc" });
    const result = await handler({ product_id: "p1" });
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
    const result = await handler({ product_id: "p1" });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/MBA API 401/);
    expect(text).not.toMatch(/sk_live_xyz/);
    expect(text).not.toMatch(/invalid_token/);
  });
});
