import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./triageOpportunity.js";

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

describe("triage_opportunity handler", () => {
  beforeEach(() => setApiContext(VALID_CTX));
  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({
      opportunity_id: "o1",
      action: "activate",
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("requires confirm=true", async () => {
    const result = await handler({ opportunity_id: "o1", action: "activate" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/confirm=true/);
  });

  it("rejects an unknown action", async () => {
    const result = await handler({
      opportunity_id: "o1",
      action: "delete",
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/action must be one of/);
  });

  it("POSTs to the action endpoint with url-encoded id", async () => {
    const fetchSpy = mockOnce(200, { id: "o1", status: "activated" });
    const result = await handler({
      opportunity_id: "o1",
      action: "activate",
      confirm: true,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/activated/);
    const url = fetchSpy.mock.calls[0][0] as URL;
    expect(url.pathname).toBe("/api/v1/opportunities/o1/action");
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("surfaces a sanitized 500 error message", async () => {
    mockOnce(500, { error: "internal" });
    const result = await handler({
      opportunity_id: "o1",
      action: "activate",
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA API 500/);
  }, 10_000);
});
