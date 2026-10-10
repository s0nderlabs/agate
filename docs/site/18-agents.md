---
slug: agents
title: For agents
description: How an AI agent uses Agate for a person, what must go back to that person, and what never goes through the chat.
group: Get started
order: 4
source: 'server/src/mcp/server.ts, agents/AGENTS.md, server/src/grants.ts'
---

# You trade inside the limits; the person holds the money and the keys.

You are an AI agent, and a person connected you to Agate. This page says what you can do for them, what must go back
to them, and what never goes through the chat.

## If you only read one line

**Call `my_limits` before trading, pass an `idempotency_key` to every money tool, report only transaction hashes a
tool returned, hand the person the approval link when a trade is above the cap, and never ask for the connector URL,
a sign-in code or a passkey in chat.**

## What Agate is, in one paragraph

Agate is an open onchain price for renting a GPU for an hour, one number per GPU per day, and monthly markets on it.
A **Long** locks what the person pays for compute in a month; a **Short** locks what they earn from it. Every token is
fully backed: it exists only when someone locks the month's ceiling in dollars, so no one can owe more than they put
in. Everything runs on Monad testnet with test dollars that have no value. Details: [The monthly market](05-the-market.md).

## How you are connected

Agate is a remote MCP server at `https://agate-1.tailf06dd7.ts.net/mcp` ([Connect an AI](03-connect-an-ai.md)). Your
connection trades from a **pocket**, a separate account holding only the budget the person gave you, inside four
limits: the budget, a cap per trade, a number of trades in any 24 hours, and an end date. Agate's server checks each
limit before anything is signed, and the pocket's session key checks them again onchain
([AI pockets and limits](07-ai-pockets.md)).

## A trade, step by step

1. `my_limits`: is the connection `live`, how much is in the pocket, what is the cap, how many trades are left?
2. `get_prices` with the GPU: today's price, the open months, each month's floor, ceiling, bid and ask.
3. `quote`: what the trade gets now, and the most it can win or lose by the month's end. Tell the person.
4. The trade (`open_long`, `open_short`, ...), with an `idempotency_key` you make up once for this trade.
5. Read the answer's `status`:
   - `done`: report the `tx_hash` and the `explorer` link it returned.
   - `sent`: not seen landing yet. Call `activity`, never the trade again with a new key.
   - `needs_approval`: give the person the `approve_url`, then poll `approval_status`.
   - `refused`: read the `rule` ([Errors](17-errors.md#mcp-refusals)) and tell the person what it means.

A sized hedge: "I rent 8 H100s through November" is `size_for { gpus: 8, days: 30 }` (5,760 GPU-hours), then a
`quote` for that size. If its cost is above the cap, that is one trade above the cap: call the trade (it answers
`needs_approval`) or `request_approval`, and hand the person the link. Never break it into trades under the cap.

## What you can do

- Read prices, sources, months, books and the person's portfolio while the connection lasts (through a connector URL,
  also past the end date; an OAuth connection ends with it, and a disconnect ends either outright).
- Open and close Longs and Shorts, paid daily or at the end, from the pocket, inside the limits.
- Roll a Long into the next month (`roll_long`), or set autopilot to do it before each close (`keep_hedge_going`).
- Take the pocket's test dollars once every 24 hours (`get_test_dollars`).
- Ask for a trade above the cap (`request_approval`).

## What must go back to the person

| Step | Why it is theirs | Where they do it |
|---|---|---|
| A trade above the cap | only they can spend past the limit they set | the approval link, `https://agate.elpabl0.xyz/app/approve?request=<id>` (15 minutes) |
| More budget, a higher cap, a later end date | the limits are theirs | connect you again on the AI page |
| Signing in, a code, a passkey | it proves who they are | the app, never the chat |
| Collecting at the month's end | the payouts go to their main account | the SDK's `settle` or `claim` today; the app's Positions before Dec 1 |
| Disconnecting you | their call at any time | the AI page |

## Never

- Never ask for the connector URL in chat, and never repeat it: it works like a password.
- Never ask for a sign-in code, a passkey, a seed phrase or a private key. Agate never needs one from you.
- Never split a trade to stay under the cap. Ask for approval instead.
- Never report a transaction hash a tool did not return, and never call a trade done before `status: "done"`.
- Never retry a money tool with a new `idempotency_key` after `sent`: check `activity` first.
- Never present test dollars as money, or a trade as investment advice.

## Read more, machine-readable

These docs are also served for agents: `https://agate.elpabl0.xyz/llms.txt` (an index, one line per page),
`https://agate.elpabl0.xyz/llms-full.txt` (every page in one file) and `https://agate.elpabl0.xyz/docs/raw/<slug>.md`
(one page as markdown, for example `/docs/raw/mcp-tools.md`). Fetch them again before relying on what you read
earlier: limits and months change. Every tool, parameter and answer: [MCP tools](11-mcp-tools.md).

