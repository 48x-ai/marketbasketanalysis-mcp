import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./getForecastAlerts.js";

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

describe("get_forecast_alerts handler", () => {
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

  it("renders the alert list on success", async () => {
    const fetchSpy = mockOnce(200, {
      alerts: [
        {
          id: "f1",
          bundle_id: "b1",
          bundle_title: "Camera Starter Kit",
          kind: "stockout_risk",
          severity: "high",
          weeks_of_stock: 1.2,
          current_inventory: 4,
        },
      ],
    });
    const result = await handler({ kind: "stockout_risk", severity: "high" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/1 forecast alert/);
    expect(text).toMatch(/Camera Starter Kit: stockout_risk/);
    expect(text).toMatch(/weeks_of_stock=1\.2/);
    const url = fetchSpy.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/api/v1/forecast-alerts");
    expect(url.searchParams.get("kind")).toBe("stockout_risk");
    expect(url.searchParams.get("severity")).toBe("high");
  });

  it("surfaces a sanitized 500 error message", async () => {
    mockOnce(500, { error: "internal" });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA API 500/);
  }, 10_000);
});
