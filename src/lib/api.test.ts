import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiGet,
  coerceLimit,
  getRecommendations,
  readContext,
  setApiContext,
  type ApiContext,
} from "./api.js";

/**
 * Helper: install a fetch mock for one test. Each entry in
 * `responses` is consumed in order so the test can simulate a
 * sequence (e.g. 429 → 200) cleanly.
 */
function mockFetchSequence(
  responses: Array<{ ok?: boolean; status: number; body: unknown; headers?: Record<string, string> }>,
) {
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.ok ?? (r.status >= 200 && r.status < 300),
      status: r.status,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    } as unknown as Response;
  });
}

const VALID_CTX: ApiContext = {
  apiKey: "mba_live_test_key",
  apiBase: "https://app.marketbasketanalysis.com",
};

describe("coerceLimit", () => {
  it("returns default for undefined / null / non-numeric", () => {
    expect(coerceLimit(undefined, 3, 6)).toBe(3);
    expect(coerceLimit(null, 3, 6)).toBe(3);
    expect(coerceLimit("not-a-number", 3, 6)).toBe(3);
    expect(coerceLimit("", 3, 6)).toBe(3);
  });

  it("returns default for NaN / Infinity", () => {
    expect(coerceLimit(Number.NaN, 3, 6)).toBe(3);
    expect(coerceLimit(Number.POSITIVE_INFINITY, 3, 6)).toBe(3);
    expect(coerceLimit(Number.NEGATIVE_INFINITY, 3, 6)).toBe(3);
  });

  it("clamps to [1, max]", () => {
    expect(coerceLimit(0, 3, 6)).toBe(1);
    expect(coerceLimit(-5, 3, 6)).toBe(1);
    expect(coerceLimit(100, 3, 6)).toBe(6);
    expect(coerceLimit(6, 3, 6)).toBe(6);
  });

  it("truncates floats", () => {
    expect(coerceLimit(2.9, 3, 6)).toBe(2);
    expect(coerceLimit("4.7", 3, 6)).toBe(4);
  });
});

describe("readContext / SSRF guard on MBA_API_BASE", () => {
  it("returns null when no API key set", () => {
    expect(readContext()).toBeNull();
  });

  it("returns default base when key is set without an explicit base", () => {
    process.env.MBA_API_KEY = "mba_live_x";
    const ctx = readContext();
    expect(ctx).toEqual({
      apiKey: "mba_live_x",
      apiBase: "https://app.marketbasketanalysis.com",
    });
  });

  it("accepts a valid https public base", () => {
    process.env.MBA_API_KEY = "mba_live_x";
    process.env.MBA_API_BASE = "https://store.example.fly.dev";
    expect(readContext()?.apiBase).toBe("https://store.example.fly.dev");
  });

  it("rejects http (plain) for non-local hosts", () => {
    process.env.MBA_API_KEY = "mba_live_x";
    process.env.MBA_API_BASE = "http://store.example.com";
    expect(() => readContext()).toThrow(/must be https/i);
  });

  it("rejects file://, gopher://, javascript: schemes", () => {
    process.env.MBA_API_KEY = "mba_live_x";
    for (const url of ["file:///etc/passwd", "gopher://1.2.3.4/", "javascript:alert(1)"]) {
      process.env.MBA_API_BASE = url;
      expect(() => readContext(), `URL: ${url}`).toThrow();
    }
  });

  it("rejects 127.0.0.1 and 'localhost' (without ALLOW_LOCAL)", () => {
    process.env.MBA_API_KEY = "mba_live_x";
    for (const host of ["http://127.0.0.1:8080", "https://localhost:443"]) {
      process.env.MBA_API_BASE = host;
      expect(() => readContext(), `Host: ${host}`).toThrow();
    }
  });

  /**
   * These use REAL IPv6 URL literals, which the older test above never did
   * despite being named for `::1`.
   *
   * WHATWG URL always brackets an IPv6 hostname: `new URL("https://[::1]/")`
   * has `.hostname === "[::1]"`, never `"::1"`. The guard compared against the
   * bare form, so every IPv6 branch was unreachable and the blocklist was
   * inert for the entire address family. MBA_API_BASE is merchant-facing (a
   * smithery.yaml form field, a documented env var), and the key is sent as
   * `Authorization: Bearer` to whatever it names, so a bad setup snippet
   * exfiltrated a live `mba_live_` key on every tool call.
   */
  it("rejects IPv6 loopback, link-local and unique-local literals", () => {
    process.env.MBA_API_KEY = "mba_live_x";
    const bad = [
      "https://[::1]/",              // loopback
      "https://[::1]:8443/",         // loopback with a port
      "https://[fe80::1]/",          // link-local, reaches cloud metadata
      "https://[fe80::1%25eth0]/",   // link-local with a zone index
      "https://[fc00::dead:beef]/",  // unique-local, the IPv6 RFC1918
      "https://[fd12:3456::1]/",     // fd00::/8, also unique-local
      "https://[::]/",               // unspecified
      "https://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
      "https://[::ffff:10.0.0.5]/",  // IPv4-mapped RFC1918
    ];
    for (const url of bad) {
      process.env.MBA_API_BASE = url;
      expect(() => readContext(), `URL: ${url}`).toThrow();
    }
  });

  it("still allows ordinary public hosts that merely contain hex-ish labels", () => {
    process.env.MBA_API_KEY = "mba_live_x";
    for (const url of [
      "https://app.marketbasketanalysis.com",
      "https://fdsomething.example.com",  // starts with "fd" but is not an IPv6 literal
      "https://fe80.example.com",         // starts with "fe80" but is not an IPv6 literal
    ]) {
      process.env.MBA_API_BASE = url;
      expect(() => readContext(), `URL: ${url}`).not.toThrow();
    }
  });

  it("rejects RFC1918 / link-local / 0.0.0.0", () => {
    process.env.MBA_API_KEY = "mba_live_x";
    const bad = [
      "https://10.0.0.5",
      "https://172.16.0.1",
      "https://172.31.255.255",
      "https://192.168.1.1",
      "https://169.254.169.254", // metadata service
      "https://0.0.0.0",
    ];
    for (const url of bad) {
      process.env.MBA_API_BASE = url;
      expect(() => readContext(), `URL: ${url}`).toThrow();
    }
  });

  it("accepts localhost / 127.0.0.1 only when ALLOW_LOCAL_API_BASE=1", () => {
    process.env.MBA_API_KEY = "mba_live_x";
    process.env.ALLOW_LOCAL_API_BASE = "1";
    for (const host of ["http://127.0.0.1:8080", "http://localhost:3000"]) {
      process.env.MBA_API_BASE = host;
      expect(readContext()?.apiBase, `Host: ${host}`).toBe(host);
    }
  });

  it("rejects malformed URLs", () => {
    process.env.MBA_API_KEY = "mba_live_x";
    process.env.MBA_API_BASE = "not a url at all";
    expect(() => readContext()).toThrow(/not a valid URL/i);
  });
});

