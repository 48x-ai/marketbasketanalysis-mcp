import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./explainOpportunity.js";

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

describe("explain_opportunity handler", () => {
  beforeEach(() => setApiContext(VALID_CTX));
  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ opportunity_id: "op1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("errors when opportunity_id is missing", async () => {
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/opportunity_id is required/);
  });

  it("renders the templated narrative on success", async () => {
    const fetchSpy = mockOnce(200, {
      opportunity_id: "op1",
      rule_id: "r1",
      antecedent_title: "Gym Backpack",
      consequent_title: "Water Bottle",
      support: 0.05,
      confidence: 0.42,
      lift: 2.1,
      sample_count: 37,
      narrative:
        "Customers who buy Gym Backpack also buy Water Bottle in 37 of their orders " +
        "(confidence 42%, lift 2.1x). This pair appears in 5% of all orders.",
    });
    const result = await handler({ opportunity_id: "op1" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/Customers who buy Gym Backpack also buy Water Bottle in 37 of their orders/);
    expect(text).toMatch(/Structured JSON/);
    const url = fetchSpy.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/api/v1/explain-opportunity");
    expect(url.searchParams.get("opportunity_id")).toBe("op1");
  });

  it("surfaces a graceful upstream 404 on platforms without the route", async () => {
    mockOnce(404, { error: "Not Found" });
    const result = await handler({ opportunity_id: "op1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA API 404/);
  });

  it("surfaces a sanitized 500 error message", async () => {
    mockOnce(500, { error: "internal" });
    const result = await handler({ opportunity_id: "op1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA API 500/);
  }, 10_000);
});
