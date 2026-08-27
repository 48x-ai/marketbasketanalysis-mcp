import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setApiContext } from "../lib/api.js";
import { handler, definition } from "./scoreCrossSell.js";

/**
 * Integration test for the score_cross_sell tool handler.
 *
 * Exercises the single-fetch lookup: /recommendations for product_a,
 * then a find for product_b by productId OR sku. Covers the
 * has_signal=false (no rule) branch, the strength thresholds
 * (weak/moderate/strong), the sku-match path, the a===b guard, and
 * the sanitized upstream-error branch.
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

describe("score_cross_sell definition", () => {
  it("surfaces pair-validation phrasings for agent routing", () => {
    expect(definition.name).toBe("score_cross_sell");
    expect(definition.description).toContain("is X a good cross-sell for Y?");
  });
});

describe("score_cross_sell handler", () => {
  beforeEach(() => {
    setApiContext(VALID_CTX);
  });

  afterEach(() => {
    setApiContext(null);
    vi.restoreAllMocks();
  });

  it("returns missingKeyReply when apiContext is null", async () => {
    setApiContext(null);
    const result = await handler({ product_a: "a", product_b: "b" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MBA_API_KEY/);
  });

  it("rejects when either product is missing", async () => {
    const result = await handler({ product_a: "a", product_b: "" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/both required/);
  });

  it("rejects when product_a equals product_b", async () => {
    const result = await handler({ product_a: "x", product_b: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be different products/);
  });

  it("reports no signal when product_b is not in a's recommendations", async () => {
    mockOnce(200, {
      recommendations: [{ productId: "other", sku: "OTHER", title: "Other", confidence: 0.9 }],
    });
    const result = await handler({ product_a: "a", product_b: "b" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toMatch(/No qualifying co-purchase rule/);
    const json = JSON.parse((text.match(/```json\n([\s\S]*?)\n```/) ?? [])[1]);
    expect(json.has_signal).toBe(false);
    expect(json.product_a).toBe("a");
    expect(json.product_b).toBe("b");
  });

  it("reports strong strength for a high-confidence matched pair", async () => {
    mockOnce(200, {
      recommendations: [{ productId: "b", sku: "BEE", title: "Bee", confidence: 0.75 }],
    });
    const result = await handler({ product_a: "a", product_b: "b" });
    const text = result.content[0].text as string;
    expect(text).toMatch(/\*\*strong\*\*/);
    expect(text).toMatch(/75%/);
    const json = JSON.parse((text.match(/```json\n([\s\S]*?)\n```/) ?? [])[1]);
    expect(json.has_signal).toBe(true);
    expect(json.confidence).toBe(0.75);
    expect(json.strength).toBe("strong");
    expect(json.product_b_sku).toBe("BEE");
  });

  it("classifies a mid-confidence pair as moderate", async () => {
    mockOnce(200, {
      recommendations: [{ productId: "b", sku: "BEE", title: "Bee", confidence: 0.45 }],
    });
    const result = await handler({ product_a: "a", product_b: "b" });
    const json = JSON.parse(
      ((result.content[0].text as string).match(/```json\n([\s\S]*?)\n```/) ?? [])[1],
    );
    expect(json.strength).toBe("moderate");
  });

  it("classifies a low-confidence pair as weak", async () => {
    mockOnce(200, {
      recommendations: [{ productId: "b", sku: "BEE", title: "Bee", confidence: 0.1 }],
    });
    const result = await handler({ product_a: "a", product_b: "b" });
    const json = JSON.parse(
      ((result.content[0].text as string).match(/```json\n([\s\S]*?)\n```/) ?? [])[1],
    );
    expect(json.strength).toBe("weak");
  });

  it("matches product_b by SKU, not just productId", async () => {
    // product_b is given as a SKU string; the rec's productId differs
    // but its sku matches.
    mockOnce(200, {
      recommendations: [{ productId: "gid://123", sku: "WIDGET-9", title: "Widget", confidence: 0.5 }],
    });
    const result = await handler({ product_a: "a", product_b: "WIDGET-9" });
    const text = result.content[0].text as string;
    const json = JSON.parse((text.match(/```json\n([\s\S]*?)\n```/) ?? [])[1]);
    expect(json.has_signal).toBe(true);
    expect(json.product_b_sku).toBe("WIDGET-9");
  });

  it("surfaces a sanitized 500 upstream error (no raw body leaked)", async () => {
    // 500 is retried then thrown as ApiError("MBA API 500"); the
    // handler maps it into the catch branch. Body must not leak.
    mockOnce(500, { error: "boom", trace: "internal-stack-with-secret-token" });
    const result = await handler({ product_a: "a", product_b: "b" });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    expect(text).toMatch(/MBA API 500/);
    expect(text).not.toMatch(/internal-stack-with-secret-token/);
  });
});
