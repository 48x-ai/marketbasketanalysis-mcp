# Release Process

`@marketbasketanalysis/mcp` lives in the `48x-ai/marketbasketanalysis`
monorepo at `packages/mcp`. It is published in TWO places, both live
since 2026-08-05:

- **npm**: `@marketbasketanalysis/mcp`, owned by the
  `marketbasketanalysis` npm org (free public plan). Publishing account:
  `brian48x` (brian@48x.ai, passkey 2FA).
- **The official MCP Registry** (registry.modelcontextprotocol.io):
  `io.github.48x-ai/marketbasketanalysis-mcp`. Ownership is proven two
  ways: the `mcpName` field in package.json must equal the registry
  server name, and the publishing GitHub account must be an **Owner** of
  the `48x-ai` org with **public** membership.

This document is the process that actually shipped 0.6.0, not a plan.
The old `mcp-v*` tag + GitHub Actions `NPM_TOKEN` workflow is parked
until org Actions are re-enabled; do not rely on it.

## Releasing a new version

### 1. Bump the version in FOUR files (five spots)

- `package.json` -> `version`
- `src/index.ts` -> the `version:` string in the server metadata (~line 85)
- `src/http.ts` -> `SERVER_VERSION` (drives the hosted endpoint's
  serverInfo + /healthz)
- `server.json` -> top-level `version` AND `packages[0].version`

Grep to confirm nothing is left behind (substitute the OLD version):

```bash
cd packages/mcp && grep -rn "0\.7\.0" package.json src/index.ts src/http.ts server.json
```

### 1b. Deploy the hosted endpoint (independent of npm)

The hosted endpoint builds from source, not from npm, so it can ship
before or after the npm publish:

```bash
cd packages/mcp && fly deploy --config fly.toml --remote-only
curl -s https://mcp.marketbasketanalysis.com/healthz   # expect the new version
```

### 2. Gate

```bash
npx vitest run && npx tsc --noEmit
npm pack --dry-run          # confirm dist/**, README, LICENSE, smithery.yaml, 108-ish files
bash ../../tools/lint-no-em-dashes.sh
mcp-publisher validate      # server.json against the LIVE registry schema
```

`mcp-publisher validate` matters: the server.json schema moves (0.6.0
required migrating snake_case `registry_type` to camelCase
`registryType`), and validate checks against the live registry, not a
cached schema.

### 3. npm publish (real Terminal, not a captured shell)

```bash
cd ~/dev/marketbasketanalysis/packages/mcp
npm publish --access=public
```

- 2FA is a **passkey** on `brian48x`, so npm needs the browser auth
  flow, which only works from a real interactive Terminal. From a
  captured/CI shell it fails with `EOTP`.
- `prepublishOnly` runs the build; no manual build step.
- **Treat any `npm warn publish` line about `bin` as a hard stop.**
  npm 11 "auto-corrects" invalid bin values by silently REMOVING the
  bin entries, which ships a package `npx` cannot run. This nearly
  happened to 0.6.0 (`./dist/index.js` prefixes); bin values must stay
  plain `dist/index.js`.
- Publishing from the monorepo ROOT fails with
  `Cannot read properties of null (reading 'prerelease')` (the
  workspace package.json has no version). Always publish from
  `packages/mcp`.

### 4. MCP Registry publish

```bash
mcp-publisher login github -token <classic PAT>
mcp-publisher publish
```

- The PAT is a **classic** token on `brian48x` with ONLY `read:org`,
  short expiry; revoke after use. The interactive device-flow login
  authenticates fine but cannot read the org role through the org's
  OAuth-app policy, so it grants only `io.github.brian48x/*`; the PAT
  path is the one that works for `io.github.48x-ai/*`.
- Registry JWTs expire quickly; log in immediately before publishing.
- Standing prerequisites (already true; verify if publishes start
  403ing): `brian48x` is an Owner of `48x-ai` AND its membership is
  Public (https://api.github.com/orgs/48x-ai/public_members must list
  it).

### 5. Verify, all three

```bash
# npm manifest: version, and BOTH bin entries present
curl -s https://registry.npmjs.org/@marketbasketanalysis/mcp | \
  python3 -c "import json,sys; d=json.load(sys.stdin); v=d['dist-tags']['latest']; print(v, d['versions'][v]['bin'])"

# MCP Registry: the new version, status active
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=marketbasketanalysis"

# cold npx from OUTSIDE the repo
cd ~ && npx -y @marketbasketanalysis/mcp
# expect: [mba-mcp] started; no API key configured; 19 tools registered
```

### 6. Announce

- Add a `CHANGELOG.md` entry here.
- Add an entry to the marketing site `/changelog`
  (`app/changelog/page.tsx` in the site repo) and push (direct push
  deploys; PR merges must be performed as `brian48x`).

## Registry listings

- **Official MCP Registry**: updated by step 4 above. The community
  README list in `modelcontextprotocol/servers` is retired upstream;
  there is no PR to send.
- **Smithery**: reads `smithery.yaml` from the repo; the listing is an
  operator dashboard add (smithery.ai as brian48x). Keep
  `smithery.yaml`'s tool list in sync when tools change.
- **Glama**: auto-indexes npm; nothing to do per release.

## 0.6.0 launch log (2026-08-05): the failure chain, for posterity

Every error below was hit for real on launch day and has a distinct
cause; recognize them fast next time:

| Error | Meaning |
|---|---|
| `E403 ... Two-factor authentication ... required` | Account has NO 2FA enrolled; enroll before publishing |
| `npm warn publish "bin[...]" invalid and removed` | npm 11 silently strips `./`-prefixed bin entries; HARD STOP (fixed in `8164599b`) |
| `EOTP` plus a masked URL | Browser 2FA cannot run in a captured shell; use a real Terminal |
| `Cannot read properties of null (reading 'prerelease')` | Ran from the monorepo root, not packages/mcp |
| `E404 Scope not found` | The npm org for the scope did not exist yet (created 2026-08-05) |
| Registry `403 ... permission to publish: io.github.brian48x/*` | Org role unreadable: needs Owner + public membership + a read:org PAT login |
| Registry `422 registryType expected length >= 1` | server.json on the old snake_case schema; rewrite + `mcp-publisher validate` |
</content>
