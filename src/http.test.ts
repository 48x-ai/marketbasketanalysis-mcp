/**
 * Tests for the hosted streamable-HTTP entrypoint.
 *
 * Covers the request-scope header contract (auth parsing, the
 * X-MBA-Base allowlist, platform validation) and the end-to-end HTTP
 * surface against a real listener on an ephemeral port: health,
 * initialize, unauthenticated tools/list (registry crawlers), the
 * missing-key reply on unauthenticated tools/call, and the 405s.
 * Actual upstream API behavior is covered by the per-tool tests; no
 * network leaves the process here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

// The global test setup replaces fetch with a loud-fail spy in a
// beforeEach so unit tests cannot reach the network. These e2e cases
// talk ONLY to the in-process listener on 127.0.0.1, so bind the real
// fetch at module load, before any hook installs the spy.
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);
import { createApp, scopeFromHeaders, SERVER_VERSION } from "./http.js";

const MCP_ACCEPT = "application/json, text/event-stream";

describe("scopeFromHeaders", () => {
  it("yields a null scope when no Authorization header is present", () => {
    const r = scopeFromHeaders({});
    expect(r).toEqual({ ok: true, scope: null });
  });

  it("parses a Bearer key and defaults the base", () => {
    const r = scopeFromHeaders({ authorization: "Bearer mba_live_abc123" });
    expect(r).toEqual({
      ok: true,
      scope: {
        apiKey: "mba_live_abc123",
        apiBase: "https://app.marketbasketanalysis.com",
        platform: undefined,
      },
    });
  });

  it("rejects non-Bearer Authorization schemes", () => {
    const r = scopeFromHeaders({ authorization: "Basic dXNlcjpwdw==" });
    expect(r.ok).toBe(false);
  });

  it("accepts the X-MBA-Key alternate header (Smithery gateway)", () => {
    const r = scopeFromHeaders({ "x-mba-key": "mba_live_alt123" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope?.apiKey).toBe("mba_live_alt123");
  });

  it("forgives a pasted Bearer prefix in X-MBA-Key and prefers Authorization when both exist", () => {
    const pasted = scopeFromHeaders({ "x-mba-key": "Bearer mba_live_pasted" });
    expect(pasted.ok).toBe(true);
    if (pasted.ok) expect(pasted.scope?.apiKey).toBe("mba_live_pasted");

    const both = scopeFromHeaders({
      authorization: "Bearer mba_live_primary",
      "x-mba-key": "mba_live_secondary",
    });
    expect(both.ok).toBe(true);
    if (both.ok) expect(both.scope?.apiKey).toBe("mba_live_primary");
  });

  it("accepts an allowlisted X-MBA-Base", () => {
    const r = scopeFromHeaders({
      authorization: "Bearer k",
      "x-mba-base": "https://bigcommerce.marketbasketanalysis.com",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope?.apiBase).toBe("https://bigcommerce.marketbasketanalysis.com");
  });

  it("rejects a non-allowlisted X-MBA-Base and points at stdio", () => {
    const r = scopeFromHeaders({
      authorization: "Bearer k",
      "x-mba-base": "https://evil.example.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("stdio");
  });

  it("rejects an http X-MBA-Base", () => {
    const r = scopeFromHeaders({
      authorization: "Bearer k",
      "x-mba-base": "http://app.marketbasketanalysis.com",
    });
    expect(r.ok).toBe(false);
  });

  it("validates X-MBA-Platform against the known set", () => {
    const good = scopeFromHeaders({
      authorization: "Bearer k",
      "x-mba-platform": "WooCommerce",
    });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.scope?.platform).toBe("woocommerce");

    const bad = scopeFromHeaders({
      authorization: "Bearer k",
      "x-mba-platform": "squarespace",
    });
    expect(bad.ok).toBe(false);
  });
});

describe("hosted HTTP surface", () => {
  const app = createApp();
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const addr = app.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      app.close((e) => (e ? reject(e) : resolve())),
    );
  });

  function rpc(body: unknown, headers: Record<string, string> = {}) {
    return realFetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: MCP_ACCEPT,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it("serves /healthz with version and tool count", async () => {
    const res = await realFetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe(SERVER_VERSION);
    expect(body.tools).toBe(19);
  });

  it("answers initialize without auth", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("marketbasketanalysis");
    expect(body.result.serverInfo.version).toBe(SERVER_VERSION);
  });

  it("lists all 19 tools without auth (directory crawlers)", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools).toHaveLength(19);
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_recommendations");
  });

  it("returns the missing-key reply on unauthenticated tools/call", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_recommendations", arguments: { product_id: "1" } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Authorization: Bearer");
  });

  it("rejects a bad X-MBA-Base before reaching the transport", async () => {
    const res = await rpc(
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      { authorization: "Bearer k", "x-mba-base": "https://evil.example.com" },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("MBA-operated");
  });

  it("405s GET and DELETE on /mcp (stateless: no SSE stream, no session)", async () => {
    const get = await realFetch(`${base}/mcp`, { headers: { accept: MCP_ACCEPT } });
    expect(get.status).toBe(405);
    const del = await realFetch(`${base}/mcp`, { method: "DELETE" });
    expect(del.status).toBe(405);
  });

  it("404s unknown routes", async () => {
    const res = await realFetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("hides OAuth protected-resource metadata without MCP_OAUTH_ISSUER", async () => {
    const res = await realFetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(404);
  });

  it("serves RFC 9728 metadata and 401s unauth tools/call when the issuer is set", async () => {
    process.env.MCP_OAUTH_ISSUER = "https://app.marketbasketanalysis.com";
    try {
      const prm = await realFetch(`${base}/.well-known/oauth-protected-resource`);
      expect(prm.status).toBe(200);
      const meta = await prm.json();
      expect(meta.authorization_servers).toEqual(["https://app.marketbasketanalysis.com"]);
      expect(meta.resource).toBe("https://mcp.marketbasketanalysis.com/mcp");

      // tools/list stays open for crawlers even with OAuth on.
      const list = await rpc({ jsonrpc: "2.0", id: 20, method: "tools/list" });
      expect(list.status).toBe(200);

      // Unauthenticated tools/call flips to the spec's 401 + discovery header.
      const call = await rpc({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "get_recommendations", arguments: { product_id: "1" } },
      });
      expect(call.status).toBe(401);
      expect(call.headers.get("www-authenticate")).toContain(
        "/.well-known/oauth-protected-resource",
      );
    } finally {
      delete process.env.MCP_OAUTH_ISSUER;
    }
  });
});
