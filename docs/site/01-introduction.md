---
slug: introduction
title: Introduction
description: Agate makes the price of compute tradable. An open onchain price for renting a GPU, and fully backed monthly markets on it.
group: Get started
order: 1
source: 'README.md'
---

# Agate makes the price of compute tradable.

Renting a GPU for an hour has a price, and that price moves. An AI company that sells at a fixed price while its GPU
bill floats is exposed to it; so is a cloud that bought GPUs and needs next month's rental income. Agate turns that
price into something anyone, a person, an app or an AI agent, can see, check, lock in or trade. No GPU changes hands:
you trade the price, settled in dollars.

## Three parts

| Part | What it is | Where it lives |
|---|---|---|
| **The price** | One number per GPU per day: what the clouds charge per GPU-hour on their own public price pages, read hourly and combined as a median of companies, with every source shown | `AgateIndex` on Monad, written by a Chainlink CRE workflow and countersigned by a second, independent reader |
| **The market** | One token per GPU per month that pays that month's average price, kept between a floor and a ceiling. Long locks what you pay; Short locks what you earn. Every token is fully backed | Monthly series contracts, traded on Kuru's onchain order book |
| **The ways in** | A web app with passkey, email or Google sign-in and no gas, an MCP server for AI agents, a developer API, an SDK, and Chainlink-style feeds for contracts | `app/`, `server/`, `client/`, `contracts/src/examples/` |

Six GPUs have a daily price today: H100, H200, B200, B300, A100 and L40S. The first three have monthly markets; the
other three are price only for now.

## Who it is for

- **Teams that rent GPUs** (inference clouds, AI and agent companies): go Long to fix next month's compute cost.
- **Teams that rent GPUs out** (neoclouds, GPU owners): go Short to fix next month's rental income.
- **Traders** with a view on compute prices.
- **AI agents** acting for any of the above, inside limits a person sets.
- **Builders** who need a compute price they can check: dashboards, lending against GPU income, insurance, research.

## What is live

Everything runs on Monad testnet with free test dollars, since Oct 4 2026:

- the daily price for six GPUs, onchain, with its sources ([How the price is made](04-the-price.md));
- the November 2026 markets for H100, H200 and B200 on Kuru, with a market maker quoting both sides
  ([The monthly market](05-the-market.md));
- the app at https://agate.elpabl0.xyz/app, with the site at https://agate.elpabl0.xyz and these docs at
  https://agate.elpabl0.xyz/docs ([Quickstart](02-quickstart.md));
- AI agents trading from their own pockets through MCP ([Connect an AI](03-connect-an-ai.md));
- the developer API at https://agate.elpabl0.xyz/api/v1 ([Developer API](08-api.md)) and a price feed per GPU for
  contracts ([Onchain](09-onchain.md)).

Test dollars and tokens have no monetary value. What a real-money version needs is in [Limits](16-limits.md).

## How the docs are organized

Five groups. **Get started**: this page, a three-minute tour of the app (at `/app`), connecting an AI, and a page for AI agents. **Concepts**: how the
price is made, how the monthly market works, accounts, and AI pockets. **Reference**: the API, onchain reading, the
SDK, the MCP tools, the contracts, every address, and every error. **Operate**: the architecture and how to run and test Agate yourself.
**Background**: what Agate is built on, its limits, and a glossary.
