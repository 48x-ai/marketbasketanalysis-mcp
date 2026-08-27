import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./getWeeklyPlan.js";

/**
 * Integration test for get_weekly_plan. Mirrors the pattern used by
 * findSubstitutes.test.ts: mock fetch, exercise the handler end-to-end
 * including zod boundary validation.
 */
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

describe("get_weekly_plan handler", () => {
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

  it("renders a numbered action list on a successful response", async () => {
    mockOnce(200, {
      week_start: "2026-06-01",
      generated_at: "2026-06-01T00:00:00Z",
      actions: [
        {
          id: "a1",
          type: "publish_opportunity",
          title: "Publish the gym backpack + water bottle bundle",
          priority: "high",
          estimated_impact_usd: 1240.5,
        },
        {
          id: "a2",
          type: "reorder_inventory",
          title: "Reorder bundle X",
          priority: "medium",
        },
      ],
    });
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/Weekly plan \(2 actions\)/);
    expect(text).toMatch(/\[high\]/);
    expect(text).toMatch(/gym backpack/);
    expect(text).toMatch(/est\. impact: \$1241/);
    expect(text).toMatch(/```json/);
  });

  it("surfaces a sanitized 500 error message", async () => {
    mockOnce(500, { error: "internal", trace_id: "trace-xyz" });
    const result = await handler({});
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/MBA API 500/);
    expect(text).not.toMatch(/trace-xyz/);
  }, 10_000);
});
