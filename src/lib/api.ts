/**
 * Thin HTTP client for the MBA hosted recommendations API.
 *
 * All tools route through this so they share auth, error handling,
 * the API-base override, SSRF protection on the base URL, request
 * timeouts, and consistent retry-on-429. Direct fetch() in tool code
 * would force each one to re-derive these, that's how the API base
 * ends up inconsistent six months from now.
 *
 * Env-var changes (MBA_API_KEY, MBA_API_BASE, ALLOW_LOCAL_API_BASE)
 * take effect only at server startup. The resolved context is cached
 * in `apiContext` (set once by src/index.ts) and consumed directly by
 * every tool handler. A merchant who rotates their key or moves their
 * base URL must restart the MCP server (typically by restarting their
 * MCP host) to pick up the new value, this is intentional so a
 * mid-session key removal can't go silently unnoticed.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { getReorderPredictions, type ReorderPrediction } from "./accounts.js";

/**
 * Fallback API base used only when MBA_API_BASE is unset.
 *
 * This points at the shared hosted backend. The base URL is
 * per-deployment / per-store configuration: a merchant running on a
 * non-default host (a BigCommerce store, a self-hosted backend, or a
 * staging instance) MUST set MBA_API_BASE in their MCP host `env`
 * block so requests reach their own data plane rather than this
 * default. Every tool routes through apiContext.apiBase, so setting
 * the env var is the single switch that re-points the whole server.
 */
const DEFAULT_API_BASE = "https://app.marketbasketanalysis.com";

/**
 * Per-request timeout. The MCP host is waiting for our reply; a
 * hung upstream connection should fail fast rather than block the
 * agent indefinitely.
 */
const REQUEST_TIMEOUT_MS = 15_000;

// Schemas + types for upstream payloads. Validated at the boundary
// (apiGet) so a malformed upstream response can't silently propagate
// `undefined` fields into tool replies.

const RecommendationSchema = z.object({
  productId: z.string(),
  sku: z.string(),
  title: z.string().nullable(),
  vendor: z.string().nullable().optional(),
  productType: z.string().nullable().optional(),
  confidence: z.number(),
  // Return-aware mining fields. Optional because older mining jobs
  // (pre return-aware PR) didn't emit these, and the tool needs to
  // degrade gracefully rather than reject the whole response.
  returnRate: z.number().nullable().optional(),
  returnedCount: z.number().nullable().optional(),
  // Inventory + price enrichment, populated when the backend has
  // hydrated catalog data on this product. Optional so older API
  // responses (pre task #162) still validate cleanly. Used by
  // propose_subscription_bundle to compute monthly_value.
  price: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
});

const RecommendationsResponseSchema = z.object({
  recommendations: z.array(RecommendationSchema).optional(),
  model_version: z.string().optional(),
  shop_id: z.string().optional(),
  error: z.string().optional(),
});

const SubstitutionSchema = z.object({
  productId: z.string(),
  sku: z.string(),
  title: z.string().nullable(),
  vendor: z.string().nullable().optional(),
  productType: z.string().nullable().optional(),
  score: z.number(),
  reason: z.enum(["context_similar", "category_match", "vendor_match"]),
  signals: z
    .object({
      contextOverlap: z.number().optional(),
      coOccurrence: z.number().optional(),
      sameProductType: z.boolean().optional(),
      sameVendor: z.boolean().optional(),
    })
    .optional(),
});

const SubstitutionsResponseSchema = z.object({
  substitutions: z.array(SubstitutionSchema).optional(),
  error: z.string().optional(),
});

export type Recommendation = z.infer<typeof RecommendationSchema>;
export type RecommendationsResponse = z.infer<typeof RecommendationsResponseSchema>;
export type Substitution = z.infer<typeof SubstitutionSchema>;
export type SubstitutionsResponse = z.infer<typeof SubstitutionsResponseSchema>;

export {
  RecommendationSchema,
  RecommendationsResponseSchema,
  SubstitutionSchema,
  SubstitutionsResponseSchema,
};

export interface ApiContext {
  apiKey: string;
  apiBase: string;
}

/**
 * Cached, server-startup-resolved API context. Set once by
 * src/index.ts via setApiContext(). All tool handlers consume this
 * via `apiContext` directly, bypassing the per-call readContext()
 * indirection. Null when no API key is configured at startup.
 */
export let apiContext: ApiContext | null = null;

