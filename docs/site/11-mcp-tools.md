---
slug: mcp-tools
title: MCP tools
description: Every tool an AI app gets from Agate's MCP server, with its parameters, what it returns and every refusal.
group: Reference
order: 11
source: 'server/src/mcp/server.ts, server/src/grants.ts, wallet/src/allowed.ts'
---

# Seventeen tools: read, trade inside the limits, ask when above them.

Connected through [Connect an AI](03-connect-an-ai.md), an AI app sees these tools. This page lists every one, its
parameters and defaults, what it returns, and every refusal it can give. Reads always work; trades work only while
the connection is live, from the pocket, inside its limits ([AI pockets and limits](07-ai-pockets.md)). Past the end
date, a connector URL still answers the reads with its trade tools not listed; an OAuth connection stops answering
within the hour (its token is not refreshed), so the person connects it again.

Common types: `gpu` is one of `H100`, `H200`, `B200`, `B300`, `A100`, `L40S`; `month` is `YYYY-MM` (for example
`2026-11`); dollars and GPU-hours are plain numbers (`100`, `24.5`); `idempotency_key` is any string of 8 to 100
characters.

## What the server tells the AI first

Every connection starts with these instructions, word for word (`server/src/mcp/server.ts`):

> agate makes the price of GPU compute tradable: a daily index of GPU-hour rental prices (H100, H200, B200 and more)
> and monthly tokens that pay that month's average price. Long gains when GPU rent rises (a hedge for renters), Short
> gains when it falls. Everything is on Monad testnet with test dollars.
>
> This connection is one person's AI connection. Trades run from their AI pocket (a separate account holding only the
> budget they gave you), within a per-trade cap, a daily trade count and an end date; daily payouts always go to their
> main account (what is already sure at opening comes back into the pocket at once). `my_limits` shows what is left;
> check it before trading.

followed by a paragraph listing the tools, and one with its rules:

> Refusals name the rule (over_per_trade_cap, budget_left, daily_limit, grant_expired, price_moved, ...): read them
> before retrying. Report only transaction hashes a tool returned. Give every money tool an idempotency_key so a retry
> never trades twice.

## Which tool, when

| The person asks | Call |
|---|---|
| "What's the H100 price, and where does it come from?" | `get_prices` with `gpu` |
| "What would $50 of H100 November get me?" | `quote` |
| "I rent 8 GPUs for 30 days: how big is the hedge?" | `size_for`, then `quote` |
| "Lock in what I pay for H100 in November." | `my_limits`, `quote`, then `open_long` |
| "Protect what my GPUs earn in November." | `my_limits`, `quote`, then `open_short` |
| "Pay me as the month goes." | `open_long` or `open_short` with `pay_me_daily: true` |
| "Close it." | `get_portfolio`, then `close_long`, `close_long_daily` or `close_short` |
| "Keep my hedge going into next month." | `keep_hedge_going`, or `roll_long` once |
| "Do it, even though it's above your cap." | `request_approval`, hand over the link, then `approval_status` |
| "What did you do?" | `activity` |

## Read

### `get_prices`

Today's index price per GPU and the tradable months with their best bid and ask and their range.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `gpu` | gpu | every GPU | one GPU only |

Returns a list, one entry per GPU: `gpu`, `price` (`null` before the first final day), `priceDate`, `change` (from
the day before), `clouds` (`"5 of 6"`: sources counted of the panel), `tradable`, and `months`, each with `month`,
`symbol`, `phase`, `quote` (bid, ask, last), `floor`, `cap` (the ceiling), `openInterest` and `closesAt`.

### `quote`

What a trade would do now, without trading.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `gpu` | gpu | required | |
| `month` | month | required | |
| `side` | `"long"` or `"short"` | required | |
| `dollars` | number | required for a Long | what the Long spends |
| `gpu_hours` | number | required for a Short | what the Short sells |

A Long returns `gpuHours`, `avgPrice`, `mostYouCanLose`, `mostYouCanWin` and `band` (`lo`, `hi`). A Short returns
`saleProceeds`, `collateral` (GPU-hours times the ceiling), `netCost`, `mostYouCanLose`, `mostYouCanWin` and `band`.
Refuses `no_market` for a month with no book, `bad_input` without the amount its side needs.

### `size_for`

GPU-hours for a rental: `gpus` (whole number) times `days` (whole number) times 24. Returns `{ gpus, days, gpuHours }`.

### `get_portfolio`

No parameters. Returns `main` and `pocket`, each with `address`, `dollars` and `positions`.

### `my_limits`

No parameters. Returns the connection (`id`, `label`, `status`, `pocket`, `mainAccount`, `budget` and `perTradeCap`
in millionths of a dollar, `tradesPerDay`, `expiresAt`), `live`, `pocketDollars`, `perTradeCapDollars`,
`tradesLeftToday`, the `autopilot` orders on, and `allowed`: what the pocket may call, contract by contract.

### `activity`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `limit` | whole number, 1 to 100 | 30 | how many entries |

Newest first: each entry has `at`, `what` (for example `pocket.trade`, `pocket.refused`, `approval.requested`,
`autopilot.started`) and its details, trades with their transaction hashes.

### `approval_status`

