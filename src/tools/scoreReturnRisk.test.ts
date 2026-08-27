import { describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./scoreReturnRisk.js";

/**
 * Integration test for the score_return_risk tool handler. The
 * handler composes apiContext + getReturnRiskForBundle + a
 * composite-risk classifier into the agent-readable
 * `{content, isError}` reply shape.
 *
 * The lib/api helper makes one /recommendations call per product
 * id; we mock the fetch sequence to feed return-rate data per call.
 */

interface MockResponse {
  status: number;
  body: unknown;
}

function mockFetchSequence(responses: MockResponse[]) {
  let i = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response;
  });
}

const CTX = { apiKey: "k", apiBase: "https://app.marketbasketanalysis.com" };

describe("score_return_risk handler", () => {
  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ product_ids: ["a", "b"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("rejects fewer than 2 distinct ids", async () => {
    setApiContext(CTX);
    const result = await handler({ product_ids: ["a"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at least 2/i);
    setApiContext(null);
  });

  it("rejects more than 6 ids", async () => {
    setApiContext(CTX);
    const result = await handler({
      product_ids: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at most 6/i);
    setApiContext(null);
  });

  it("rejects non-array product_ids", async () => {
    setApiContext(CTX);
    const result = await handler({ product_ids: "p1,p2" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be an array/i);
    setApiContext(null);
  });

  it("classifies a bundle as LOW when all items have low return rates", async () => {
    setApiContext(CTX);
    // Two products; each recommendations call returns the other
    // with a low returnRate.
    mockFetchSequence([
      {
        status: 200,
        body: {
          recommendations: [
            { productId: "b", sku: "B", title: "Item B", confidence: 0.8, returnRate: 0.05, returnedCount: 2 },
          ],
        },
      },
      {
        status: 200,
        body: {
          recommendations: [
            { productId: "a", sku: "A", title: "Item A", confidence: 0.8, returnRate: 0.04, returnedCount: 1 },
          ],
        },
      },
    ]);
    const result = await handler({ product_ids: ["a", "b"] });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/LOW/);
    expect(text).toMatch(/Safe to ship/i);
    expect(text).toMatch(/```json/);
    setApiContext(null);
  });

  it("classifies a bundle as HIGH when any item has a return rate above 25%", async () => {
    setApiContext(CTX);
    // The high-return item ("a") is observable only because it appears
    // as a consequent in "b"'s recommendation list. Each consequent's
    // returnRate describes THAT consequent, so:
    //   - fetch for "a" returns "b" (b's own rate, 0.06)
    //   - fetch for "b" returns "a" (a's own rate, 0.42)
    mockFetchSequence([
      {
        status: 200,
        body: {
          recommendations: [
            { productId: "b", sku: "B", title: "T-Shirt", confidence: 0.8, returnRate: 0.06, returnedCount: 3 },
          ],
        },
      },
      {
        status: 200,
        body: {
          recommendations: [
            { productId: "a", sku: "A", title: "Skinny Jeans", confidence: 0.8, returnRate: 0.42, returnedCount: 21 },
          ],
        },
      },
    ]);
    const result = await handler({ product_ids: ["a", "b"] });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/HIGH/);
    // The 42% return rate belongs to product "a" (Skinny Jeans). The
    // pre-fix code swapped attribution, reporting "a"'s line with the
    // rate/title pulled off the recommended PEER, so it would have
    // attributed the 0.42 to id "b" and 0.06 to id "a". Assert the
    // rate lands on the RIGHT product's per-item line so this fails
    // on the old swap.
    expect(text).toMatch(/Skinny Jeans \(id: a\): 42\.0% \(high\)/);
    expect(text).toMatch(/T-Shirt \(id: b\): 6\.0% \(low\)/);
    setApiContext(null);
  });

  it("attributes each item's OWN return rate, not a recommended peer's (swap regression)", async () => {
    setApiContext(CTX);
    // Three-item bundle where each item's own return rate is distinct
    // and observable only via a SIBLING's recommendation list:
    //   a's own rate = 0.30  (a appears as a consequent of b)
    //   b's own rate = 0.05  (b appears as a consequent of a)
    //   c's own rate = 0.18  (c appears as a consequent of a)
    // The pre-fix code reported, for each queried product, the rate of
    // a recommended PEER, mismatching id<->rate. Asserting per-line
    // attribution catches that.
    mockFetchSequence([
      {
        // fetch for "a" -> its consequents are b (0.05) and c (0.18)
        status: 200,
        body: {
          recommendations: [
            { productId: "b", sku: "B", title: "Belt", confidence: 0.8, returnRate: 0.05, returnedCount: 2 },
            { productId: "c", sku: "C", title: "Cap", confidence: 0.7, returnRate: 0.18, returnedCount: 9 },
          ],
        },
      },
      {
        // fetch for "b" -> its consequent is a (0.30)
        status: 200,
        body: {
          recommendations: [
            { productId: "a", sku: "A", title: "Anorak", confidence: 0.8, returnRate: 0.30, returnedCount: 15 },
          ],
        },
      },
      {
        // fetch for "c" -> no return-aware consequent here; c's own
        // rate still comes from a's list above.
        status: 200,
        body: {
          recommendations: [
            { productId: "z", sku: "Z", title: "Zip Hoodie", confidence: 0.6 },
          ],
        },
      },
    ]);
    const result = await handler({ product_ids: ["a", "b", "c"] });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    // Each id must carry its OWN rate and OWN title.
    expect(text).toMatch(/Anorak \(id: a\): 30\.0% \(high\)/);
    expect(text).toMatch(/Belt \(id: b\): 5\.0% \(low\)/);
    expect(text).toMatch(/Cap \(id: c\): 18\.0% \(medium\)/);
    // Composite is the max OWN rate (a, 30%) -> HIGH bundle.
    expect(text).toMatch(/HIGH/);
    expect(text).toMatch(/composite 30\.0%/);
    setApiContext(null);
  });

  it("renders 'data not available' when no returnRate fields are present (backend not shipped yet)", async () => {
    setApiContext(CTX);
    mockFetchSequence([
      {
        status: 200,
        body: {
          recommendations: [
            { productId: "b", sku: "B", title: "Item B", confidence: 0.8 },
          ],
        },
      },
      {
        status: 200,
        body: {
          recommendations: [
            { productId: "a", sku: "A", title: "Item A", confidence: 0.8 },
          ],
        },
      },
    ]);
    const result = await handler({ product_ids: ["a", "b"] });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/UNKNOWN/);
    expect(text).toMatch(/data not available/i);
    expect(text).toMatch(/fresh mining job/i);
    setApiContext(null);
  });

  it("de-duplicates repeated product ids in the input", async () => {
    setApiContext(CTX);
    mockFetchSequence([
      {
        status: 200,
        body: {
          recommendations: [
            { productId: "b", sku: "B", title: "Item B", confidence: 0.8, returnRate: 0.08, returnedCount: 4 },
          ],
        },
      },
      {
        status: 200,
        body: {
          recommendations: [
            { productId: "a", sku: "A", title: "Item A", confidence: 0.8, returnRate: 0.07, returnedCount: 3 },
          ],
        },
      },
    ]);
    const result = await handler({ product_ids: ["a", "a", "b"] });
    expect(result.isError).toBeUndefined();
    // Bundle should be reported as size 2 (de-duped), not size 3.
    const text = result.content[0].text as string;
    expect(text).toMatch(/bundle of 2 products/i);
    setApiContext(null);
  });
});