describe("apiGet", () => {
  it("sends bearer auth + parses success body", async () => {
    mockFetchSequence([{ status: 200, body: { recommendations: [] } }]);
    const result = await apiGet(VALID_CTX, "/api/v1/recommendations", { product_id: "p1" });
    expect(result).toEqual({ recommendations: [] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl.toString()).toMatch(/\/api\/v1\/recommendations\?product_id=p1/);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer mba_live_test_key",
    });
  });

  it("preserves a base-path prefix on the configured apiBase", async () => {
    mockFetchSequence([{ status: 200, body: {} }]);
    await apiGet(
      { ...VALID_CTX, apiBase: "https://host.example.com/v2" },
      "/api/v1/recommendations",
      { product_id: "p1" },
    );
    const [calledUrl] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl.toString()).toBe(
      "https://host.example.com/v2/api/v1/recommendations?product_id=p1",
    );
  });

  it("throws ApiError with sanitized message on 401", async () => {
    mockFetchSequence([{ status: 401, body: { error: "invalid_token" } }]);
    await expect(
      apiGet(VALID_CTX, "/api/v1/recommendations", { product_id: "p1" }),
    ).rejects.toMatchObject({ message: "MBA API 401", status: 401, kind: "upstream" });
  });

  it("retries on 429 and succeeds on 2nd attempt", async () => {
    mockFetchSequence([
      { status: 429, body: "rate limited", headers: { "retry-after": "0" } },
      { status: 200, body: { recommendations: [{ productId: "p2", sku: "S2", title: "T2", confidence: 0.9 }] } },
    ]);
    const result = await apiGet(VALID_CTX, "/api/v1/recommendations", { product_id: "p1" });
    expect(result).toMatchObject({ recommendations: [{ sku: "S2" }] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx then gives up after 3 attempts", async () => {
    mockFetchSequence([
      { status: 503, body: "" },
      { status: 503, body: "" },
      { status: 503, body: "down" },
    ]);
    await expect(apiGet(VALID_CTX, "/api/v1/recommendations", {})).rejects.toMatchObject({
      status: 503,
      kind: "upstream",
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("throws kind:network on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(apiGet(VALID_CTX, "/api/v1/recommendations", {})).rejects.toMatchObject({
      kind: "network",
      message: "MBA API unreachable",
    });
  });

  it("throws kind:validation when response shape is wrong", async () => {
    mockFetchSequence([{ status: 200, body: { recommendations: "not-an-array" } }]);
    const { RecommendationsResponseSchema } = await import("./api.js");
    await expect(
      apiGet(VALID_CTX, "/api/v1/recommendations", {}, RecommendationsResponseSchema),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});

describe("getRecommendations", () => {
  it("returns an empty array when upstream returns no recommendations key", async () => {
    mockFetchSequence([{ status: 200, body: { model_version: "v1" } }]);
    const recs = await getRecommendations(VALID_CTX, "p1", 3);
    expect(recs).toEqual([]);
  });

  it("returns parsed Recommendation objects on success", async () => {
    mockFetchSequence([
      {
        status: 200,
        body: {
          recommendations: [
            { productId: "p2", sku: "S2", title: "T2", confidence: 0.92 },
            { productId: "p3", sku: "S3", title: null, confidence: 0.71 },
          ],
        },
      },
    ]);
    const recs = await getRecommendations(VALID_CTX, "p1", 6);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ sku: "S2", confidence: 0.92 });
    expect(recs[1].title).toBeNull();
  });

  it("rejects malformed upstream items at the schema boundary", async () => {
    mockFetchSequence([
      {
        status: 200,
        body: { recommendations: [{ wrongShape: true }] },
      },
    ]);
    await expect(getRecommendations(VALID_CTX, "p1")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("setApiContext / apiContext", () => {
  it("setApiContext writes the module-level apiContext value", async () => {
    setApiContext({ apiKey: "k", apiBase: "https://x.example.com" });
    const { apiContext } = await import("./api.js");
    expect(apiContext).toEqual({ apiKey: "k", apiBase: "https://x.example.com" });
    setApiContext(null);
  });
});
