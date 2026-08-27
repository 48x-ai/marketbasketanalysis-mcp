import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./forecastBundle.js";

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

describe("forecast_bundle handler", () => {
  beforeEach(() => setApiContext(VALID_CTX));
  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ bundle_id: "b1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("requires bundle_id", async () => {
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/bundle_id is required/);
  });

  it("renders forecast + buy-quantity recommendation on success", async () => {
    const fetchSpy = mockOnce(200, {
      bundleId: "b1",
      forecastWeeks: [
        { weekStart: "2026-06-08", point_estimate: 12.4, p10: 8, p90: 17 },
        { weekStart: "2026-06-15", point_estimate: 13.1, p10: 8, p90: 18 },
      ],
      recommendation: { buy_quantity: 96, safety_stock_weeks: 2 },
      reliable: true,
      warnings: [],
    });
    const result = await handler({ bundle_id: "b1", horizon_weeks: 8 });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/Forecast for bundle b1 over 2 week\(s\)/);
    expect(text).toMatch(/Recommended buy quantity: 96/);
    expect(text).toMatch(/safety stock/);
    const url = fetchSpy.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/api/v1/forecast/bundle-inventory");
    expect(url.searchParams.get("bundleId")).toBe("b1");
    // The tool's horizon_weeks is in WEEKS; the backend horizon param
    // is in DAYS. 8 weeks must reach the endpoint as 56 days.
    expect(url.searchParams.get("horizon")).toBe("56");
  });

  it("converts the weeks horizon to days for the backend", async () => {
    const fetchSpy = mockOnce(200, {
      bundleId: "b1",
      forecastWeeks: [],
      reliable: true,
      warnings: [],
    });
    await handler({ bundle_id: "b1", horizon_weeks: 12 });
    const url = fetchSpy.mock.calls[0][0] as URL;
    // 12 weeks -> 84 days.
    expect(url.searchParams.get("horizon")).toBe("84");
  });

  it("defaults to an 8 week (56 day) horizon when none is given", async () => {
    const fetchSpy = mockOnce(200, {
      bundleId: "b1",
      forecastWeeks: [],
      reliable: true,
      warnings: [],
    });
    await handler({ bundle_id: "b1" });
    const url = fetchSpy.mock.calls[0][0] as URL;
    expect(url.searchParams.get("horizon")).toBe("56");
  });

  it("surfaces a sanitized 500 error message", async () => {
    mockOnce(500, { error: "internal" });
    const result = await handler({ bundle_id: "b1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA API 500/);
  }, 10_000);
});
