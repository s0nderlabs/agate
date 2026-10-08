---
slug: connect-an-ai
title: Connect an AI
description: Any AI app that takes a remote MCP server can read prices and trade from its own pocket, inside limits you set.
group: Get started
order: 3
source: 'server/src/mcp/server.ts, server/src/oauth/routes.ts, agents/AGENTS.md'
---

# Your AI trades from its own pocket, inside your limits.

agate is a remote MCP server (Streamable HTTP). Any AI app that can add one, Claude, Codex, Hermes, OpenClaw and
others, can read agate's prices and trade. It never touches your main account: each AI gets its own **pocket**, a
separate account holding only the budget you give it, and every trade is checked against your limits by agate's
server and again by the chain itself ([AI pockets and limits](07-ai-pockets.md)).

## Two ways to connect

- **OAuth 2.1 (sign in from the app):** add `https://agate-1.tailf06dd7.ts.net/mcp` as a remote MCP server. The app
  registers itself, opens agate's **Allow** page, and you sign in and set a budget, a cap per trade, trades a day and
  an end date. Discovery: `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`.
- **Connector URL:** on agate's **AI** page, connect an AI and copy the private URL it shows once. Add that URL as a
  remote MCP server; no further sign-in. Treat it like a password: anyone with it can use that connection until you
  disconnect it.

## Per app

Checked against the live server on Oct 8 2026 (Claude in use since Oct 4):

| App | OAuth | Connector URL |
| --- | --- | --- |
| Claude Code | `claude mcp add --transport http agate https://agate-1.tailf06dd7.ts.net/mcp`, then `/mcp` to sign in | `claude mcp add --transport http agate <url>` |
| Claude.ai | Settings, Connectors, Add custom connector: the `/mcp` address | the URL in the same field |
| Codex CLI | `codex mcp add agate --url https://agate-1.tailf06dd7.ts.net/mcp`, then `codex mcp login agate` | `codex mcp add agate --url <url>` |
| Hermes Agent | not yet (Hermes v0.8.0 hands only the host to the MCP SDK, which then refuses a `/mcp` resource) | `mcp_servers: agate: url: <url>` in `~/.hermes/config.yaml`; `hermes mcp test agate` lists the tools |
| OpenClaw | no OAuth for MCP servers | `openclaw mcp set agate '{"url":"<url>","transport":"streamable-http"}'` (set `transport`) |
| opencode | `"mcp": {"agate": {"type": "remote", "url": "<address>/mcp"}}` in `opencode.json` (not checked yet) | the same with the URL |
| Cursor, ChatGPT, VS Code | add the `/mcp` address as a remote MCP server (not checked yet) | the URL as a remote server |

A Claude Code plugin with the agate skill is in `agents/claude-plugin` (set `AGATE_MCP_URL`).

## Then ask

- "What's the H100 price on agate, and where does it come from?"
- "Quote a $50 H100 November long."
- "Open a $50 H100 November long, paid daily."
- "Keep my H100 hedge going into next month."

Every trade shows on the **AI** page with its transaction, and above the cap the AI sends you an approval link
instead of trading. The tools: [MCP tools](11-mcp-tools.md).

## Disconnect

On the **AI** page, **Disconnect** stops an AI at once: agate stops signing for it, its tokens and connector URL die,
its autopilot stops, and the pocket's dollars can be taken back.