export function setApiContext(ctx: ApiContext | null): void {
  apiContext = ctx;
}

/**
 * Per-request context for the hosted HTTP transport.
 *
 * The stdio transport serves ONE merchant per process, so a
 * startup-resolved singleton (`apiContext` above) is correct there.
 * The hosted HTTP transport serves MANY merchants from one process,
 * with the key arriving on each request's Authorization header, so
 * the singleton would race across concurrent requests. Request
 * handling runs inside `runWithRequestScope()` and every consumer
 * reads through `activeContext()` / `currentPlatform()`, which
 * prefer the request scope and fall back to the stdio singleton.
 * The stdio path never enters a scope, so its behavior is unchanged.
 */
export interface RequestScope {
  apiKey: string;
  apiBase: string;
  /** Platform override for path mapping; same values as MBA_PLATFORM. */
  platform?: string;
}

const requestScope = new AsyncLocalStorage<RequestScope>();

export function runWithRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return requestScope.run(scope, fn);
}

/**
 * The context tool handlers must use: the current request's scope on
 * the hosted HTTP transport, or the startup singleton on stdio.
 * Null when neither is configured (no MBA_API_KEY at startup and no
 * Authorization header on the request).
 */
export function activeContext(): ApiContext | null {
  const scoped = requestScope.getStore();
  if (scoped) return { apiKey: scoped.apiKey, apiBase: scoped.apiBase };
  return apiContext;
}

/**
 * Which transport this process serves. Set once by the entrypoint;
 * only used to word operator-facing error messages (env var vs
 * Authorization header), never to change tool behavior.
 */
let serverMode: "stdio" | "http" = "stdio";

export function setServerMode(mode: "stdio" | "http"): void {
  serverMode = mode;
}

/**
 * Validates that a user-supplied MBA_API_BASE points at a real public
 * HTTP(S) endpoint, not a loopback / link-local / metadata-service
 * URL.
 *
 * The merchant configures this base via env var in their MCP host
 * config. A misconfigured or malicious value could otherwise point
 * at:
 *   - 127.0.0.1 / ::1  -> hits the MCP host's localhost services
 *   - 169.254.169.254  -> AWS / GCP / Azure metadata service
 *   - file://, gopher://, etc. -> unintended protocols
 *
 * fetch() honors all of those by default; we reject them here so an
 * agent-facing SSRF surface doesn't exist.
 *
 * In development, localhost / 127.0.0.1 over http is allowed via
 * the ALLOW_LOCAL_API_BASE escape hatch so MCP authors can iterate
 * against a local instance of the hosted backend.
 */
function assertSafeApiBase(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`MBA_API_BASE is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `MBA_API_BASE must be http(s); got protocol "${parsed.protocol}"`,
    );
  }
  const allowLocal = process.env.ALLOW_LOCAL_API_BASE === "1";
  // WHATWG URL ALWAYS BRACKETS IPv6 LITERALS. `new URL("https://[::1]/").hostname`
  // is the string "[::1]", never "::1". Every IPv6 comparison below used to test
  // the bare form, so none of them could ever match and the whole IPv6 half of
  // this guard was dead code: `MBA_API_BASE=https://[::1]/` sailed through, and
  // the merchant's live `mba_live_` bearer key was then sent to that address on
  // every tool call. MBA_API_BASE is a documented merchant-facing setting (a form
  // field in smithery.yaml, an env var in README.md), so this was reachable by a
  // bad setup snippet, not just by self-sabotage.
  const rawHost = parsed.hostname.toLowerCase();
  const host = normalizeHost(rawHost);
  // Dev escape hatch: when ALLOW_LOCAL_API_BASE=1, permit the loopback
  // hosts (over http or https) so MCP authors can iterate against a
  // local instance of the hosted backend. The host is already known to
  // be one of these three, so no further protocol gate applies, the
  // whole point of the hatch is to allow plain http://localhost.
  if (allowLocal && (host === "localhost" || host === "127.0.0.1" || host === "::1")) {
    return;
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `MBA_API_BASE must be https for non-local hosts; got ${parsed.protocol}//${host}`,
    );
  }
  // Block IPv4 loopback / link-local / private / metadata service.
  // We rely on hostname matching rather than DNS resolution so this
  // stays cheap; merchants typically point at app.marketbasketanalysis.com
  // or their own *.fly.dev / *.up.railway.app, all of which resolve
  // to public IPs.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1, 5).map((s) => Number(s));
    if (a === 127) {
      throw new Error(`MBA_API_BASE points at loopback (${host}); refusing`);
    }
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw new Error(`MBA_API_BASE points at private network (${host}); refusing`);
    }
    if (a === 169 && b === 254) {
      throw new Error(`MBA_API_BASE points at link-local / metadata (${host}); refusing`);
    }
    if (a === 0) {
      throw new Error(`MBA_API_BASE points at 0.0.0.0-range (${host}); refusing`);
    }
  }
  if (host === "localhost") {
    throw new Error(`MBA_API_BASE points at loopback (${rawHost}); refusing`);
  }
  assertSafeIpv6(host, rawHost);
}

