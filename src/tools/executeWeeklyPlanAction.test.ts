import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler } from "./executeWeeklyPlanAction.js";

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

describe("execute_weekly_plan_action handler", () => {
  beforeEach(() => setApiContext(VALID_CTX));
  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ action_id: "a1", confirm: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("refuses to dispatch without confirm=true", async () => {
    const result = await handler({ action_id: "a1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/confirm=true/);
  });

  it("POSTs to the execute endpoint when confirm=true", async () => {
    const fetchSpy = mockOnce(200, { action_id: "a1", status: "queued" });
    const result = await handler({ action_id: "a1", confirm: true });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/queued/);
    const call = fetchSpy.mock.calls[0];
    expect((call[0] as URL).pathname).toBe("/api/v1/weekly-plan/execute");
    expect((call[1] as RequestInit).method).toBe("POST");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.action_id).toBe("a1");
  });

  it("surfaces a sanitized upstream 500 with no body leak", async () => {
    mockOnce(500, { error: "internal", trace_id: "trace-xyz" });
    const result = await handler({ action_id: "a1", confirm: true });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/MBA API 500/);
    expect(text).not.toMatch(/trace-xyz/);
  }, 10_000);
});
