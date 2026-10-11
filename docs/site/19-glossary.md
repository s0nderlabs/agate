---
slug: glossary
title: Glossary
description: Every term the docs use, in one line each, with the page that explains it.
group: Background
order: 19
source: 'docs/site'
---

# Every word Agate uses, in one line.

The concept pages use these terms; each line links to where it is explained in full.

| Term | Meaning |
|---|---|
| **GPU-hour** | one GPU rented for one hour: the unit every price and size is in |
| **index price** | the day's price of a GPU-hour: the median across companies of what the clouds post on their own pages ([How the price is made](04-the-price.md)) |
| **market price** | what a month's token trades at on Kuru right now: the market's guess at that month's average index price |
| **source** | one cloud's public price page, read hourly |
| **panel** | the sources counted for a GPU; a **reserve** sits on the panel without counting until one leaves |
| **day id** | a UTC day as a number: days since Jan 1 1970 (Oct 9 2026 is 20735) |
| **close** | at 01:00 UTC the day before is closed: the contract computes its price from one writer's readings |
| **final** | a closed day that is settled for good: 6 hours after the close if nothing changed, else once countersigned. Markets read only final days |
| **countersign** | a second, independent key (the attester, or a guardian) confirming a changed day |
| **carried** | a day with no usable data, given the day before's price after 24 hours (`CARRIED` onchain, "carried, unverified" in the app) |
| **FULL, DEGRADED, DEMO** | a day's label by how many companies were fresh: 5 or more, 3 or 4, fewer (DEMO only on testnet) |
| **fresh, held** | a company is fresh when it read cleanly that day; held when it is counted at its last good day price (up to 5 days) |
| **writer** | a process that reads every page hourly and posts the readings: the Chainlink CRE workflow (primary) and the standby |
| **watcher, attester** | the watcher reads the same pages on its own; the attester countersigns or replaces a changed day by it |
| **guardian** | a person who can veto a day before it is final, or suspend a writer |
| **keeper** | the process that closes and carries days on time |
| **48-hour queue** | how any change to the index (a reader, a source) waits in public onchain before it applies |
| **month, series** | one GPU's month of trading, and the contract that holds it (`AgateSeries`) |
| **token** | the month's tradable token (`AgateToken`, for example H100-NOV26): pays that month's average price per GPU-hour |
| **pair** | a token plus a Short position, made together by locking the ceiling; together they always pay exactly the ceiling |
| **floor, ceiling (band)** | the month's range: every daily price is kept inside it; set once at listing ([The monthly market](05-the-market.md#the-floor-and-the-ceiling)) |
| **reference days** | the five final days whose average sets the band |
| **Long** | buying a month's token: locks what you pay for compute |
| **Short** | locking the ceiling and selling the token: locks what you earn from compute |
| **pay me daily** | a position paid day by day as each day becomes final, instead of at the month's end |
| **settle** | collecting at the end, once every day of the month is final |
| **roll** | selling one month and buying the next in one step |
| **lot** | the smallest size: 0.0001 GPU-hour; a Kuru order is at least 1 GPU-hour |
| **tick** | the smallest price step: $0.01 |
| **market maker** | Agate's bot that quotes both sides of every open month's book |
| **lister, payer** | the bots that open the next month's market, and pay daily positions |
| **test dollar (tUSD)** | the testnet dollar, 6 decimals, free from the faucet once every 24 hours; no value |
| **main account** | your smart account, made at sign-in; never delegated |
| **Assistant** | a second wallet of yours, delegated to Agate so it can sign an AI's trades |
| **pocket** | a separate account holding only the budget you gave one AI ([AI pockets and limits](07-ai-pockets.md)) |
| **grant, connection** | the permission for one AI: its pocket, budget, cap per trade, trades in 24 hours and end date |
| **connector URL** | a private MCP address for one connection, shown once; works like a password |
| **session key** | the onchain permission on the pocket that enforces the limits by itself |
| **approval** | the person's yes to one trade above the cap, by a link that lives 15 minutes |
| **autopilot** | `keep_hedge_going`: Agate rolls a Long into the next month before each close |
| **passkey account** | an account made from a passkey alone, with no email ([Accounts and gas](06-accounts.md#passkey-accounts)) |
| **step-up** | confirming again with a code or passkey before a sensitive action |
| **sponsored gas** | network fees paid by Agate through ZeroDev, so no account needs MON |
| **MCP** | the Model Context Protocol: how an AI app calls Agate's tools ([MCP tools](11-mcp-tools.md)) |