/**
 * Strip the brackets WHATWG URL puts around IPv6 literals, and unwrap the
 * IPv4-mapped form so `[::ffff:127.0.0.1]` is checked by the IPv4 rules rather
 * than sliding past both sets.
 */
function normalizeHost(hostname: string): string {
  const unbracketed = hostname.replace(/^\[|\]$/g, "");

  // Dotted IPv4-mapped form, e.g. ::ffff:127.0.0.1
  const dotted = unbracketed.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
  );
  if (dotted) return dotted[1]!;

  // HEX IPv4-mapped form. This is the one that actually shows up: WHATWG URL
  // REWRITES `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a dotted-only match
  // never fires on a parsed URL and `::ffff:7f00:1` slipped past both the IPv4
  // and IPv6 rules. Groups may be 1 to 4 hex digits, so pad before decoding.
  const hex = unbracketed.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const n = (g: string) => parseInt(g.padStart(4, "0"), 16);
    const hi = n(hex[1]!);
    const lo = n(hex[2]!);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
  }

  return unbracketed;
}

/**
 * Reject the IPv6 ranges that reach infrastructure rather than the public
 * internet. Only runs for things that actually parse as IPv6, so ordinary
 * hostnames fall straight through.
 */
function assertSafeIpv6(host: string, rawHost: string): void {
  if (!host.includes(":")) return;

  const refuse = (why: string): never => {
    throw new Error(`MBA_API_BASE points at ${why} (${rawHost}); refusing`);
  };

  // Drop any zone index, e.g. fe80::1%eth0.
  const addr = host.split("%")[0]!;

  if (addr === "::1") refuse("loopback");
  if (addr === "::" || addr === "::0") refuse("the unspecified address");

  const head = addr.split(":")[0] ?? "";
  // fe80::/10 link-local, which on cloud hosts reaches the metadata service.
  if (/^fe[89ab]/.test(head)) refuse("link-local / metadata");
  // fc00::/7 unique-local, the IPv6 equivalent of RFC1918.
  if (/^f[cd]/.test(head)) refuse("private network");
}

/**
 * Resolves credentials from env vars. Returns null when the API key
 * isn't configured so the tool handlers can return a helpful error
 * message instead of crashing.
 *
 * Side effect: validates MBA_API_BASE against the SSRF allow-list
 * the first time it's resolved. If the base URL is unsafe we throw
 * here so the failure is loud + early, not a confusing
 * permission-denied later.
 *
 * NOTE: called ONCE at server startup from src/index.ts, not per
 * request. See the module-level doc comment for why.
 */
export function readContext(): ApiContext | null {
  const apiKey = process.env.MBA_API_KEY?.trim();
  if (!apiKey) return null;
  const apiBase = process.env.MBA_API_BASE?.trim() || DEFAULT_API_BASE;
  assertSafeApiBase(apiBase);
  return { apiKey, apiBase };
}

/**
 * Joins a path against the configured apiBase, preserving any
 * subpath the merchant set on apiBase (e.g. an `/api/` prefix when
 * the MBA backend is mounted under a reverse-proxy subpath).
 *
 * Bare `new URL(path, apiBase)` clobbers apiBase's path entirely
 * because `path` starts with "/". We want
 *   apiBase=https://host/v2  +  path=/api/v1/recs
 *   -> https://host/v2/api/v1/recs   (not https://host/api/v1/recs)
 *
 * Query params are still applied via URLSearchParams.
 */
