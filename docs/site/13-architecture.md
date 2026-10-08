---
slug: architecture
title: Architecture
description: The price wall, the market, the doors in, and which process runs where.
group: Operate
order: 13
source: 'ops/testnet/RUNBOOK.md, ops/server'
---

# Three layers: a price, a market on it, and doors in.

```
 clouds' price pages --hourly--> writers: Chainlink CRE workflow + standby --> AgateIndex (Monad)
                                  watcher -> attester (countersign) / guardian (veto)  ^
                                                                                       | final daily prices
 web app (Next.js, Dynamic, ZeroDev) --+                                               |
 AI apps (MCP, OAuth 2.1) --> Agate server (Hono) --+--> router --> monthly series (one token per GPU per month)
 developers --> /api/v1 (read-only) ---------------+          \--> Kuru order books   <-- market maker, lister, payer
                                                  Envio HyperIndex (GraphQL) <-- every contract's events
```

1. **The price (the wall).** Readers turn each cloud's page into a number; two writers post hourly readings to
   `AgateIndex`; a watcher reads the same pages on its own so the attester can countersign or replace a changed day;
   a keeper closes and carries days on time. Details: [How the price is made](04-the-price.md).
2. **The market.** For each GPU and month, a series mints fully backed pairs, pays daily or at the end, and trades on a
   Kuru order book. Robots keep it running: a market maker quotes every open month, the lister opens next month's
   market, the payer syncs and pays daily positions. Details: [The monthly market](05-the-market.md).
3. **The doors.** The web app, AI apps through MCP, developers through the API, the SDK and the onchain feeds, all
   reading the same contracts.

## What runs where

| Process | Where | Code |
|---|---|---|
| primary writer (Chainlink CRE workflow) | server | `wall/apps/writer-cre` |
| standby writer | local machine | `wall/apps/writer-standby` |
| watcher logger, attester, keeper, health | server (the local machine keeps its own logger and health) | `wall/apps/watcher` |
| page check (compares readings with public trackers) | server | `wall/apps/pagecheck` |
| repair agent (drafts a reader fix for a person to approve) | local machine | `wall/apps/repair` |
| market maker | server | `wall/apps/marketmaker` |
| payer and lister | server, signing with a Dynamic server wallet | `wall/apps/payer` |
| Akash traded-price reader (comparison only) | server | `wall/apps/akash` |
| indexer (Envio HyperIndex) and its read-only public door | server, and Envio Cloud | `indexer/`, `ops/server/graphql-proxy.ts` |
| Agate server: MCP, OAuth, approvals, autopilot, markets snapshot, `/v1` | server | `server/` |
| web app | Vercel | `app/` |
| guardian | a person's command line | `wall/apps/guardian` |

The server is one Linux machine (Ubuntu 24.04) that starts the whole stack at boot in one tmux session
(`ops/server/stack.sh`, a systemd unit); Tailscale Funnel publishes the Agate server (443) and the indexer's door
(8443). The local half runs the roles that should not share a machine with the primary. A role never runs on both:
each machine lists the roles the other one owns. Operating it: `ops/testnet/RUNBOOK.md`.

## Keys and transactions

- Each role has its own key, read from the macOS key store (or, on the server, a stand-in that serves owner-only
  files), never printed and never in the repo.
- The processes send their transactions through Alchemy with a daily compute budget, and read through free public RPCs.
- Every write is simulated first; a call that would revert is never sent.
- People and AI pockets never hold MON: their smart accounts' gas is sponsored through ZeroDev.

## Alerts

Each machine runs its own health check on its own roles. Alerts (a late day, a low key balance, a reader off the
trackers by more than 10%, a stuck listing) reach a person as notifications on the local machine.
