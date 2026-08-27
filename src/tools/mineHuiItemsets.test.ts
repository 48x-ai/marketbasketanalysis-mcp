import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./mineHuiItemsets.js";

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

const SAMPLE_ORDERS = [
  {
    order_id: "ord-1",
    items: [
      { sku: "A", quantity: 1, unit_profit: 5 },
      { sku: "B", quantity: 1, unit_profit: 3 },
    ],
  },
  {
    order_id: "ord-2",
    items: [
      { sku: "A", quantity: 2, unit_profit: 5 },
      { sku: "C", quantity: 1, unit_profit: 1 },
    ],
  },
];

describe("mine_hui_itemsets handler", () => {
  beforeEach(() => setApiContext(VALID_CTX));
  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ orders: SAMPLE_ORDERS });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("rejects empty / missing orders payload", async () => {
    const result = await handler({ orders: [] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/non-empty array/);
  });

  it("renders the top itemsets on a sync success", async () => {
    const fetchSpy = mockOnce(200, {
      itemsets: [
        { items: ["A", "B"], utility: 13.0, occurrence_count: 1 },
        { items: ["A", "C"], utility: 11.0, occurrence_count: 1 },
      ],
    });
    const result = await handler({ orders: SAMPLE_ORDERS, top_k: 5 });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/Top 2 high-utility itemsets/);
    expect(text).toMatch(/\[A, B\] utility=13\.00/);
    const url = fetchSpy.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/api/v1/hosted/hui-mine");
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("surfaces the async-job hint when the backend returns a jobId only", async () => {
    mockOnce(200, { jobId: "job-42", status: "queued" });
    const result = await handler({ orders: SAMPLE_ORDERS });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/jobId: job-42/);
    expect(result.content[0].text).toMatch(/async job/);
  });

  it("surfaces a sanitized upstream error", async () => {
    mockOnce(402, { error: "tier_required" });
    const result = await handler({ orders: SAMPLE_ORDERS });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA API 402/);
    expect(result.content[0].text).not.toMatch(/tier_required/);
  }, 10_000);
});
