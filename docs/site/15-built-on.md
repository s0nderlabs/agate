---
slug: built-on
title: Built on
description: Monad, Chainlink CRE, Kuru, Envio, Dynamic, ZeroDev and Alchemy: where each one sits in the code, and onchain proof that it runs.
group: Background
order: 15
source: 'README.md'
---

# What Agate stands on, where to find it in the code, and proof that it runs.

Every transaction below is on Monad testnet and opens in the explorer. Counts are from the chain (read through Envio
HyperSync) and from Agate's indexer, as of Oct 9 2026.

## Monad

- **An order book needs fast, cheap blocks.** Each month trades on an onchain order book; sub-second blocks let a
  person or an AI place, fill and close in seconds, and let the market maker requote cheaply.
- **The price is many small transactions.** Hourly readings from two writers, daily closes and countersigns cost
  little and land fast.
- **128 KB contracts.** `AgateIndex` and its libraries are built and tested against Monad's code size limit.

## Chainlink CRE: the primary price writer

A CRE workflow fetches every cloud's page through CRE's HTTP capability, the nodes agree on each parsed number, and the
report reaches `AgateIndex` through Chainlink's forwarder (`onReport`). The workflow also reads the chain itself (EVM
reads through Multicall3, batched under CRE's 5 kb reply limit): before fetching, the index's clock and which GPUs this
writer already posted for the hour, so those stay out of the report (all of them posted: nothing fetched or written);
after the write, the same read again (once more for any GPU not seen yet), reporting which GPUs landed, because the
forwarder swallows a failed `onReport`. Today it runs in CRE's simulator with
`--broadcast` on Agate's server; a deployment on Chainlink's network makes the agreement step decentralized.
Code: `wall/apps/writer-cre` (the workflow in `workflow/handler.ts`), `contracts/src/interfaces/IReceiver.sol`.

**Proof.**
- **250 CRE reports** written to the live index through the CRE forwarder since Oct 4, every one successful; the
  writer fell back to posting directly 19 times, so 93% of the index's readings arrived through CRE. Writer
  `0xf0be5c7461c0743acde590a22bccb66fc2112335`, forwarder `0xb9f79d863261869b234c481d1f9a7af84aead192`.
