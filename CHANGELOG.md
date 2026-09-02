# Changelog

All notable changes to `@marketbasketanalysis/mcp`.

## 0.7.1 (2026-09-02)

Restores the documented cold install one-liner.

- New bin `mcp` -> `dist/index.js`. npm 9+ auto-selects a bin only when
  its name matches the unscoped package name, so with multiple bins and
  none named `mcp`, `npx -y @marketbasketanalysis/mcp` failed cold with
  "could not determine executable to run". Every listing and the README
  promise exactly that command. Existing bins unchanged.
- `repository` now points at the public standalone repo
  (48x-ai/marketbasketanalysis-mcp); 0.7.0's npm page linked the private
  monorepo, which 404s for visitors.

## 0.7.0 (2026-08-11)

Hosted streamable-HTTP endpoint.

- New entrypoint `src/http.ts` (bin: `mba-mcp-http`) serving the same
  19-tool registry over MCP streamable HTTP, deployed as Fly app
  `marketbasketanalysis-mcp` at
  `https://mcp.marketbasketanalysis.com/mcp`. Stateless
  server-per-request; JSON responses (no SSE); `/healthz` probe.
- Multi-tenant auth: the per-store key arrives per request as
  `Authorization: Bearer mba_live_...` and flows through an
  AsyncLocalStorage request scope (`runWithRequestScope` /
  `activeContext()` in `lib/api.ts`), so concurrent requests with
  different keys cannot bleed. The stdio path is unchanged (startup
  singleton).
- Unauthenticated requests can initialize and list tools (directory
  crawlers see the full toolset); every unauthenticated tools/call
  returns the standard missing-key reply, now worded per transport.
- `X-MBA-Base` override is allowlisted to MBA-operated planes so the
  public endpoint cannot be used as a key-forwarding proxy; self-hosted
  WooCommerce/Magento stores keep using the npm package over stdio.
  `X-MBA-Platform` header mirrors MBA_PLATFORM for path mapping.
- `server.json` gains the `remotes` entry for the hosted endpoint.
- package.json author updated to 48x.ai LLC <brian@48x.ai>.

## 0.6.0 (2026-08-05)

First public release.

- Published to npm under the `marketbasketanalysis` org:
  `npx -y @marketbasketanalysis/mcp` starts the server with 19
  agent-callable tools.
- Listed on the official MCP Registry as
  `io.github.48x-ai/marketbasketanalysis-mcp` (status: active).
- Per-platform path resolution (`resolvePlatformPath` in `lib/api.ts`):
  tool files write canonical hosted-plane paths and the server rewrites
  them for self-hosted backends, so 10 of the 19 tools work against
  WooCommerce (`wp-json/marketbasketanalysis/v1`) and Magento
  (`V1/marketbasketanalysis`, rationale under `V1/mba`) in addition to
  the hosted plane (Shopify, BigCommerce, OroCommerce).
- The 9 merchant-ops tools (opportunities, triage, weekly plan, drift
  and forecast alerts, both explain tools, hosted HUI mining) exist only
  on the hosted plane; on self-hosted platforms they now return a clear
  "not available on this platform" error before any network call
  instead of an opaque upstream 404.
- `predict_reorder` registers on Shopify, BigCommerce, WooCommerce, and
  Magento (hidden on OroCommerce, which has no reorder route), with the
  "accounts" vs "customers" resource-segment difference mapped per
  platform.
- `server.json` migrated to the current MCP Registry schema
  (2025-09-29, camelCase), with environment variable metadata for
  `MBA_API_KEY`, `MBA_API_BASE`, and `MBA_PLATFORM`.
- Packaging fix: bin entries normalized from `./dist/index.js` to
  `dist/index.js`; npm 11 silently removed the `./`-prefixed entries at
  publish time, which would have shipped a package `npx` could not run.
</content>
