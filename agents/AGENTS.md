# agate for AI agents

agate is an open onchain price for GPU-hours (H100, H200, B200 and more) that anyone, a person, an app or an agent,
can trade, hedge or build on. It runs on Monad testnet with test dollars.

## Connect

agate is a remote MCP server (Streamable HTTP). Any AI app that can add a remote MCP server can connect, in one of
two ways:
- **OAuth 2.1**: add `<agate host>/mcp`. The app registers itself (DCR), opens agate's Allow page, and the person
  signs in to agate (Dynamic) and sets a budget, a per-trade cap, a daily trade count and an end date. Discovery is
  at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`.
- **Connector URL**: the person connects on agate's "Connect your AI" screen and copies the private URL it shows
  once (treat it like a password). The app adds that URL as a remote MCP server with no further sign-in.

Per app (Codex, Hermes and OpenClaw checked against the live server on Oct 8 2026; Claude in use since Oct 4):

| App | OAuth | Connector URL |
| --- | --- | --- |
| Claude Code | `claude mcp add --transport http agate <agate host>/mcp`, then `/mcp` to sign in | `claude mcp add --transport http agate <url>` |
| Claude.ai | Settings, Connectors, Add custom connector: `<agate host>/mcp` | same field, the URL |
| Codex CLI | `codex mcp add agate --url <agate host>/mcp`, then `codex mcp login agate` (reaches the Allow page) | `codex mcp add agate --url <url>` (connects; lists the tools) |
| Hermes Agent | not on Hermes v0.8.0: it hands only the host to the MCP SDK, which then refuses agate's `/mcp` resource (as it would Linear's or Notion's); newer Hermes passes the full address (upstream issue 16015, not checked here yet) | in `~/.hermes/config.yaml`, `mcp_servers: agate: url: <url>`; `hermes mcp test agate` lists 17 tools (tool calls checked) |
| OpenClaw | no OAuth for MCP servers | `openclaw mcp set agate '{"url":"<url>","transport":"streamable-http"}'` (set `transport`: without it OpenClaw uses SSE; tool calls checked) |
| opencode | `"mcp": {"agate": {"type": "remote", "url": "<agate host>/mcp"}}` in `opencode.json` (not checked yet) | same with the URL (not checked yet) |
| Cursor, ChatGPT, VS Code | add `<agate host>/mcp` as a remote MCP server (not checked yet) | the URL as a remote server |

- **Claude Code plugin**: `agents/claude-plugin` (set `AGATE_MCP_URL`).

## What backs a token

A token is a cash-settled claim on the month's average GPU-hour price, not a GPU-hour held anywhere, and it is never
created out of thin air: it exists only when someone locks the month's ceiling in dollars (H100 November 2026: $8.00).
That deposit makes the token (pays the month's average, clamped to the floor $1.95 and the ceiling $8.00) and a short
position (pays the ceiling minus that average); the two always pay exactly the locked $8.00, so every payout is
already in the contract. No margin calls, no liquidations. Tell people this when they ask what they are buying.

## What a connection can do

Reads: `get_prices`, `quote`, `size_for`, `get_portfolio`, `my_limits`, `activity`, `approval_status`.
Trades (only while the connection is live): `open_long` (optionally `pay_me_daily`), `open_short`, `close_long`,
`close_long_daily`, `close_short`, `roll_long`, `get_test_dollars`, `request_approval`.

## Limits, enforced in three places

1. agate's server refuses by rule name before anything is signed (cap, budget, daily count, end date, price bounds).
2. The trade is signed by the person's **Assistant**, a second Dynamic embedded wallet delegated to agate. Dynamic
   co-signs (MPC), and Dynamic Transaction Review lets agate's server re-check each signature (enabled once Dynamic
   turns it on for the environment).
3. The **pocket** (a separate smart account holding only the AI's budget) carries a ZeroDev session key that the
   chain itself checks: agate router calls only, per-trade cap, payouts pinned to the person's main account, N
   operations a day, an end date, and no ERC-1271 signatures. The pocket's balance is the hard total.

The person can disconnect one AI at any time: agate stops signing for it, its tokens and URL die, and its pocket's
dollars go home. "Stop every AI" also revokes the Assistant with Dynamic, which stops its signing at once.

## Autopilot

`keep_hedge_going { gpu, lead_minutes? }` asks agate to roll the pocket's Long of that GPU into the next listed month
by itself before the held month closes (in parts under the cap; each roll counts as a trade). `stop_keep_hedge_going`
ends it; `my_limits` lists what is on.

## Rules for agents

- Report only transaction hashes a tool returned.
- Pass an `idempotency_key` to every money tool. `status: "sent"` means sent but not seen landing yet: check
  `activity` before trying again.
- Above the cap, hand the person the approval link; do not split a trade to dodge the cap.

## AI companies: an agent with its own wallet

An AI company's agent does not need a person's pocket. It can hold its own Dynamic server wallet (TSS-MPC, 2-of-2
with Dynamic) that owns a gas-sponsored smart account, and trade agate with the SDK's plan builders (`@s0nderlabs/agate` on npm)
(`planBuyLong`, `planRollLong`, ...) as single user operations. agate's reference agent (`server/src/company/agent.ts`,
run with `server/scripts/company-agent.ts`) keeps one rule: hold N GPU-hours of a GPU's next open month, buying the
shortfall in parts of at most $X while the best ask is at or under a ceiling, and journals every decision with the
transaction hash the chain returned.
