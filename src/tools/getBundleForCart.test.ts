import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler, definition } from "./getBundleForCart.js";

/**
 * Integration test for the get_bundle_for_cart tool handler.
 *
 * Exercises the cart-completion fan-out: /recommendations per cart
 * item, aggregation by recommended product, the multi-pair ranking
 * boost (confidenceSum + pairs), filtering of items already in cart,
 * and the empty-result render. Also covers the >6 chunking path so
 * the chunkArray branch is exercised.
 */

const VALID_CTX = { apiKey: "k", apiBase: "https://app.marketbasketanalysis.com" };

function mockRouter(routes: Array<{ match: string; status: number; body: unknown }>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const hit = routes.find((r) => url.includes(r.match));
    const status = hit?.status ?? 200;
    const body = hit?.body ?? { recommendations: [] };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
}

describe("get_bundle_for_cart definition", () => {
  it("surfaces cart-completion phrasings and disambiguates from get_recommendations", () => {
    expect(definition.name).toBe("get_bundle_for_cart");
    expect(definition.description).toContain("what else do I need?");
    expect(definition.description).toContain("Different from get_recommendations");
  });
});

describe("get_bundle_for_cart handler", () => {
  beforeEach(() => {
    setApiContext(VALID_CTX);
  });

  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ product_ids: ["p1"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("rejects an empty cart", async () => {
    const result = await handler({ product_ids: [] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at least one product/);
  });

  it("rejects a cart of only blank strings", async () => {
    const result = await handler({ product_ids: ["", "   "] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at least one product/);
  });

  it("ranks the multi-cart-item complement first via the +pairs boost", async () => {
    // c1 pairs with both cart items (score 0.8 + 2 = 2.8).
    // c2 pairs with one cart item at 0.9 (score 0.9 + 1 = 1.9).
    mockRouter([
      {
        match: "product_id=p1",
        status: 200,
        body: {
          recommendations: [
            { productId: "c1", sku: "GLUE", title: "Wood Glue", confidence: 0.4 },
            { productId: "c2", sku: "CLAMP", title: "Bar Clamp", confidence: 0.9 },
          ],
        },
      },
      {
        match: "product_id=p2",
        status: 200,
        body: {
          recommendations: [{ productId: "c1", sku: "GLUE", title: "Wood Glue", confidence: 0.4 }],
        },
      },
    ]);

    const result = await handler({ product_ids: ["p1", "p2"], limit: 3 });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/Top 2 kit-completion suggestions for cart of 2 items/);
    expect(text).toMatch(/Wood Glue.*pairs with 2\/2 cart items/);

    const json = JSON.parse((text.match(/```json\n([\s\S]*?)\n```/) ?? [])[1]);
    expect(json.suggestions[0].productId).toBe("c1");
    expect(json.suggestions[0].pairs_with).toBe(2);
    expect(json.suggestions[0].avg_confidence).toBeCloseTo(0.4, 5);
    expect(json.cart).toEqual(["p1", "p2"]);
  });

  it("filters out products already in the cart", async () => {
    // p1's recs include p2 (already in cart): must not be suggested.
    mockRouter([
      {
        match: "product_id=p1",
        status: 200,
        body: {
          recommendations: [
            { productId: "p2", sku: "INCART", title: "Already In Cart", confidence: 0.9 },
            { productId: "c1", sku: "NEW", title: "New Item", confidence: 0.5 },
          ],
        },
      },
      { match: "product_id=p2", status: 200, body: { recommendations: [] } },
    ]);

    const result = await handler({ product_ids: ["p1", "p2"] });
    const text = result.content[0].text as string;
    const json = JSON.parse((text.match(/```json\n([\s\S]*?)\n```/) ?? [])[1]);
    const ids = json.suggestions.map((s: { productId: string }) => s.productId);
    expect(ids).toContain("c1");
    expect(ids).not.toContain("p2");
  });

  it("honors the limit cap (coerces out-of-range to max=6)", async () => {
    mockRouter([
      {
        match: "product_id=p1",
        status: 200,
        body: {
          recommendations: Array.from({ length: 8 }, (_, i) => ({
            productId: `c${i}`,
            sku: `SKU${i}`,
            title: `Item ${i}`,
            confidence: 0.9 - i * 0.05,
          })),
        },
      },
    ]);

    const result = await handler({ product_ids: ["p1"], limit: 99 });
    const text = result.content[0].text as string;
    const json = JSON.parse((text.match(/```json\n([\s\S]*?)\n```/) ?? [])[1]);
    // coerceLimit clamps 99 -> 6.
    expect(json.suggestions).toHaveLength(6);
  });

  it("renders a graceful no-suggestions message when nothing pairs", async () => {
    mockRouter([{ match: "product_id=", status: 200, body: { recommendations: [] } }]);
    const result = await handler({ product_ids: ["p1", "p2"] });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/No kit-completion suggestions for the cart \[p1, p2\]/);
  });

  it("chunks a cart larger than 6 items (exercises the chunking path)", async () => {
    // 7 cart items forces a second chunk. Every item recommends c1.
    mockRouter([
      { match: "product_id=", status: 200, body: { recommendations: [{ productId: "c1", sku: "C1", title: "Common", confidence: 0.5 }] } },
    ]);
    const cart = ["a", "b", "c", "d", "e", "f", "g"];
    const result = await handler({ product_ids: cart });
    const text = result.content[0].text as string;
    const json = JSON.parse((text.match(/```json\n([\s\S]*?)\n```/) ?? [])[1]);
    expect(json.suggestions[0].productId).toBe("c1");
    // c1 paired with all 7 cart items.
    expect(json.suggestions[0].pairs_with).toBe(7);
    expect(json.cart).toHaveLength(7);
  });
});