/**
 * Per-platform path resolution.
 *
 * Tool files write the canonical hosted-plane path (`/api/v1/...`).
 * Shopify, BigCommerce, and OroCommerce are served by that plane and use
 * it verbatim. WooCommerce and Magento run the backend inside the store
 * and mount it on their own framework's REST conventions, so the same
 * endpoint lives at a different path:
 *
 *   canonical                          woocommerce                                    magento
 *   /api/v1/recommendations            /wp-json/marketbasketanalysis/v1/recommendations   /V1/marketbasketanalysis/recommendations
 *   /api/v1/substitutions              .../substitutions                              /V1/marketbasketanalysis/substitutions
 *   /api/v1/rationale                  .../rationale                                  /V1/mba/rationale
 *   /api/v1/forecast/bundle-inventory  .../forecast/bundle-inventory                  /V1/marketbasketanalysis/forecast/bundle-inventory
 *   /api/v1/accounts/:id/reorder-...   .../customers/:id/reorder-predictions          /V1/marketbasketanalysis/customers/:id/reorder-predictions
 *
 * Verified against `packages/woocommerce/includes/Rest/*` (NAMESPACE
 * `marketbasketanalysis/v1`, plus each controller's ROUTE const) and
 * `packages/magento/etc/webapi.xml`.
 *
 * Endpoints absent from the map on a given platform genuinely do not
 * exist there (the merchant-ops surface: opportunities, weekly plan,
 * drift, explain-*, triage, hosted HUI mining). Those resolve to `null`
 * so the caller can return a clear "not available on this platform"
 * message rather than letting an opaque upstream 404 reach the agent.
 */
const CANONICAL_PREFIX = "/api/v1";

const WOO_ROOT = "/wp-json/marketbasketanalysis/v1";
const MAGENTO_ROOT = "/V1/marketbasketanalysis";

const PLATFORM_PATHS: Record<string, Record<string, string>> = {
  woocommerce: {
    recommendations: `${WOO_ROOT}/recommendations`,
    substitutions: `${WOO_ROOT}/substitutions`,
    rationale: `${WOO_ROOT}/rationale`,
    "forecast/bundle-inventory": `${WOO_ROOT}/forecast/bundle-inventory`,
    // Prefix mapping: the canonical plane says "accounts", both
    // self-hosted platforms say "customers". The id and the trailing
    // segment carry over unchanged.
    accounts: `${WOO_ROOT}/customers`,
  },
  magento: {
    recommendations: `${MAGENTO_ROOT}/recommendations`,
    substitutions: `${MAGENTO_ROOT}/substitutions`,
    // Magento serves rationale from its /V1/mba namespace, not
    // /V1/marketbasketanalysis. Confirmed in etc/webapi.xml.
    rationale: "/V1/mba/rationale",
    "forecast/bundle-inventory": `${MAGENTO_ROOT}/forecast/bundle-inventory`,
    accounts: `${MAGENTO_ROOT}/customers`,
  },
};

/** Platforms whose backend is the store itself rather than the hosted plane. */
const SELF_HOSTED_PLATFORMS = new Set(Object.keys(PLATFORM_PATHS));

/**
 * Reads the platform at call time so tests can stub it per case.
 * Hosted HTTP requests carry it in the request scope (X-MBA-Platform
 * header); stdio reads the MBA_PLATFORM env var.
 */
function currentPlatform(): string {
  const scoped = requestScope.getStore();
  if (scoped?.platform !== undefined) return scoped.platform.trim().toLowerCase();
  return (process.env.MBA_PLATFORM ?? "").trim().toLowerCase();
}

/**
 * Maps a canonical path onto the configured platform.
 *
 * Returns the path to call, or `null` when the endpoint does not exist on
 * that platform. Paths that are already platform-specific (the
 * reorder-predictions path, resolved in lib/accounts.ts) pass through
 * untouched because they do not carry the canonical prefix.
 */
export function resolvePlatformPath(path: string): string | null {
  const platform = currentPlatform();
  if (!SELF_HOSTED_PLATFORMS.has(platform)) return path;
  if (!path.startsWith(`${CANONICAL_PREFIX}/`)) return path;

  const endpoint = path.slice(CANONICAL_PREFIX.length + 1);
  const table = PLATFORM_PATHS[platform];
  if (!table) return path;

  // Exact match first, then the longest registered prefix so paths with
  // an embedded id (none today, but the shape is supported) still map.
  if (table[endpoint]) return table[endpoint];
  for (const [key, mapped] of Object.entries(table)) {
    if (endpoint.startsWith(`${key}/`)) {
      return mapped + endpoint.slice(key.length);
    }
  }
  return null;
}