- First report (Oct 4): [`0x47751afb...`](https://testnet.monadexplorer.com/tx/0x47751afb9ed7bf84253e5dc5eb42a97685a503997f62aba9b2bcf0f165d70df1). A recent one:
  [`0x2d48b837...`](https://testnet.monadexplorer.com/tx/0x2d48b837a896f66570d596f8f8f400f80e99a100483ae9f3802bbc2d791d11ed). Each run reads six clouds' pages and the
  ECB's euro rate, about 27 readings across six GPUs, with the nodes agreeing field by field on the median.
- Every report lands in `AgateIndex.onReport` (`contracts/src/AgateIndex.sol:94`), which accepts only the forwarder.

## Kuru: the order books

Every month of every GPU has its own Kuru V1 order book against the test dollar. The lister creates it when the month
opens, the market maker quotes both sides, the router buys and sells through it inside one call, and the SDK reads
the book level by level. Code: `contracts/src/market/interfaces/IKuruRouter.sol` and `IKuruOrderBook.sol`,
`wall/apps/payer` (lister), `wall/apps/marketmaker`, `client/src/book.ts`.

**Proof.**
- **12 Kuru markets created** by Agate's factories: the three live November books (H100
  [`0x0993a12e...`](https://testnet.monadexplorer.com/tx/0x0993a12e4e2c9ead07ad59c632dc2cbe18c55d367fa3e231d83740fe2aab94c5), H200
  [`0x9a110aa4...`](https://testnet.monadexplorer.com/tx/0x9a110aa434820b6e5f6b83d4f4b48eea68dd84f63747341fada4da94df3d2fc8), B200
  [`0x7a3a478e...`](https://testnet.monadexplorer.com/tx/0x7a3a478e7579d6ac01e3842bdfe7ab6e01e02c457c956232ceb51981350fde38)) and nine fast-clock demo months.
- **33 trades, 2,050 GPU-hours, $9,180 in test dollars** from 7 accounts; 15 of the trades ($8,699) on the November
  books. Agate's own market maker is on one side of every trade so far.
- One of each action: a Long (router market buy) [`0xabee0211...`](https://testnet.monadexplorer.com/tx/0xabee02118e0be46d106b6dc2b2a713eafb10b65bf194efbbf58b76005f4d684a);
  a Short (mint and sell) [`0x18b13f53...`](https://testnet.monadexplorer.com/tx/0x18b13f53dc0f76e23c7692224da57a95d267529a432325f46df9b3a0b519932a); a Short bought back
  [`0x9284b3e5...`](https://testnet.monadexplorer.com/tx/0x9284b3e566e0ca4e3469608d5d0dc89c06253f029ab3dab3c4abbe7810b56af1); a resting limit order
  [`0x6a17321f...`](https://testnet.monadexplorer.com/tx/0x6a17321fbfae99b7c3cd37f628f52d3e9312430c0addd4a5f9c59e075256f2c7), its cancel
  [`0x31376ac1...`](https://testnet.monadexplorer.com/tx/0x31376ac12f703f75881fa88f7adba1b56553f82f318c3ba04e5d4113c52bcacb) and the margin withdrawal
  [`0xdfdf5ecb...`](https://testnet.monadexplorer.com/tx/0xdfdf5ecb8368ac48f9c04b9d6a4a9cbbcafe198cfb563a76c75196f9b0d24298); the market maker requoting the H100
  book in one batch [`0x6e621d62...`](https://testnet.monadexplorer.com/tx/0x6e621d62ba2044dbadbeb9b7e7048db046fb60cba9d2d19c788c307fd627d6ed) (459 maker transactions so far).

## Envio: the indexer

An Envio HyperIndex indexer follows the index, every series and the Kuru books over HyperSync, and serves balances,
positions, payouts, daily prices, trades and candles over GraphQL. It runs on Envio Cloud and on Agate's server; the
app asks Envio Cloud first. Code: `indexer/` (`config.yaml`, `schema.graphql`).

**Proof.**
- Hosted on Envio Cloud (project `s0nderlabs/agate`, redeployed on every push to main):
  `https://indexer.dev.hyperindex.xyz/4b2eb56/v1/graphql`. A copy runs on Agate's server:
  `https://agate-1.tailf06dd7.ts.net:8443/v1/graphql`. Both had processed 13,253 events, caught up to the chain head.
- 41 events across the index, the factories, every series, the router, the test dollar and Kuru; 29 entities; each
  Kuru book is registered from the factory's `MarketRecorded` event as it is created (`indexer/src/handlers/factory.ts:125`),
  and a block handler keeps each month's clock (`indexer/src/handlers/clock.ts`).
- It drives the app's candles, the trades tape, the month's market price, positions and payouts, and the developer
  API's `/v1/trades` and `/v1/candles`. Try it:

```sh
curl -s https://indexer.dev.hyperindex.xyz/4b2eb56/v1/graphql -H 'content-type: application/json' \
  -d '{"query":"{ chain_metadata { latest_processed_block num_events_processed } }"}'
```

## Dynamic: sign-in and wallets

Email codes, Google and passkeys; an embedded TSS-MPC wallet per person; step-up before sensitive actions; a second
wallet (the Assistant) delegated to Agate only when a person connects an AI; server wallets for the payer and for an
AI company's own agent; delegation webhooks; and a Transaction Review endpoint, built and waiting for Dynamic to turn
it on for Monad testnet. Code: `wallet/src/dynamic.ts`, `server/src/dynamic/`, `wall/packages/market/src/dynamic-signer.ts`,
`server/src/company/agent.ts`, the environment as code in `ops/dynamic/`.

**Proof.**
- **A person's trade from the app:** a Dynamic embedded wallet signs for the person's smart account, gas sponsored,
  for example a pay-me-daily Long on Oct 8 [`0x7ded45fe...`](https://testnet.monadexplorer.com/tx/0x7ded45fe05334d825952d5da5b3db442416f754a16e72485a0f3559cf4ae1fcf).
- **Delegated access:** Agate's server has received 8 `wallet.delegation.created` webhooks and signed 15 times with
  delegated Assistant wallets. An AI's trade from its pocket, signed that way:
  [`0x97011f94...`](https://testnet.monadexplorer.com/tx/0x97011f941530d99490aef4d157245dbf1cc077bd20c42d67a04fddadb78c2087); the autopilot rolling a hedge into the
  next month: [`0x6d94893d...`](https://testnet.monadexplorer.com/tx/0x6d94893df4d7765a6af940ce978aefaa821af35a9e2d6f0d9b1c630f692a7723); 4 delegations revoked by
  disconnects.
- **Above the cap:** an AI asked, the person approved, and the trade ran from their main account:
  [`0xabee0211...`](https://testnet.monadexplorer.com/tx/0xabee02118e0be46d106b6dc2b2a713eafb10b65bf194efbbf58b76005f4d684a).
- **Server wallets:** an AI company's agent bought GPU-hours from its own Dynamic server wallet
  [`0x79f908d9...`](https://testnet.monadexplorer.com/tx/0x79f908d996a6a55fd367d3e2ba852e49a315a81a48871fc1354852b93531a21a). The live payer signs with the Dynamic
  server wallet `0x31BC1a1A7d4B6dD5888B584016ce194c27b82c45` (November's daily payouts begin Nov 1).
- **Transaction Review:** Agate's endpoint has received 7 review calls from Dynamic and refused each, because the
  request signature did not verify; it waits on Dynamic's side for Monad testnet.

## ZeroDev: smart accounts and gas

Every person's main account and every AI pocket is a Kernel v3.1 smart account (ERC-4337, EntryPoint 0.7) with
sponsored gas. A pocket's limits are a session key enforced by the account: a call policy (only Agate's router, a cap
per trade, the main account as payee), a rate limit (trades a day) and a timestamp (the end date). Code:
`wallet/src/kernel.ts`, `pocket.ts`, `allowed.ts`, `sponsor.ts`.

## Alchemy: transactions and the app's reads

Agate's processes send their transactions through Alchemy, and the attester and keeper follow the chain over its
websocket; every process meters its compute units per method against a daily budget. The hosted app reads through an
Alchemy key locked to Agate's own domains, with the public RPC after it. Code: `wall/packages/report/src/meter.ts`
(the meter), `wall/apps/watcher/src/chain/send-route.ts` (the send route), `wall/apps/watcher/src/chain/ws-wake.ts`
(the websocket), `ops/testnet/`.

**Proof.** The signing processes (the writers, the attester, the keeper, the market maker and the payer) send their
own transactions, nonces and receipts through Alchemy, falling back to public RPCs on any outage or limit; the attester
and keeper keep an Alchemy websocket open. Usage on Oct 8: 11.49M of the month's 22.2M compute units, about 48K a day,
checked against the processes' own meter.

## Code and data we build on

- **Price data:** each cloud's own public pricing page (Verda, Nebius, Lambda, CoreWeave, Civo, Hyperstack), read as
  published; the ECB's euro reference rates. GPU Economy (CC BY 4.0) and GPUTable are read only to check our readings,
  never as an input. Traded GPU prices from the Akash chain are shown for comparison only.
- **Libraries:** OpenZeppelin Contracts and forge-std; viem; Next.js, React and TanStack Query; Hono; the MCP TypeScript
  SDK; Dynamic's and ZeroDev's SDKs; the Chainlink CRE SDK and Envio as dependencies, not vendored.
- **Fonts:** Apfel Grotezk by Collletttivo (SIL OFL 1.1); Erode by the Indian Type Foundry (ITF Free Font License).
