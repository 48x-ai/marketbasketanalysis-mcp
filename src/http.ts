#!/usr/bin/env node
/**
 * Hosted streamable-HTTP entrypoint for the MarketBasketAnalysis MCP
 * server: the same 19-tool registry as the stdio entry (src/index.ts),
 * served at POST /mcp for remote MCP clients (Smithery, claude.ai
 * custom connectors, `claude mcp add --transport http`, cursor, etc.).
 *
 * Deployment: Fly app `marketbasketanalysis-mcp`, public hostname
 * https://mcp.marketbasketanalysis.com/mcp.
 *
 * Auth model (mirrors the paid REST API, this is a thin adapter over
 * it): every tool call needs the merchant's per-store API key sent as
 * `Authorization: Bearer mba_live_...` on each request. Unauthenticated
 * requests can still initialize and list tools, so registry crawlers
 * and directory scorecards see the full toolset, but every tools/call
 * without a key returns the standard missing-key reply. The key is
 * never logged and never stored here; it is forwarded upstream exactly
 * once per tool call.
 *
 * Multi-tenancy: stateless server-per-request. Each POST builds a
 * fresh Server + StreamableHTTPServerTransport pair (no session ids),
 * and the tool dispatch runs inside runWithRequestScope() so
 * concurrent requests with different keys cannot bleed into each
 * other. See lib/api.ts for the AsyncLocalStorage plumbing.
 *
 * Base-URL policy: unlike the stdio entry (where MBA_API_BASE is the
 * operator's own machine-local config), this is a PUBLIC endpoint, so
 * an arbitrary X-MBA-Base would turn it into an open proxy that
 * forwards callers' bearer keys to any URL they name. The override is
 * therefore allowlisted to the MBA-operated planes. Self-hosted
 * WooCommerce / Magento merchants should run the npm package locally
 * over stdio instead, pointed at their own site.
 */

import { realpathSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { capture, distinctIdForKey } from "./lib/analytics.js";
import {
  missingKeyReply,
  runWithRequestScope,
  setServerMode,
  type RequestScope,
} from "./lib/api.js";
import { initSentry } from "./lib/sentry.js";
import { dispatch, toolDefinitions } from "./tools/index.js";

export const SERVER_VERSION = "0.7.0";

const PORT = Number(process.env.PORT ?? 8080);

/** Max accepted JSON-RPC request body. Tool argument payloads are tiny. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Hosts the X-MBA-Base override may point at. Keyed by hostname; the
 * override must be https and carry no credentials. localhost is
 * accepted only with ALLOW_LOCAL_API_BASE=1 (dev).
 */
const BASE_ALLOWLIST = new Set([
  "app.marketbasketanalysis.com",
  "bigcommerce.marketbasketanalysis.com",
  "marketbasketanalysis-shopify.fly.dev",
  "marketbasketanalysis-bigcommerce.fly.dev",
]);

const DEFAULT_BASE = "https://app.marketbasketanalysis.com";

const PLATFORMS = new Set([
  "shopify",
  "bigcommerce",
  "woocommerce",
  "magento",
  "orocommerce",
]);

/**
 * OAuth resource-server wiring (docs/integration/mcp-oauth.md in the
 * monorepo). When MCP_OAUTH_ISSUER names the authorization server
 * (the hosted backend, which validates the tokens this endpoint
 * forwards), two things switch on:
 *
 *   - GET /.well-known/oauth-protected-resource answers with RFC 9728
 *     metadata pointing clients at the issuer (else 404: dark).
 *   - Unauthenticated tools/call answers HTTP 401 with a
 *     WWW-Authenticate header naming that metadata, which is the
 *     signal OAuth-capable MCP clients (claude.ai, ChatGPT) use to
 *     start the flow. initialize and tools/list stay open either way
 *     so directory crawlers keep working.
 *
 * Tokens themselves are never validated here; they forward upstream
 * exactly like mba_live_ keys and the backend's guard decides.
 */
function oauthIssuer(): string | null {
  const raw = process.env.MCP_OAUTH_ISSUER?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

const RESOURCE_URL = "https://mcp.marketbasketanalysis.com/mcp";

function protectedResourceMetadata(issuer: string): Record<string, unknown> {
  return {
    resource: RESOURCE_URL,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email", "offline_access", "mba:api"],
    resource_name: "MarketBasketAnalysis MCP server",
    resource_documentation: "https://www.marketbasketanalysis.com/docs/mcp",
  };
}

function wwwAuthenticateValue(): string {
  const base = RESOURCE_URL.replace(/\/mcp$/, "");
  return `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
}

/** Result of validating a request's MBA headers. */
type ScopeResult =
  | { ok: true; scope: RequestScope | null }
  | { ok: false; error: string };

/**
 * Builds the per-request scope from headers. A missing Authorization
 * header is NOT an error here (tools/list must work unauthenticated);
 * it yields a null scope and tools/call answers with the standard
 * missing-key reply. Malformed overrides ARE errors, surfaced as
 * JSON-RPC error responses before any server is built.
 */
export function scopeFromHeaders(headers: IncomingMessage["headers"]): ScopeResult {
  const auth = headers.authorization;
  let apiKey: string | null = null;
  if (auth !== undefined) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (!m) {
      return {
        ok: false,
        error: "Authorization header must be: Bearer <mba api key>",
      };
    }
    apiKey = m[1].trim();
  }

  // Alternate credential channel for gateways that forward a plain
  // named header instead of Authorization (Smithery's connection
  // config emits `X-MBA-Key: <key>`). Authorization wins when both
  // are present. A pasted "Bearer " prefix is forgiven.
  if (apiKey === null) {
    const alt = headers["x-mba-key"];
    if (typeof alt === "string" && alt.trim() !== "") {
      apiKey = alt.trim().replace(/^Bearer\s+/i, "");
    }
  }

  let apiBase = DEFAULT_BASE;
  const baseHeader = headers["x-mba-base"];
  if (typeof baseHeader === "string" && baseHeader.trim() !== "") {
    let parsed: URL;
    try {
      parsed = new URL(baseHeader.trim());
    } catch {
      return { ok: false, error: "X-MBA-Base is not a valid URL" };
    }
    const host = parsed.hostname.toLowerCase();
    const isLocalDev =
      process.env.ALLOW_LOCAL_API_BASE === "1" &&
      (host === "localhost" || host === "127.0.0.1");
    if (!isLocalDev) {
      if (parsed.protocol !== "https:") {
        return { ok: false, error: "X-MBA-Base must be https" };
      }
      if (!BASE_ALLOWLIST.has(host)) {
        return {
          ok: false,
          error:
            "X-MBA-Base must point at an MBA-operated backend " +
            "(app.marketbasketanalysis.com or bigcommerce.marketbasketanalysis.com). " +
            "Self-hosted WooCommerce and Magento stores: run the npm package " +
            "(npx -y @marketbasketanalysis/mcp) locally over stdio with MBA_API_BASE instead.",
        };
      }
    }
    apiBase = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  }

  let platform: string | undefined;
  const platformHeader = headers["x-mba-platform"];
  if (typeof platformHeader === "string" && platformHeader.trim() !== "") {
    const candidate = platformHeader.trim().toLowerCase();
    if (!PLATFORMS.has(candidate)) {
      return {
        ok: false,
        error: `X-MBA-Platform must be one of: ${[...PLATFORMS].join(", ")}`,
      };
    }
    platform = candidate;
  }

  if (apiKey === null) return { ok: true, scope: null };
  return { ok: true, scope: { apiKey, apiBase, platform } };
}

/**
 * One MCP server wired for one request. `scope` is null when the
 * request carried no key; tools stay listed, calls return the
 * missing-key reply.
 */
export function buildServer(scope: RequestScope | null): Server {
  const server = new Server(
    { name: "marketbasketanalysis", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (!scope) return missingKeyReply();
    return runWithRequestScope(scope, () => dispatch(request.params.name, args));
  });
  return server;
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, X-MBA-Base, X-MBA-Platform",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** JSON-RPC-shaped error for failures before a transport exists. */
function sendRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Pulls the analytics-relevant shape out of a JSON-RPC request body
 * without trusting it: method, tool name for tools/call, client
 * name/version for initialize. Tool arguments are deliberately NOT
 * extracted (they can contain merchant data).
 */
export function describeRpc(body: unknown): {
  rpcMethod: string | null;
  tool: string | null;
  clientName: string | null;
  clientVersion: string | null;
} {
  const first = Array.isArray(body) ? body[0] : body;
  if (typeof first !== "object" || first === null) {
    return { rpcMethod: null, tool: null, clientName: null, clientVersion: null };
  }
  const msg = first as Record<string, unknown>;
  const rpcMethod = typeof msg.method === "string" ? msg.method : null;
  const params =
    typeof msg.params === "object" && msg.params !== null
      ? (msg.params as Record<string, unknown>)
      : {};
  const tool =
    rpcMethod === "tools/call" && typeof params.name === "string" ? params.name : null;
  const clientInfo =
    typeof params.clientInfo === "object" && params.clientInfo !== null
      ? (params.clientInfo as Record<string, unknown>)
      : {};
  return {
    rpcMethod,
    tool,
    clientName:
      rpcMethod === "initialize" && typeof clientInfo.name === "string"
        ? clientInfo.name
        : null,
    clientVersion:
      rpcMethod === "initialize" && typeof clientInfo.version === "string"
        ? clientInfo.version
        : null,
  };
}

async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const scopeResult = scopeFromHeaders(req.headers);
  if (!scopeResult.ok) {
    sendRpcError(res, 400, scopeResult.error);
    return;
  }

  let parsedBody: unknown;
  try {
    const raw = await readBody(req);
    parsedBody = raw === "" ? undefined : JSON.parse(raw);
  } catch (e) {
    sendRpcError(
      res,
      e instanceof Error && e.message === "body too large" ? 413 : 400,
      "Request body must be JSON",
    );
    return;
  }

  // Analytics: one mcp_request event per POST, fired when the
  // response finishes so it carries the final status + duration.
  // Fire-and-forget; never blocks or fails the request.
  const rpc = describeRpc(parsedBody);
  const scope = scopeResult.scope;

  // OAuth discovery: with an issuer configured, an unauthenticated
  // tools/call gets the spec's HTTP 401 + WWW-Authenticate so
  // OAuth-capable clients start the flow. Crawler-relevant methods
  // (initialize, tools/list) stay open, and without an issuer the
  // legacy 200-with-isError behavior is preserved.
  const issuer = oauthIssuer();
  if (issuer && scope === null && rpc.rpcMethod === "tools/call") {
    res.setHeader("WWW-Authenticate", wwwAuthenticateValue());
    res.once("finish", () => {
      capture("mcp_request", "anon", {
        rpc_method: rpc.rpcMethod,
        tool: rpc.tool,
        client_name: rpc.clientName,
        client_version: rpc.clientVersion,
        authenticated: false,
        platform: null,
        status: 401,
        duration_ms: Date.now() - started,
      });
    });
    sendRpcError(res, 401, "Authentication required. Complete the OAuth flow or send an mba_live_ API key as a bearer token.");
    return;
  }
  res.once("finish", () => {
    capture("mcp_request", distinctIdForKey(scope?.apiKey ?? null), {
      rpc_method: rpc.rpcMethod,
      tool: rpc.tool,
      client_name: rpc.clientName,
      client_version: rpc.clientVersion,
      authenticated: scope !== null,
      platform: scope?.platform ?? null,
      status: res.statusCode,
      duration_ms: Date.now() - started,
    });
  });

  // Stateless: fresh server + transport per request, torn down when
  // the response closes. sessionIdGenerator: undefined disables
  // session tracking entirely; enableJsonResponse gives plain JSON
  // replies (no SSE) since no server-initiated messages are used.
  const server = buildServer(scopeResult.scope);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

export function createApp() {
  // Anything serving HTTP is in http mode; set here rather than in
  // main() so embedders and tests that build the app directly get
  // the HTTP-appropriate operator messages too.
  setServerMode("http");
  return createHttpServer((req, res) => {
    const started = Date.now();
    setCorsHeaders(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname.replace(/\/+$/, "") || "/";

    res.on("finish", () => {
      // One structured line per request. Never log headers: the
      // Authorization value is a live credential.
      console.error(
        `[mba-mcp-http] ${req.method} ${route} -> ${res.statusCode} ${Date.now() - started}ms`,
      );
    });

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (route === "/healthz") {
      sendJson(res, 200, { status: "ok", version: SERVER_VERSION, tools: toolDefinitions.length });
      return;
    }
    if (
      route === "/.well-known/oauth-protected-resource" ||
      route === "/.well-known/oauth-protected-resource/mcp"
    ) {
      const issuer = oauthIssuer();
      if (!issuer) {
        sendJson(res, 404, { error: "oauth not enabled" });
        return;
      }
      sendJson(res, 200, protectedResourceMetadata(issuer));
      return;
    }
    if (route === "/" && req.method === "GET") {
      // A human (or crawler) looking at the landing text, not an MCP
      // client. /healthz is deliberately not captured: Fly probes it
      // every 30s and would drown the signal.
      capture("mcp_landing_view", "anon", {
        user_agent: req.headers["user-agent"] ?? null,
      });
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(
        `MarketBasketAnalysis MCP server ${SERVER_VERSION}\n\n` +
          `MCP endpoint (streamable HTTP): POST /mcp\n` +
          `Auth: Authorization: Bearer mba_live_... (mint in your MBA admin, API keys page)\n` +
          `Tools: ${toolDefinitions.length}\n` +
          `Docs: https://www.marketbasketanalysis.com/docs/mcp\n` +
          `Local/stdio install: npx -y @marketbasketanalysis/mcp\n`,
      );
      return;
    }
    if (route === "/mcp" && req.method === "POST") {
      void handleMcpPost(req, res).catch((e) => {
        console.error(`[mba-mcp-http] unhandled: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        if (!res.headersSent) sendRpcError(res, 500, "Internal error");
        else res.end();
      });
      return;
    }
    if (route === "/mcp") {
      // Stateless mode: no SSE stream to GET, no session to DELETE.
      res.writeHead(405, { allow: "POST, OPTIONS" });
      res.end();
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
}

function main(): void {
  initSentry();
  const app = createApp();
  app.listen(PORT, "0.0.0.0", () => {
    console.error(
      `[mba-mcp-http] listening on :${PORT}; ${toolDefinitions.length} tools registered; ` +
        `default upstream ${DEFAULT_BASE}`,
    );
  });
  const shutdown = () => {
    app.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only start listening when run as the entrypoint, so tests can
// import createApp()/scopeFromHeaders()/buildServer() without side
// effects. realpath both sides: npm bin shims are symlinks, so a bare
// argv[1] comparison would miss `npx mba-mcp-http`.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
