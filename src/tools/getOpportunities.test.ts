import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./getOpportunities.js";

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

describe("get_opportunities handler", () => {
  beforeEach(() => setApiContext(VALID_CTX));
  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("renders the opportunity list on success", async () => {
    const fetchSpy = mockOnce(200, {
      opportunities: [
        {
          id: "o1",
          rule_id: "r1",
          antecedent_title: "Gym Backpack",
          consequent_title: "Water Bottle",
          confidence: 0.42,
          lift: 2.1,
          status: "proposed",
        },
      ],
      total: 1,
    });
    const result = await handler({ status: "proposed", limit: 10 });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/1 proposed opportunity/);
    expect(text).toMatch(/Gym Backpack -> Water Bottle/);
    const url = fetchSpy.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/api/v1/opportunities");
    expect(url.searchParams.get("status")).toBe("proposed");
  });

  it("surfaces a sanitized 500 error message", async () => {
    mockOnce(500, { error: "internal" });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA API 500/);
  }, 10_000);
});
