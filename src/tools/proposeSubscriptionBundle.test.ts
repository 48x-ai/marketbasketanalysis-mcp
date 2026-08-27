import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler, definition } from "./proposeSubscriptionBundle.js";

/**
 * Integration test for propose_subscription_bundle. Exercises the
 * fan-out across /recommendations + /accounts/:id/reorder-predictions,
 * the graceful 404 fallback for customers we don't have history for,
 * and the proposal shape the agent receives back.
 */

const VALID_CTX = { apiKey: "k", apiBase: "https://app.marketbasketanalysis.com" };

/**
 * Stateful fetch mock that routes requests by URL pathname. Each
 * call site registers handlers keyed by a substring match against
 * the URL. Returning undefined falls through to the default empty
 * response. This is more readable than the in-order array mock for
 * tests where the order of recommendations/predictions calls is an
 * implementation detail we don't want to lock in.
 */
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

describe("propose_subscription_bundle definition", () => {
  it("surfaces subscription-intent phrasings for agent routing", () => {
    expect(definition.name).toBe("propose_subscription_bundle");
    // The tool router (LLM) picks tools by description match. The
    // task spec requires these phrasings show up verbatim so an
    // agent prompted "what should they subscribe to?" routes here.
    expect(definition.description).toContain("recurring subscription bundle");
    expect(definition.description).toContain("subscription bundle");
    expect(definition.description).toContain("what should they subscribe to");
    expect(definition.description).toContain("monthly subscription bundle");
  });
});

describe("propose_subscription_bundle handler", () => {
  beforeEach(() => {
    setApiContext(VALID_CTX);
  });

  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ seed_product_ids: ["p1"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("rejects empty seed list", async () => {
    const result = await handler({ seed_product_ids: [] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at least one product/);
  });

  it("rejects more than 5 seeds", async () => {
    const result = await handler({ seed_product_ids: ["a", "b", "c", "d", "e", "f"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/at most 5/);
  });

  it("proposes a kit from seeds + complements with no customer_id", async () => {
    mockRouter([
      {
        match: "product_id=p1",
        status: 200,
        body: {
          recommendations: [
            { productId: "c1", sku: "FILTER", title: "Coffee Filter", confidence: 0.8 },
            { productId: "c2", sku: "BEANS", title: "Beans 1lb", confidence: 0.7 },
          ],
        },
      },
      {
        match: "product_id=p2",
        status: 200,
        body: {
          recommendations: [
            { productId: "c1", sku: "FILTER", title: "Coffee Filter", confidence: 0.75 },
            { productId: "c3", sku: "MILK", title: "Oat Milk", confidence: 0.5 },
          ],
        },
      },
    ]);

    const result = await handler({
      seed_product_ids: ["p1", "p2"],
      kit_size: 4,
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    // The complement that pairs with BOTH seeds (FILTER) should win
    // the ranking and appear in the kit.
    expect(text).toMatch(/Coffee Filter/);
    expect(text).toMatch(/Subscription kit proposal/);
    expect(text).toMatch(/```json/);
    // Cadence falls back to default (30d) when no customer history.
    expect(text).toMatch(/cadence 30d/);
  });

  it("blends in customer reorder predictions when customer_id is supplied", async () => {
    mockRouter([
      {
        match: "product_id=p1",
        status: 200,
        body: {
          recommendations: [
            { productId: "c1", sku: "FILTER", title: "Filter", confidence: 0.8 },
          ],
        },
      },
      {
        match: "reorder-predictions",
        status: 200,
        body: {
          customerId: "cust123",
          totalOrders: 8,
          windowOrders: 8,
          predictions: [
            {
              productId: "p1",
              sku: "BEANS",
              title: "Beans",
              totalOrders: 4,
              lastOrderedAt: "2026-05-01T00:00:00Z",
              meanIntervalDays: 28,
              stdevDays: 3,
              predictedNextAt: "2026-05-29T00:00:00Z",
              daysUntilPredicted: 0,
              confidence: 0.9,
              status: "due_soon",
            },
            {
              productId: "c1",
              sku: "FILTER",
              title: "Filter",
              totalOrders: 3,
              lastOrderedAt: "2026-05-01T00:00:00Z",
              meanIntervalDays: 30,
              stdevDays: 4,
              predictedNextAt: "2026-05-31T00:00:00Z",
              daysUntilPredicted: 2,
              confidence: 0.85,
              status: "on_track",
            },
          ],
        },
      },
    ]);

    const result = await handler({
      seed_product_ids: ["p1"],
      customer_id: "cust123",
      kit_size: 3,
    });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    // Cadence should now reflect the customer's actual rhythm
    // (median of 28 and 30 = 29). Round-to-int in the proposal.
    expect(text).toMatch(/cadence_days":\s*29/);
    // Customer history hit rate signal surfaces in the rationale.
    expect(text).toMatch(/reorder cadence|customer/i);
  });

  it("falls back to seed-only analysis on a 404 reorder-predictions response", async () => {
    mockRouter([
      {
        match: "product_id=p1",
        status: 200,
        body: {
          recommendations: [
            { productId: "c1", sku: "FILTER", title: "Filter", confidence: 0.6 },
          ],
        },
      },
      {
        match: "reorder-predictions",
        status: 404,
        body: { error: "not_found" },
      },
    ]);

    const result = await handler({
      seed_product_ids: ["p1"],
      customer_id: "cust-without-history",
    });
    // 404 is graceful: tool still returns a proposal, just without
    // the customer-history signal blended in.
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/Subscription kit proposal/);
    expect(text).toMatch(/customer_predictions_available":\s*0/);
  });

  it("computes monthly_value when prices are present on the recommendations", async () => {
    mockRouter([
      {
        match: "product_id=p1",
        status: 200,
        body: {
          recommendations: [
            {
              productId: "c1",
              sku: "FILTER",
              title: "Filter",
              confidence: 0.8,
              price: 12.5,
              currency: "USD",
            },
          ],
        },
      },
    ]);

    const result = await handler({
      seed_product_ids: ["p1"],
      cadence_days: 30,
      kit_size: 3,
    });
    const text = result.content[0].text as string;
    // 30d cadence + a single $12.50 complement = $12.50/month.
    // (The seed itself has no known price in this mock; that's OK,
    // monthly_value just reflects the items with known prices.)
    expect(text).toMatch(/monthly_value":\s*12\.5/);
    expect(text).toMatch(/"currency":\s*"USD"/);
  });
});