/** Thrown when a tool's endpoint has no equivalent on the configured platform. */
export class UnsupportedOnPlatformError extends Error {
  constructor(path: string, platform: string) {
    super(
      `This tool calls ${path}, which the ${platform} backend does not serve. ` +
        `The merchant-ops endpoints (opportunities, weekly plan, drift and forecast alerts, ` +
        `opportunity triage, hosted HUI mining) exist only on the MBA hosted backend used by ` +
        `Shopify, BigCommerce, and OroCommerce.`,
    );
    this.name = "UnsupportedOnPlatformError";
  }
}

function buildUrl(apiBase: string, path: string, params: Record<string, string | number>): URL {
  const resolved = resolvePlatformPath(path);
  if (resolved === null) throw new UnsupportedOnPlatformError(path, currentPlatform());
  const trimmedBase = apiBase.replace(/\/+$/, "");
  const trimmedPath = resolved.startsWith("/") ? resolved : `/${resolved}`;
  const url = new URL(trimmedBase + trimmedPath);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  return url;
}

/**
 * Wraps fetch with auth, a request timeout, and retry on transient
 * failures. The hosted backend returns 429 on rate-limit; we honor
 * Retry-After but cap at 3 attempts so the MCP host doesn't sit
 * waiting forever.
 *
 * Errors thrown carry a STATIC, SANITIZED message, see ApiError
 * below. The full upstream body is logged to stderr but never
 * surfaced to the MCP host, since upstream 401/403/429 bodies have
 * been observed to include rate-limit headers, request IDs, and
 * occasionally the request's Authorization header.
 *
 * Response payloads are validated at the boundary against an
 * optional zod schema. On schema mismatch we throw
 * `ApiError(kind: "validation")` with a sanitized message so a
 * malformed upstream payload can't silently corrupt downstream
 * tool output.
 */
