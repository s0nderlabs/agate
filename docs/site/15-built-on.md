---
slug: built-on
title: Built on
description: Monad, Chainlink CRE, Kuru, Envio, Dynamic, ZeroDev and Alchemy, and where each one sits in the code.
group: Background
order: 15
source: 'README.md'
---

# What agate stands on, and where to find it in the code.

## Monad

- **An order book needs fast, cheap blocks.** Each month trades on an onchain order book; sub-second blocks let a
  person or an AI place, fill and close in seconds, and let the market maker requote cheaply.
- **The price is many small transactions.** Hourly readings from two writers, daily closes and countersigns cost
  little and land fast.
- **128 KB contracts.** `AgateIndex` and its libraries are built and tested against Monad's code size limit.

## Chainlink CRE: the primary price writer

A CRE workflow fetches every cloud's page through CRE's HTTP capability, the nodes agree on each parsed number, and the
report reaches `AgateIndex` through Chainlink's forwarder (`onReport`). Today it runs in CRE's simulator with
`--broadcast` on agate's server; a deployment on Chainlink's network makes the agreement step decentralized.
Code: `wall/apps/writer-cre` (the workflow in `workflow/handler.ts`), `contracts/src/interfaces/IReceiver.sol`.

## Kuru: the order books

Every month of every GPU has its own Kuru V1 order book against the test dollar. The lister creates it when the month
opens, the market maker quotes both sides, the router buys and sells through it inside one call, and the SDK reads
the book level by level. Code: `contracts/src/market/interfaces/IKuruRouter.sol` and `IKuruOrderBook.sol`,
`wall/apps/payer` (lister), `wall/apps/marketmaker`, `client/src/book.ts`.

## Envio: the indexer

An Envio HyperIndex indexer follows the index, every series and the Kuru books over HyperSync, and serves balances,
positions, payouts, daily prices, trades and candles over GraphQL. It runs on Envio Cloud and on agate's server; the
app asks Envio Cloud first. Code: `indexer/` (`config.yaml`, `schema.graphql`).

## Dynamic: sign-in and wallets

Email codes, Google and passkeys; an embedded TSS-MPC wallet per person; step-up before sensitive actions; a second
wallet (the Assistant) delegated to agate only when a person connects an AI; server wallets for the payer and for an
AI company's own agent; delegation webhooks; and a Transaction Review endpoint, built and waiting for Dynamic to turn
it on for Monad testnet. Code: `wallet/src/dynamic.ts`, `server/src/dynamic/`, `wall/packages/market/src/dynamic-signer.ts`,
`server/src/company/agent.ts`, the environment as code in `ops/dynamic/`.

## ZeroDev: smart accounts and gas

Every person's main account and every AI pocket is a Kernel v3.1 smart account (ERC-4337, EntryPoint 0.7) with
sponsored gas. A pocket's limits are a session key enforced by the account: a call policy (only agate's router, a cap
per trade, the main account as payee), a rate limit (trades a day) and a timestamp (the end date). Code:
`wallet/src/kernel.ts`, `pocket.ts`, `allowed.ts`, `sponsor.ts`.

## Alchemy: transactions and the app's reads

agate's processes send their transactions through Alchemy, and the attester and keeper follow the chain over its
websocket; every process meters its compute units per method against a daily budget. The hosted app reads through an
Alchemy key locked to agate's own domains, with the public RPC after it. Code: `wall/packages/report/src/meter.ts`,
`ops/testnet/`.

## Code and data we build on

- **Price data:** each cloud's own public pricing page (Verda, Nebius, Lambda, CoreWeave, Civo, Hyperstack), read as
  published; the ECB's euro reference rates. GPU Economy (CC BY 4.0) and GPUTable are read only to check our readings,
  never as an input. Traded GPU prices from the Akash chain are shown for comparison only.
- **Libraries:** OpenZeppelin Contracts and forge-std; viem; Next.js, React and TanStack Query; Hono; the MCP TypeScript
  SDK; Dynamic's and ZeroDev's SDKs; the Chainlink CRE SDK and Envio as dependencies, not vendored.
- **Fonts:** Apfel Grotezk by Collletttivo (SIL OFL 1.1); Erode by the Indian Type Foundry (ITF Free Font License).
