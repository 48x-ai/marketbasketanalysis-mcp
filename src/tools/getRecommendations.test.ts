import { describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./getRecommendations.js";

/**
 * Integration test for the get_recommendations tool handler. The
 * handler is the MCP-host-facing surface: it composes apiContext +
 * coerceLimit + the lib/api fetch logic into the agent-readable
 * `{content, isError}` reply shape.
 *
 * We exercise the wiring (auth → bearer header → response render),
 * not every branch of lib/api (which has its own test file).
 */

function mockOnce(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

describe("get_recommendations handler", () => {
  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ product_id: "p1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("returns an error reply when product_id is empty", async () => {
    setApiContext({ apiKey: "k", apiBase: "https://app.marketbasketanalysis.com" });
    const result = await handler({ product_id: "" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/product_id is required/);
    setApiContext(null);
  });

  it("renders 'no recommendations' text when upstream returns []", async () => {
    setApiContext({ apiKey: "k", apiBase: "https://app.marketbasketanalysis.com" });
    mockOnce(200, { recommendations: [] });
    const result = await handler({ product_id: "p1" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/No recommendations found/);
    setApiContext(null);
  });

  it("renders a numbered list when upstream returns recommendations", async () => {
    setApiContext({ apiKey: "k", apiBase: "https://app.marketbasketanalysis.com" });
    mockOnce(200, {
      recommendations: [
        { productId: "p2", sku: "SOCKS-001", title: "Wool Socks", confidence: 0.84 },
        { productId: "p3", sku: "HAT-002", title: null, confidence: 0.42 },
      ],
    });
    const result = await handler({ product_id: "p1", limit: 3 });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/Wool Socks.*SKU: SOCKS-001.*84%/s);
    expect(text).toMatch(/HAT-002/);
    expect(text).toMatch(/```json/);
    setApiContext(null);
  });

  it("surfaces a sanitized 401 message (no raw upstream body leaked)", async () => {
    setApiContext({ apiKey: "k", apiBase: "https://app.marketbasketanalysis.com" });
    mockOnce(401, { error: "invalid_token", hint: "rotate sk_live_xyz" });
    const result = await handler({ product_id: "p1" });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/MBA API 401/);
    // The hint that includes a key fragment must not be echoed
    // into the agent's context.
    expect(text).not.toMatch(/sk_live_xyz/);
    expect(text).not.toMatch(/invalid_token/);
    setApiContext(null);
  });

  it("forwards a coerced limit (defaults out-of-range to max=6)", async () => {
    setApiContext({ apiKey: "k", apiBase: "https://app.marketbasketanalysis.com" });
    const fetchSpy = mockOnce(200, { recommendations: [] });
    await handler({ product_id: "p1", limit: 99 });
    const calledUrl = fetchSpy.mock.calls[0][0] as URL;
    expect(calledUrl.searchParams.get("limit")).toBe("6");
    setApiContext(null);
  });
});