export async function apiGet<T>(
  ctx: ApiContext,
  path: string,
  params: Record<string, string | number> = {},
  schema?: z.ZodType<T>,
): Promise<T> {
  const url = buildUrl(ctx.apiBase, path, params);

  let attempt = 0;
  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${ctx.apiKey}` },
        signal: controller.signal,
      });
    } catch (e) {
      // Either the abort fired (timeout) or the network failed.
      // We retry on retryable network errors with the same 3-attempt
      // cap as 429s.
      if (attempt < 3 && isRetryableNetworkError(e)) {
        await backoffSleep(attempt);
        continue;
      }
      throw new ApiError(0, "network", e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const json = await response.json();
      if (schema) {
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          if (process.env.MBA_DEBUG_ERRORS === "1") {
            console.error(
              `[mba-mcp] response validation failed for ${path}: ${parsed.error.message}`,
            );
          }
          throw new ApiError(response.status, "validation", parsed.error.message);
        }
        return parsed.data;
      }
      return json as T;
    }
    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 5) * 1000));
      continue;
    }
    if (attempt < 3 && response.status >= 500 && response.status <= 599) {
      await backoffSleep(attempt);
      continue;
    }
    const body = await response.text().catch(() => "");
    throw new ApiError(response.status, "upstream", body);
  }
}

/**
 * Wraps fetch with auth + retry for POST/PUT/DELETE endpoints.
 *
 * Mirrors apiGet's retry + sanitization model but takes a JSON body.
 * Used by tools that wrap state-mutating endpoints
 * (execute_weekly_plan_action, triage_opportunity, mine_hui_itemsets).
 *
 * Retry policy mirrors apiGet: 429 honors Retry-After (capped), 5xx
 * uses exponential backoff with jitter, network errors retry once.
 * Crucially, we DO retry 5xx + 429 on POST too, the hosted endpoints
 * that the tools target are idempotent in practice (triage =
 * pause/activate/archive is set-state; weekly-plan-execute is
 * de-duplicated by action_id on the backend).
 */
export async function apiPost<T>(
  ctx: ApiContext,
  path: string,
  body: unknown,
  schema?: z.ZodType<T>,
  params: Record<string, string | number> = {},
): Promise<T> {
  const url = buildUrl(ctx.apiBase, path, params);

  let attempt = 0;
  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (e) {
      if (attempt < 3 && isRetryableNetworkError(e)) {
        await backoffSleep(attempt);
        continue;
      }
      throw new ApiError(0, "network", e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      const json = await response.json();
      if (schema) {
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          if (process.env.MBA_DEBUG_ERRORS === "1") {
            console.error(
              `[mba-mcp] response validation failed for ${path}: ${parsed.error.message}`,
            );
          }
          throw new ApiError(response.status, "validation", parsed.error.message);
        }
        return parsed.data;
      }
      return json as T;
    }
    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "1");
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 5) * 1000));
      continue;
    }
    if (attempt < 3 && response.status >= 500 && response.status <= 599) {
      await backoffSleep(attempt);
      continue;
    }
    const bodyText = await response.text().catch(() => "");
    throw new ApiError(response.status, "upstream", bodyText);
  }
}

function isRetryableNetworkError(e: unknown): boolean {
  if (e instanceof Error) {
    if (e.name === "AbortError") return true;
    const msg = e.message.toLowerCase();
    return /econnreset|etimedout|enotfound|fetch failed|network/.test(msg);
  }
  return false;
}

async function backoffSleep(attempt: number): Promise<void> {
  const baseMs = 250 * Math.pow(2, attempt - 1); // 250, 500, 1000
  const jitterMs = Math.floor(Math.random() * 250);
  await new Promise((r) => setTimeout(r, baseMs + jitterMs));
}

/**
 * Error surface for upstream + network failures.
 *
 * The public `message` (what an MCP host sees in our error replies)
 * is intentionally sanitized: "MBA API 401" rather than "MBA API
 * 401: { \"error\": \"invalid_token\", \"hint\": \"sk_live_abc...\" }".
 * The raw body is preserved in `.body` so server-side logs (stderr
 * via console.error) can still capture the detail for ops.
 *
 * `kind: "validation"` covers the case where the upstream JSON
 * doesn't match our expected schema. We surface "MBA API returned
 * malformed response" rather than the raw zod error so we don't
 * leak parser internals to the agent.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly kind: "upstream" | "network" | "validation",
    public readonly body: string,
  ) {
    super(
      kind === "network"
        ? "MBA API unreachable"
        : kind === "validation"
          ? "MBA API returned malformed response"
          : `MBA API ${status}`,
    );
    this.name = "ApiError";
    if (process.env.MBA_DEBUG_ERRORS === "1") {
      console.error(`[mba-mcp] ApiError kind=${kind} status=${status} body=${body.slice(0, 500)}`);
    }
  }
}

/**
 * Coerces a tool-provided limit argument to a safe integer in
 * [1, max]. Falls back to `defaultLimit` whenever the input isn't a
 * finite number, which covers undefined / null / non-numeric
 * strings / Infinity / NaN.
 *
 * Bare `Math.max(1, Math.min(max, Number(raw)))` returns NaN when
 * `raw` is a non-numeric string, which then serializes into
 * URLSearchParams as the string "NaN" and gets rejected upstream
 * with an opaque 400. Routing every tool's limit through here keeps
 * that bug from happening again.
 */
export function coerceLimit(raw: unknown, defaultLimit: number, max: number): number {
  // Treat null / undefined / empty-string as "unset". Number(null) and
  // Number("") both return 0 (finite), which would otherwise slip past
  // Number.isFinite() and get clamped to 1. The docstring promises all
  // three fall back to defaultLimit.
  if (raw === null || raw === undefined) return defaultLimit;
  if (typeof raw === "string" && raw.trim() === "") return defaultLimit;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultLimit;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

/**
 * Single-product recommendations call. The lowest-level fetch most
 * tools compose against.
 */
export async function getRecommendations(
  ctx: ApiContext,
  productId: string,
  limit = 3,
): Promise<Recommendation[]> {
  const data = await apiGet<RecommendationsResponse>(
    ctx,
    "/api/v1/recommendations",
    { product_id: productId, limit },
    RecommendationsResponseSchema,
  );
  return data.recommendations ?? [];
}

/**
 * Substitution lookup: for a product, return the top-k items that
 * could replace it. Used by the find_substitutes tool when an agent
 * needs a fallback SKU because the requested item is unavailable.
 */
export async function getSubstitutes(
  ctx: ApiContext,
  productId: string,
  limit = 3,
): Promise<Substitution[]> {
  const data = await apiGet<SubstitutionsResponse>(
    ctx,
    "/api/v1/substitutions",
    { product_id: productId, limit },
    SubstitutionsResponseSchema,
  );
  return data.substitutions ?? [];
}

/**
 * Format substitutes as plain text + a JSON block. Mirrors
 * renderRecommendations so agents that learned one rendering style
 * recognize the other without prompt engineering.
 */
export function renderSubstitutes(
  subs: Substitution[],
  intro: string,
): string {
  if (subs.length === 0) {
    return "No substitutes found.";
  }
  const lines = subs.map((s, i) => {
    const score = `${(s.score * 100).toFixed(0)}%`;
    const reasonLabel =
      s.reason === "context_similar"
        ? "similar basket context"
        : s.reason === "category_match"
          ? "same category"
          : "same vendor";
    return `${i + 1}. ${s.title ?? s.sku} (SKU: ${s.sku}, match: ${score}, reason: ${reasonLabel})`;
  });
  return (
    `${intro}\n\n` +
    lines.join("\n") +
    "\n\n" +
    "Structured JSON:\n```json\n" +
    JSON.stringify({ substitutions: subs }, null, 2) +
    "\n```"
  );
}

