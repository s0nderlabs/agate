# agate for AI agents

agate is an open onchain price for GPU-hours (H100, H200, B200 and more) that anyone, a person, an app or an agent,
can trade, hedge or build on. It runs on Monad testnet with test dollars.

## Connect

agate is a remote MCP server (Streamable HTTP).
- **OAuth 2.1** (Claude.ai, ChatGPT, Cursor, Claude Code): add `<agate host>/mcp`. Discovery is at
  `/.well-known/oauth-authorization-server`. The person signs in to agate (Dynamic) and sets a budget, a per-trade
  cap, a daily trade count and an end date on the Allow page.
- **Connector URL**: the person copies a private URL from agate's "Connect your AI" screen,
  `claude mcp add --transport http agate <url>`.
- **Claude Code plugin**: `agents/claude-plugin` (set `AGATE_MCP_URL`).

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
with Dynamic) that owns a gas-sponsored smart account, and trade agate with `@agate/client`'s plan builders
(`planBuyLong`, `planRollLong`, ...) as single user operations. agate's reference agent (`server/src/company/agent.ts`,
run with `server/scripts/company-agent.ts`) keeps one rule: hold N GPU-hours of a GPU's next open month, buying the
shortfall in parts of at most $X while the best ask is at or under a ceiling, and journals every decision with the
transaction hash the chain returned.
