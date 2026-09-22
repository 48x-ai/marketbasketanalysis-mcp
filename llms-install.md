# Installing the MarketBasketAnalysis MCP server

This file is written for an AI coding agent (Cline, Claude Code, Cursor)
setting the server up on a user's machine. Everything here is
copy-pasteable. There is no build step and nothing to clone.

## What this server is

`@marketbasketanalysis/mcp` is a thin client for the MarketBasketAnalysis
data plane. It exposes 19 tools covering product recommendations,
substitutes, bundle building, cross-sell scoring, reorder prediction and
merchant ops over an ecommerce store's real order history. It works
against Shopify, BigCommerce, WooCommerce, Magento and OroCommerce
backends.

## Install (stdio, the normal path)

Do NOT clone this repository. The server ships on npm and runs through
`npx`, so no local checkout, install or build is needed:

```
npx -y @marketbasketanalysis/mcp
```

A correct run prints one line to stderr and then waits on stdio:

```
[mba-mcp] started; no API key configured; 19 tools registered
```

Seeing that line means the install worked. The process does not exit on
its own; that is normal for a stdio MCP server.

## Client configuration

Add this to the MCP settings file of the host you are configuring
(`cline_mcp_settings.json` for Cline, `claude_desktop_config.json` for
Claude Desktop, `~/.cursor/mcp.json` for Cursor):

```json
{
  "mcpServers": {
    "marketbasketanalysis": {
      "command": "npx",
      "args": ["-y", "@marketbasketanalysis/mcp"],
      "env": {
        "MBA_API_KEY": "mba_live_YOUR_KEY_HERE"
      }
    }
  }
}
```

Then restart the host so it picks up the new server.

## The API key

`MBA_API_KEY` is optional for setup and required for real data.

- Without a key the server starts normally and registers all 19 tools, so
  a host can connect and list them. Every tool call returns a
  "no API key configured" reply instead of store data.
- With a key the startup line names the resolved backend instead:
  `[mba-mcp] started; apiBase=https://app.marketbasketanalysis.com; 19 tools registered`

The user mints a key themselves in their store's MarketBasketAnalysis
admin, on the API keys page. Keys start with `mba_live_`. A free tier is
available. Do not invent, guess or generate a key: if the user does not
have one, finish the install without it and tell them where to get one.

## Verifying the install

1. Run `npx -y @marketbasketanalysis/mcp` and confirm the startup line
   above appears.
2. Restart the MCP host and confirm `marketbasketanalysis` is connected
   and lists 19 tools.
3. If the user supplied a key, ask the agent to run a tool, for example:
   "Use marketbasketanalysis to find what customers also buy with
   product 8472918765."

## Hosted alternative (remote MCP hosts)

For hosts that speak streamable HTTP rather than stdio, point them at:

```
https://mcp.marketbasketanalysis.com/mcp
```

Auth is the same key, sent as `Authorization: Bearer mba_live_...`.

## Troubleshooting

- `could not determine executable to run`: the host is pinned to a
  version older than 0.7.1. Use `@marketbasketanalysis/mcp@latest`.
- Node version: requires Node 18 or newer. `node -v` to check.
- No output at all: the startup line goes to stderr, not stdout. Some
  wrappers hide stderr.
- Tools list but return "no API key configured": expected without a key.
  See the API key section above.

## Links

- npm: https://www.npmjs.com/package/@marketbasketanalysis/mcp
- MCP Registry: `io.github.48x-ai/marketbasketanalysis-mcp`
- Docs: https://www.marketbasketanalysis.com/docs/mcp