/**
 * Format a recommendation list as plain text for the agent. Most
 * hosts surface this; sophisticated ones parse the JSON block too.
 */
export function renderRecommendations(
  recs: Recommendation[],
  intro: string,
): string {
  if (recs.length === 0) {
    return "No recommendations found.";
  }
  const lines = recs.map(
    (r, i) =>
      `${i + 1}. ${r.title ?? r.sku} (SKU: ${r.sku}, confidence: ${(r.confidence * 100).toFixed(0)}%)`,
  );
  return (
    `${intro}\n\n` +
    lines.join("\n") +
    "\n\n" +
    "Structured JSON:\n```json\n" +
    JSON.stringify({ recommendations: recs }, null, 2) +
    "\n```"
  );
}

/**
 * Per-product return-rate datapoint used by the score_return_risk
 * tool. Every field describes the SAME product (`productId`):
 * `sku`/`title`/`returnRate`/`returnedCount` are that product's own
 * values, never a recommended peer's. `returnRate` is null when no
 * return-aware signal for this product is available (backend hasn't
 * shipped return-aware mining, or the product hasn't surfaced as a
 * mined consequent yet). The tool decides how to surface "no data".
 */
export interface ProductReturnRate {
  productId: string;
  sku: string | null;
  title: string | null;
  returnRate: number | null;
  returnedCount: number | null;
}

/**
 * Fetches each bundle item's OWN historical return rate.
 *
 * Data reality: the hosted backend exposes no dedicated per-product
 * return-rate endpoint. The only return-aware datum available is the
 * `returnRate` + `returnedCount` the return-aware mining PR embeds on
 * each *consequent* of `/api/v1/recommendations`. That rate describes
 * the consequent (the recommended product), not the antecedent we
 * queried with. So a product P's own return rate is only observable
 * when P itself appears as a consequent in some rule, i.e. in the
 * recommendation list of one of the OTHER bundle items.
 *
 * Strategy: fetch every bundle item's recommendations once (one
 * round-trip per product, parallelized), then build a lookup from
 * each observed consequent (keyed by both productId and sku) to its
 * mined return rate. For each input product P we read P's own entry
 * out of that lookup. Crucially, every field in the returned record
 * describes P, we never pair P's id with another product's
 * sku/title/returnRate (the bug this replaces did exactly that, and
 * attributed a recommended peer's return rate to P).
 *
 * Fallback: when P never appears as a consequent (or its rule has no
 * returnRate), we surface `returnRate: null` and let the tool render
 * "data not available". This keeps the tool useful even before the
 * backend has shipped return-aware mining for every catalog item, or
 * ships a true per-product return-rate endpoint we can consume
 * directly.
 *
 * With the typical bundle size of 2-6 items that's at most 6
 * concurrent fetches, well inside the upstream rate limit.
 */
