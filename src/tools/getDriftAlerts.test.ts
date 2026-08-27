import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./getDriftAlerts.js";

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

describe("get_drift_alerts handler", () => {
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
          id: "d1",
          antecedent: "Backpack",
          consequent: "Water Bottle",
          direction: "weakened",
          prior_confidence: 0.62,
          current_confidence: 0.31,
          severity: "high",
        },
      ],
    });
    const result = await handler({ severity: "high", limit: 10 });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/1 drift alert/);
    expect(text).toMatch(/\[high\]/);
    expect(text).toMatch(/Backpack -> Water Bottle: weakened/);
    expect(text).toMatch(/62% -> 31%/);
    const url = fetchSpy.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/api/v1/drift-alerts");
    expect(url.searchParams.get("severity")).toBe("high");
  });

  it("surfaces a sanitized 500 error message", async () => {
    mockOnce(500, { error: "internal" });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA API 500/);
  }, 10_000);
});