| Parameter | Type | Meaning |
|---|---|---|
| `request_id` | UUID | from `request_approval` or a `needs_approval` answer |

Returns `request_id`, `status` (`pending`, `approved`, `denied`, `done`, `failed` or `expired`), `summary`,
`result` (with the transaction hash once `done`) and `expiresAt`. Refuses `not_found` for a request of another
connection.

## Trade (from the pocket)

Every trade tool answers with one of these:

| `status` | Meaning | Fields |
|---|---|---|
| `done` | landed and succeeded | `action`, `summary`, `tx_hash`, `user_op_hash`, `explorer`, `seconds` |
| `reverted` | landed, and the chain refused it | the same |
| `sent` | sent, not seen landing yet | `user_op_hash`, `detail`: check `activity` before trying again |
| `needs_approval` | above the cap: nothing was sent | `request_id`, `approve_url`, `summary`, `note` |
| `refused` | a rule stopped it before anything was signed | `rule`, `detail` (and `quote` for a price refusal) |
| `error` | anything else | `message` |

A second call with an `idempotency_key` already used returns the first answer, marked `idempotent_replay: true`.
One connection runs one trade at a time.

Every trade carries a bound inside the router call, so the chain refuses a worse fill. Without `max_price` or
`min_price` the bound is the fresh quote less 1% slippage, and a buy that would average above the ceiling or a sale
below the floor is refused before sending (`above_band`, `below_band`): a sure loss at the month's end.

### `open_long`

Buy a month's GPU-hours for dollars. Above the cap it becomes `needs_approval`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `gpu`, `month` | | required | |
| `dollars` | number | required | what it spends, at most the cap |
| `pay_me_daily` | boolean | `false` | pay each day as it becomes final, to the main account; the floor for the days left comes back to the pocket at once |
| `max_price` | number | none | the most per GPU-hour on average |
| `idempotency_key` | string | none | |

### `open_short`

Sell a month's GPU-hours. The pocket puts up the ceiling for each GPU-hour; the sale's proceeds come back to it at
once. Collateral above the cap, or more GPU-hours than the connection's per-short limit, becomes `needs_approval`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `gpu`, `month` | | required | |
| `gpu_hours` | number | required | what it sells |
| `pay_me_daily` | boolean | `true` | paid daily to the main account; `false` pays at the month's end |
| `min_price` | number | none | the least per GPU-hour on average |
| `idempotency_key` | string | none | |

### `close_long`

Sell GPU-hours the pocket holds: `gpu`, `month`, `gpu_hours` (required), `min_price`, `idempotency_key`.

### `close_long_daily`

End pay-me-daily Long positions early: `gpu`, `month`, `position_ids` (1 to 20, from `get_portfolio`), `min_price`,
`idempotency_key`.

### `close_short`

Buy Short positions back: `gpu`, `month`, `position_ids` (1 to 20), `max_dollars` (the most it may spend),
`idempotency_key`. Spending above the cap becomes `needs_approval`, checked again once the buy-back is priced.

### `roll_long`

Sell a held month and buy a later month of the same GPU with the proceeds, in one transaction (both or neither).

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `gpu` | gpu | required | |
| `from_month`, `to_month` | month | required | |
| `gpu_hours` | number | all held | |
| `min_price` | number | none | guards the sale |
| `max_price` | number | none | guards the buy |
| `idempotency_key` | string | none | |

Proceeds above the cap are refused (`over_per_trade_cap`): roll in parts.

### `get_test_dollars`

Take the pocket's test dollars from the faucet (once every 24 hours): `idempotency_key`.

### `request_approval`

Ask the person to approve a trade the AI may not make alone.

| Parameter | Type | Meaning |
|---|---|---|
| `action` | `"open_long"`, `"open_short"` or `"close_short"` | the trade |
| `args` | object | that tool's parameters |
| `note` | string, at most 500 characters | why, shown to the person |

Returns `needs_approval` with `approve_url` (`https://agate.elpabl0.xyz/app/approve?request=<id>`). The request
lives 15 minutes. Once approved it runs from the person's main account (a Short's close from the pocket, signed by
the main wallet).

### `keep_hedge_going`

Autopilot: roll the pocket's Long of a GPU into the next listed month before the held month closes, in parts under
the cap. Each roll is a trade and counts against the day.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `gpu` | gpu | required | |
| `lead_minutes` | whole number, 10 to 10,080 | 60 | how long before the close it rolls |

One order per GPU: asking again returns the existing one (`already_on: true`). Returns `order_id`, `gpu`,
`lead_minutes`, `status`.

### `stop_keep_hedge_going`

`order_id` (UUID, from `keep_hedge_going` or `my_limits`). Positions stay as they are. Refuses `not_found` for an
order of another connection.

## Refusals

A refusal is `{ "status": "refused", "rule": "<rule>", "detail": "<sentence>" }`, with the MCP error flag set.
Nothing was signed or sent. Every rule, what triggers it and what to do: [Errors](17-errors.md#mcp-refusals).

## Rules for agents

The rules the server sends are quoted at the top of this page. The full guide for an agent, with what must go back
to the person: [For agents](18-agents.md). When people ask what they are buying, tell them what backs a token
([The monthly market](05-the-market.md)): a cash-settled claim on the month's average price, fully paid for up front.
