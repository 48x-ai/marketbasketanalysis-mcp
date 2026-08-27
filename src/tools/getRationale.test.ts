import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./getRationale.js";

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

describe("get_rationale handler", () => {
  beforeEach(() => setApiContext(VALID_CTX));
  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ product_id: "p1", related_product_id: "p2" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("requires both product ids", async () => {
    const result = await handler({ product_id: "p1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/both required/);
  });

  it("renders the rationale sentence on success", async () => {
    const fetchSpy = mockOnce(200, {
      sentence: "Customers who buy gym backpacks frequently add a water bottle.",
      cached: true,
      fallback: false,
      ttlSeconds: 3600,
    });
    const result = await handler({ product_id: "p1", related_product_id: "p2" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/gym backpacks frequently add a water bottle/);
    const url = fetchSpy.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/api/v1/rationale");
    expect(url.searchParams.get("productId")).toBe("p1");
    expect(url.searchParams.get("relatedProductId")).toBe("p2");
  });

  it("surfaces a sanitized 500 error message", async () => {
    mockOnce(500, { error: "internal", hint: "sk_live_xyz" });
    const result = await handler({ product_id: "p1", related_product_id: "p2" });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/MBA API 500/);
    expect(text).not.toMatch(/sk_live_xyz/);
  }, 10_000);
});