export async function getReturnRiskForBundle(
  ctx: ApiContext,
  productIds: string[],
): Promise<ProductReturnRate[]> {
  // Pull each product's recommendations in parallel. We use a wide
  // limit (the API max of 6) so more consequents (and thus more of
  // the OTHER bundle items) surface with their own return rates.
  const recLists = await Promise.all(
    productIds.map(async (pid) => {
      try {
        return await getRecommendations(ctx, pid, 6);
      } catch (e) {
        // A single-product fetch failure shouldn't tank the whole
        // bundle assessment. Log + treat this list as empty; any
        // item whose rate is only observable here surfaces as null.
        if (process.env.MBA_DEBUG_ERRORS === "1") {
          console.error(
            `[mba-mcp] getReturnRiskForBundle fetch failed for ${pid}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
        return [] as Recommendation[];
      }
    }),
  );

  // Index every observed consequent by both productId and sku so we
  // can look up a bundle item's OWN return rate regardless of which
  // identifier form the caller passed (numeric id, GID, or SKU). The
  // value is the consequent itself, so all fields stay self-consistent.
  const byId = new Map<string, Recommendation>();
  for (const recs of recLists) {
    for (const rec of recs) {
      // First writer wins, but only keep the first one that actually
      // carries a return rate, so a return-aware rule isn't shadowed
      // by an earlier rate-less duplicate of the same product.
      if (rec.productId && (!byId.has(rec.productId) || byId.get(rec.productId)!.returnRate == null)) {
        byId.set(rec.productId, rec);
      }
      if (rec.sku && (!byId.has(rec.sku) || byId.get(rec.sku)!.returnRate == null)) {
        byId.set(rec.sku, rec);
      }
    }
  }

  // Read each input product's OWN entry. `self` describes `pid`
  // (it's the rule whose consequent IS `pid`), so sku/title/rate all
  // belong to `pid`. When `pid` never surfaced as a consequent, every
  // field is null and the tool renders "data not available".
  return productIds.map((pid) => {
    const self = byId.get(pid);
    return {
      productId: pid,
      sku: self?.sku ?? null,
      title: self?.title ?? null,
      returnRate: self?.returnRate ?? null,
      returnedCount: self?.returnedCount ?? null,
    } as ProductReturnRate;
  });
}

/**
 * Subscription-bundle proposal helper. Fans out to /recommendations
 * for each seed product and (when a customer_id is provided)
 * optionally pulls the customer's reorder-prediction set so the
 * proposeSubscriptionBundle tool can rank a kit by both cohesion
 * (do these items co-occur in carts?) and cadence (does the customer
 * actually reorder these on a steady rhythm?).
 *
 * The reorder-predictions fetch is best-effort: a 404 (older
 * Magento / WooCommerce backends that haven't shipped the endpoint),
 * an empty result, or any thrown ApiError all collapse to an empty
 * predictions array so the caller can fall back to seed-only
 * analysis without surfacing a confusing error.
 */
export interface SubscriptionProposalInputs {
  recsBySeed: Recommendation[][];
  predictions: ReorderPrediction[];
}

export async function getSubscriptionProposals(
  ctx: ApiContext,
  seedIds: string[],
  customerId?: string,
): Promise<SubscriptionProposalInputs> {
  const recsBySeed = await Promise.all(
    seedIds.map((id) => getRecommendations(ctx, id, 6).catch(() => [])),
  );

  let predictions: ReorderPrediction[] = [];
  if (customerId && customerId.trim() !== "") {
    try {
      const result = await getReorderPredictions(ctx, customerId.trim());
      predictions = result.predictions ?? [];
    } catch (e) {
      // Graceful fallback: 404 (endpoint not shipped on this
      // platform yet), empty history, validation drift, etc., all
      // collapse to "no customer signal, use seed-only analysis".
      // Logged to stderr only.
      if (process.env.MBA_DEBUG_ERRORS === "1") {
        console.error(
          `[mba-mcp] getSubscriptionProposals reorder fetch failed for ${customerId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      predictions = [];
    }
  }

  return { recsBySeed, predictions };
}

/**
 * Standard "missing API key" tool reply. Routed through here so
 * every tool gives the same message, agents like consistent
 * error patterns.
 */
export function missingKeyReply() {
  const remedy =
    serverMode === "http"
      ? "Send it as a bearer token on every request: `Authorization: Bearer mba_live_...`. " +
        "In most MCP hosts that is the `headers` block of the server config."
      : "Add it to this server's `env` block in your MCP host config as MBA_API_KEY.";
  return {
    content: [
      {
        type: "text" as const,
        text:
          "Error: no MarketBasketAnalysis API key configured. " +
          "Mint a key in the MarketBasketAnalysis admin (Shopify app -> API keys, or Magento/WooCommerce admin -> API keys). " +
          remedy,
      },
    ],
    isError: true,
  };
}
