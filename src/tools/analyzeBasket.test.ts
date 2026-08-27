import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler, definition } from "./analyzeBasket.js";

/**
 * Integration test for the analyze_basket tool handler.
 *
 * Exercises the cohesion fan-out: /recommendations is fetched for each
 * basket item, every ordered pair is scored via the shared cohesion
 * lib, and the verdict + JSON block render to the agent. We assert the
 * size guards, the cohesion math, and the verdict thresholds.
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

describe("analyze_basket definition", () => {
  it("surfaces bundle-vetting phrasings for agent routing", () => {
    expect(definition.name).toBe("analyze_basket");
    expect(definition.description).toContain("cohesion");
    expect(definition.description).toContain("do these products go together?");
  });
});

describe("analyze_basket handler", () => {
  beforeEach(() => {
    setApiContext(VALID_CTX);
  });

  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ product_ids: ["a", "b"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("rejects a basket with fewer than 2 products", async () => {
    const result = await handler({ product_ids: ["a"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at least 2 products/);
  });

  it("rejects a basket of blank strings as too small", async () => {
    const result = await handler({ product_ids: ["", "  "] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at least 2 products/);
  });

  it("rejects a basket larger than 6 products", async () => {
    const result = await handler({ product_ids: ["a", "b", "c", "d", "e", "f", "g"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/capped at 6 products/);
  });

  it("reports strong cohesion when all pairs cross-recommend", async () => {
    // a recommends b, b recommends a: both ordered pairs match at
    // 0.5 confidence. coverage 1.0 * avgConfidence 0.5 = 0.5 -> strong.
    mockRouter([
      {
        match: "product_id=a",
        status: 200,
        body: { recommendations: [{ productId: "b", sku: "B", title: "Bee", confidence: 0.5 }] },
      },
      {
        match: "product_id=b",
        status: 200,
        body: { recommendations: [{ productId: "a", sku: "A", title: "Ay", confidence: 0.5 }] },
      },
    ]);

    const result = await handler({ product_ids: ["a", "b"] });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/good bundle candidate/);
    expect(text).toMatch(/Pairs matched: 2 \/ 2/);
    const json = JSON.parse((text.match(/```json\n([\s\S]*?)\n```/) ?? [])[1]);
    expect(json.cohesion).toBeCloseTo(0.5, 5);
    expect(json.coverage).toBe(1);
    expect(json.matched_pairs).toBe(2);
    expect(json.total_pairs).toBe(2);
    expect(json.pair_scores).toHaveLength(2);
  });

  it("reports weak / no cohesion when no pair matches", async () => {
    // Neither item recommends the other: coverage 0 -> cohesion 0.
    mockRouter([{ match: "product_id=", status: 200, body: { recommendations: [] } }]);
    const result = await handler({ product_ids: ["a", "b"] });
    const text = result.content[0].text as string;
    expect(text).toMatch(/weak \/ no cohesion/);
    const json = JSON.parse((text.match(/```json\n([\s\S]*?)\n```/) ?? [])[1]);
    expect(json.cohesion).toBe(0);
    expect(json.matched_pairs).toBe(0);
    expect(json.total_pairs).toBe(2);
  });

  it("reports moderate cohesion when only some pairs match", async () => {
    // 3-item basket -> 6 ordered pairs. Only a->b matches at 0.6.
    // coverage 1/6 * avgConfidence 0.6 = 0.1 -> below 0.15 = weak.
    // Make two pairs match to land in [0.15, 0.4): a->b and b->a at
    // 0.9 each -> coverage 2/6=0.333 * 0.9 = 0.3 -> moderate.
    mockRouter([
      {
        match: "product_id=a",
        status: 200,
        body: { recommendations: [{ productId: "b", sku: "B", title: "Bee", confidence: 0.9 }] },
      },
      {
        match: "product_id=b",
        status: 200,
        body: { recommendations: [{ productId: "a", sku: "A", title: "Ay", confidence: 0.9 }] },
      },
      { match: "product_id=c", status: 200, body: { recommendations: [] } },
    ]);

    const result = await handler({ product_ids: ["a", "b", "c"] });
    const text = result.content[0].text as string;
    expect(text).toMatch(/moderate cohesion/);
    const json = JSON.parse((text.match(/```json\n([\s\S]*?)\n```/) ?? [])[1]);
    expect(json.total_pairs).toBe(6);
    expect(json.matched_pairs).toBe(2);
    expect(json.cohesion).toBeGreaterThanOrEqual(0.15);
    expect(json.cohesion).toBeLessThan(0.4);
  });
});
