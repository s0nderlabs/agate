---
slug: mcp-tools
title: MCP tools
description: Every tool an AI app gets from agate's MCP server, and the rules an agent follows.
group: Reference
order: 11
source: 'server/src/mcp/server.ts'
---

# Seventeen tools: read, trade inside the limits, ask when above them.

Connected through [Connect an AI](03-connect-an-ai.md), an AI app sees these tools. Reads always work; trades work
only while the connection is live, from the pocket, inside its limits ([AI pockets and limits](07-ai-pockets.md)).

## Read

| Tool | What it returns |
|---|---|
| `get_prices` | today's index price per GPU and the tradable months with their best bid and ask and their range |
| `quote` | what a trade would do now, without trading: GPU-hours, average price, and the most it can win or lose by the month's end (Long takes dollars, Short takes GPU-hours) |
| `size_for` | GPU-hours for G GPUs over D days (24 GPU-hours per GPU per day): the size of a hedge for a rental |
| `get_portfolio` | the person's main account and the AI's pocket: test dollars and positions in each |
| `my_limits` | the connection's limits and what is left: pocket balance, cap per trade, trades left today, end date, autopilot orders |
| `activity` | what the connection did, newest first: trades with transaction hashes, refusals, approvals |
| `approval_status` | the state of a trade sent to the person: pending, approved, denied, done (with its hash), failed or expired |

## Trade (from the pocket)

| Tool | What it does |
|---|---|
| `open_long` | buy a month's token with dollars; `pay_me_daily` makes it a daily position |
| `open_short` | put up the ceiling and sell GPU-hours of a month; optionally paid daily |
| `close_long` | sell GPU-hours of a month the pocket holds |
| `close_long_daily` | end pay-me-daily Long positions early |
| `close_short` | buy back a Short |
| `roll_long` | sell a held month and buy the next one in one step |
| `get_test_dollars` | take the pocket's daily test dollars (testnet) |
| `request_approval` | ask the person to approve a trade the AI may not make alone (above the cap); returns a link |
| `keep_hedge_going` | autopilot: roll the pocket's Long of a GPU into the next month before the held one closes |
| `stop_keep_hedge_going` | stop an autopilot order |

A refused trade comes back with the rule's name (over the cap, the daily count, the end date, the band), never as a
silent failure.

## Rules for agents

- Report only transaction hashes a tool returned.
- Pass an `idempotency_key` to every money tool. `status: "sent"` means sent but not yet seen landing: check
  `activity` before trying again.
- Above the cap, hand the person the approval link; never split a trade to dodge the cap.
- When asked what they are buying, tell people what backs a token ([The monthly market](05-the-market.md)): a
  cash-settled claim on the month's average price, fully paid for up front.

The same guide, written for agents, is `agents/AGENTS.md`; `agents/llms.txt` indexes the repo for them.
