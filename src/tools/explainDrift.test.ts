import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./explainDrift.js";

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

describe("explain_drift handler", () => {
  beforeEach(() => setApiContext(VALID_CTX));
  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ alert_id: "a1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("errors when alert_id is missing", async () => {
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/alert_id is required/);
  });

  it("renders the templated narrative for a weakened alert", async () => {
    const fetchSpy = mockOnce(200, {
      alert_id: "a1",
      rule_id: "r1",
      antecedent: "SKU-A",
      consequent: "SKU-B",
      direction: "weakened",
      prior_confidence: 0.8,
      current_confidence: 0.4,
      support: 0.06,
      lift: 3.4,
      sample_count: 12,
      severity: "high",
      detected_at: "2026-06-20T00:00:00.000Z",
      narrative:
        "The pair Gym Backpack plus Water Bottle weakens: confidence moves from 80% to 40% " +
        "versus the prior mining run. It currently fires on 12 orders.",
    });
    const result = await handler({ alert_id: "a1" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/weakens: confidence moves from 80% to 40%/);
    expect(text).toMatch(/Structured JSON/);
    const url = fetchSpy.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/api/v1/explain-drift");
    expect(url.searchParams.get("alert_id")).toBe("a1");
  });

  it("renders a disappeared alert with null support/lift/sample", async () => {
    mockOnce(200, {
      alert_id: "a2",
      rule_id: null,
      antecedent: "SKU-E",
      consequent: "SKU-F",
      direction: "disappeared",
      prior_confidence: 0.7,
      current_confidence: null,
      support: null,
      lift: null,
      sample_count: null,
      severity: "low",
      detected_at: "2026-06-18T00:00:00.000Z",
      narrative:
        "The pair SKU-E plus SKU-F stops co-occurring: it held 70% confidence in the prior " +
        "mining run and no longer clears the threshold.",
    });
    const result = await handler({ alert_id: "a2" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/stops co-occurring/);
  });

  it("surfaces a graceful upstream 404 on platforms without the route", async () => {
    mockOnce(404, { error: "Not Found" });
    const result = await handler({ alert_id: "a1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA API 404/);
  });

  it("surfaces a sanitized 500 error message", async () => {
    mockOnce(500, { error: "internal" });
    const result = await handler({ alert_id: "a1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA API 500/);
  }, 10_000);
});
