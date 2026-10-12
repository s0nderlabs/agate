---
slug: connect-an-ai
title: Connect an AI
description: Any AI app that takes a remote MCP server can read prices and trade from its own pocket, inside limits you set.
group: Get started
order: 3
source: 'server/src/mcp/server.ts, server/src/oauth/routes.ts, agents/AGENTS.md'
---

# Your AI trades from its own pocket, inside your limits.

Agate is a remote MCP server (Streamable HTTP). Any AI app that can add one, Claude, Codex, Hermes, OpenClaw and
others, can read Agate's prices and trade. It never touches your main account: each AI gets its own **pocket**, a
separate account holding only the budget you give it, and every trade is checked against your limits by Agate's
server and again by the chain itself ([AI pockets and limits](07-ai-pockets.md)).

## Two ways to connect

Agate's MCP server is at **`https://agate-1.tailf06dd7.ts.net/mcp`**. That is the address of Agate's own server
(published through Tailscale Funnel), not of the app: the app at `agate.elpabl0.xyz` does not proxy MCP, and the
OAuth tokens are issued for this exact address, so add it as written. Every address Agate uses is in
[Contracts and addresses](12-contracts.md#endpoints).

- **OAuth 2.1 (sign in from the app):** add the address above as a remote MCP server. The app registers itself, opens
  Agate's **Allow** page (`https://agate.elpabl0.xyz/app/connect?request=<id>`), and you sign in and set a budget, a
  cap per trade, trades a day and an end date. Discovery: `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-authorization-server` on the same host.
- **Connector URL:** on Agate's **Connected AIs** page (`https://agate.elpabl0.xyz/app/ai`, from the Account sheet,
  or **More** on a phone), connect an AI and copy the private URL it shows once. Add that URL as a remote MCP server;
  no further sign-in. Treat it like a password: anyone with it can use that connection until you disconnect it
  (connect again for a new one).

## Per app

Checked against the live server on Oct 8 2026 (Claude in use since Oct 4):

| App | OAuth | Connector URL |
| --- | --- | --- |
| Claude Code | `claude mcp add --transport http agate https://agate-1.tailf06dd7.ts.net/mcp`, then `/mcp` to sign in | `claude mcp add --transport http agate <url>` |
| Claude.ai | Settings, Connectors, Add custom connector: the `/mcp` address | the URL in the same field |
| Codex CLI | `codex mcp add agate --url https://agate-1.tailf06dd7.ts.net/mcp`, then `codex mcp login agate` | `codex mcp add agate --url <url>` (connects and lists the tools; no trade checked yet) |
| Hermes Agent | not on Hermes v0.8.0, which hands only the host to the MCP SDK, so the SDK refuses a `/mcp` resource; newer Hermes keeps the full address (upstream issue 16015, not checked here yet) | `mcp_servers: agate: url: <url>` in `~/.hermes/config.yaml`; `hermes mcp test agate` lists the tools |
| OpenClaw | no OAuth for MCP servers | `openclaw mcp set agate '{"url":"<url>","transport":"streamable-http"}'` (set `transport`) |
| opencode | `"mcp": {"agate": {"type": "remote", "url": "<address>/mcp"}}` in `opencode.json` (not checked yet) | the same with the URL |
| Cursor, ChatGPT, VS Code | add the `/mcp` address as a remote MCP server (not checked yet) | the URL as a remote server |

A Claude Code plugin with the Agate skill is in `agents/claude-plugin` (set `AGATE_MCP_URL`).

What the two CLIs print (Oct 10 2026, in a fresh config):

```text
$ claude mcp add --transport http agate https://agate-1.tailf06dd7.ts.net/mcp
Added HTTP MCP server agate with URL: https://agate-1.tailf06dd7.ts.net/mcp to local config
$ claude mcp list
agate: https://agate-1.tailf06dd7.ts.net/mcp (HTTP) - ! Needs authentication
```

"Needs authentication" is expected: in Claude Code, `/mcp`, then **agate**, opens the Allow page in your browser.

```text
$ codex mcp add agate --url https://agate-1.tailf06dd7.ts.net/mcp
Added global MCP server 'agate'.
Detected OAuth support. Starting OAuth flow…
Authorize `agate` by opening this URL in your browser:
https://agate-1.tailf06dd7.ts.net/authorize?response_type=code&client_id=agt_client_...&scope=mcp
```

Opening that URL leads to Agate's Allow page; once you allow, `codex mcp list` shows the server as logged in.

Any other client that speaks Streamable HTTP takes the same two fields:

```json
{ "mcpServers": { "agate": { "type": "http", "url": "https://agate-1.tailf06dd7.ts.net/mcp" } } }
```

In Claude Code the tools then show as `mcp__agate__get_prices`, `mcp__agate__open_long` and so on.

## Then ask

- "What's the H100 price on Agate, and where does it come from?"
- "Quote a $50 H100 November long."
- "Open a $50 H100 November long, paid daily."
- "Keep my H100 hedge going into next month."

Every trade shows on the AI's page in **Connected AIs** with its transaction, and above the cap the AI sends you an
approval link instead of trading. The tools: [MCP tools](11-mcp-tools.md). A guide written for the agent itself:
[For agents](18-agents.md).

## If it fails

| What you see | Why | What to do |
|---|---|---|
| reads work, trade tools are missing | a connector URL past its end date | connect again with a new end date |
| the Allow page opens on an old address | an app saved the address from before Oct 10 | nothing: it redirects to `/app/connect` by itself |

Every `401` and `429` the server answers, and every refusal rule: [Errors](17-errors.md#mcp-connection).

## Disconnect

On **Connected AIs**, **Disconnect** stops an AI at once: Agate stops signing for it, its tokens and connector URL
die, its autopilot stops, and the pocket's dollars can be taken back.
