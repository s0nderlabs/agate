# agate

agate makes the price of compute tradable.

It turns GPU compute into a financial asset: an open onchain price for GPU-hours that anyone, whether a person, an app or an agent, can trade, hedge or build on.

## Why

GPU rental prices move fast, and there is no open way to lock one in. Renters cannot hedge a rising compute bill, GPU owners cannot protect their income, and there is no open, multi-source price for compute onchain.

## How it works

1. **A standard unit.** One GPU-hour of a defined GPU model, rented on demand.
2. **An open price.** For each GPU model, the clouds' own public price pages are read every hour and combined into a median of companies. A second, independent reader checks the same pages and must countersign every change, so no single key can move the price. Every source is shown beside the median and the method is public. A Chainlink CRE workflow carries the index onchain on Monad.
3. **A cash-settled claim.** One token per GPU model per month that pays the month's average index price, clamped between a floor and a ceiling (half and twice the reference price). Going short means locking the ceiling and selling the token, so every token is fully backed. Holders are paid after the month, or daily if they choose. No GPUs change hands.

**What backs a token (it is not created out of thin air).** A token is not a GPU-hour stored somewhere: like power futures, it is a cash-settled claim on a price, and no GPU changes hands. But a token only comes into existence when someone locks the month's ceiling in dollars ($8.00 a GPU-hour for H100 in November 2026). That one deposit makes two sides: the token, worth the month's average price (between the floor, $1.95, and the ceiling), and a short position, worth the ceiling minus that average. Together they always pay exactly the $8.00 that was locked, so every dollar any holder can be paid is already in the contract. Power futures rest on the same idea (an agreement settled in cash on an index, such as the month's average day-ahead power price) but are backed by margin and a clearinghouse that can ask for more money; agate locks the whole worst case up front instead, which the floor and ceiling make possible: no margin calls, no liquidations, and no one can owe more than they put in.

Six GPU models have a daily index price: H100, H200, B200, B300, A100 and L40S. The first three also have monthly markets; the other three are price only for now.

## Ways in

- **Web app** (live on Monad testnet, https://agate.elpabl0.xyz): see the price, trade it, hedge with it. Sign in with an email code, Google or a passkey; trades use free test dollars and gas is sponsored.
- **Agent connector (MCP, live):** any AI app that can add a remote MCP server (Claude, Codex, Hermes, OpenClaw and others) reads prices and trades from its own pocket within limits the person sets. Steps per app: `agents/AGENTS.md`.
- **Onchain feed (live):** the index is a contract on Monad testnet that other contracts can read, plus a Chainlink-style feed per GPU (`latestRoundData()`, 6 decimals) for code that already reads Chainlink: [`docs/onchain.md`](docs/onchain.md). How the price is made: [`docs/method.md`](docs/method.md). Judges: [`JUDGES.md`](JUDGES.md).
- **Developer API (live, read-only):** prices with every source, daily history, the months on sale with their books, trades, candles and a status line, as JSON with no key: https://agate.elpabl0.xyz/api/v1 (docs: [`docs/api.md`](docs/api.md), OpenAPI at `/v1/openapi.json`).

## Why Monad

- **An order book needs fast, cheap blocks.** Each month trades on Kuru's onchain order book; Monad's sub-second
  blocks and finality let a person or an AI place, fill and close in seconds, and let our market maker requote cheaply.
- **The price is written every day, by two writers, with a countersign.** Hourly readings, daily closes and the
  attester's checks are many small transactions; on Monad they cost little and land fast.
- **No wallet for the user.** Every person and every AI pocket is a smart account (ZeroDev Kernel) with sponsored gas,
  signed in through Dynamic, so a trade is one tap.
- **The ecosystem's stack:** Chainlink CRE writes the price through Monad's forwarder, Envio indexes the index, the
  markets and Kuru's books over HyperSync, Alchemy carries our services' transactions.

## Architecture

```
 clouds' price pages --hourly--> writers: Chainlink CRE workflow + standby --> AgateIndex (Monad)
                                  watcher -> attester (countersign) / guardian (veto)  ^
                                                                                       | final daily prices
 web app (Next.js, Dynamic, ZeroDev) --+                                               |
 AI apps (MCP, OAuth 2.1) --> agate server (Hono) --+--> router --> monthly series (one token per GPU per month)
 developers --> /api/v1 (read-only) ---------------+          \--> Kuru order books   <-- market maker, lister, payer
                                                  Envio HyperIndex (GraphQL) <-- every contract's events
```

**Stack:** Solidity 0.8.30 with Foundry (contracts); TypeScript on Bun (price readers, writers, watcher, bots, server,
client); Chainlink CRE (TypeScript SDK); Next.js 16, React 19 and TanStack Query (app, on Vercel); viem; Dynamic and
ZeroDev (accounts, delegated AI wallets, sponsored gas); Kuru V1 (order books); Envio HyperIndex (indexer); Hono and the
MCP SDK (server); one Linux server for the always-on processes.

## Repository

`app/`, `client/`, `wallet/` and `server/` are one bun workspace: `bun install` at the repo root installs all four
(hoisted, see `bunfig.toml`). `wall/` and `indexer/` install on their own.

- `contracts/`: the index contract `AgateIndex` and the market contracts in `src/market/` (Foundry). `forge install --no-git foundry-rs/forge-std@v1.17.0 && forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.4.0 && forge test`
- `wall/`: the price readers, the two writers (Chainlink CRE and a standby), the watcher and attester, the guardian CLI, a page check that compares each price with public price trackers, a repair agent that drafts a fix when a cloud changes its page (a person approves every change, which then takes effect after a 48-hour notice), a reader of traded GPU prices on the Akash chain (shown for comparison only), the market bots (a market maker that keeps buy and sell orders on Kuru for every open month, a lister that opens each new month's market, and a payer that pays out daily positions, which can sign with a Dynamic server wallet instead of a key), and end-to-end and chaos tests on a local chain and on a fork of Monad testnet. `cd wall && bun install && bun test`
- `client/`: `@agate/client`, the app's live data layer: every screen's data (index prices and their sources, months, the Kuru book, fills, candles, wallets, open orders) read from the chain and the indexer, and every user action (test dollars, long, short, pay me daily, claims, limit orders) with price and depth guards, plus end-to-end runs of every flow: on a fork of Monad testnet, and a guarded real-user journey on a live demo market (`bun run e2e/run.ts testnet`). It also plans the same actions as call batches without sending them (`plan.ts`), for smart accounts and for agate's server. `cd client && bun test`
- `ops/testnet/`: the operator kit for Monad testnet: deploy scripts for the index and the market, the processes' start and stop scripts, demo sessions (a fast-clock index whose month lasts five hours), a status check and the runbook (`ops/testnet/RUNBOOK.md`). The processes send their own transactions through Alchemy, with the attester's live feed and a daily compute-unit budget, and read through free public RPCs.
- `app/`: the web app (Next.js): the trade screen with Simple and Pro modes (index price, the month's market price, chart, Kuru book, order ticket, positions and open orders), the index page, a positions page and test-dollar sign-in, laid out for phones, tablets and desktop, plus the "Connect your AI" screens (the Allow page for AI apps, connected AIs with their pockets, Autopilot and disconnect, and approvals for trades over the limit). It reads the live testnet through `@agate/client` (or example data, switchable in development). Signed in through Dynamic, a person trades from their own smart account with sponsored gas and the AI screens talk to agate's server; signed out, a practice account stands in. A Mock controls panel for comparing design options is on in development and off in production builds (`NEXT_PUBLIC_MOCK_CONTROLS`). `cd app && bun dev`
- `wallet/`: `@agate/wallet`, accounts on Dynamic and ZeroDev, shared by the app and the server: Dynamic sign-in (email code, Google, a passkey added after sign-up, step-up by code or passkey), the main wallet and a separate Assistant wallet for AIs, the main account and each AI's pocket as Kernel smart accounts with sponsored gas, the pocket's onchain session key (only agate's router, a per-trade cap, a daily trade count and an end date; profits pay out to the main account only), the take-back, and a lab page for live tests. `cd wallet && bun test` (`FORK=1` adds the pocket's limits on a fork of Monad testnet)
- `server/`: agate's always-on service behind "Connect your AI": Dynamic's delegation webhooks and Transaction Review, each AI connection's limits (checked again before every signature), the MCP server for AI apps (a connector URL or OAuth 2.1), approvals for trades above the cap, the autopilot that keeps a hedge rolling into the next month, an AI company's own agent on a Dynamic server wallet, and the markets snapshot the app loads in one request (`GET /api/markets`). The app's contract is `server/API.md`. `cd server && bun test`
- `agents/`: what an AI app reads to use agate: `AGENTS.md`, `llms.txt` and a Claude plugin skill.
- `ops/server/`: the same kit split across a Linux server and a second machine: a systemd unit and start script that run every process except the standby writer on the server at boot, a stand-in for the macOS key store that reads owner-only files, a read-only public door to the indexer, and a forwarder that shows the server's alerts as notifications on the local machine. The setup is in the runbook ("Split across a local machine and a server").
- `ops/dynamic/`: the Dynamic environment as code (`sandbox.json`, no secrets) and the scripts that export, compare and apply it.
- `indexer/`: an Envio HyperIndex indexer of the market, the index and the Kuru order books, serving balances, positions, payouts, daily prices and each month's market price over GraphQL. `cd indexer && bun install && bun run test`

## Status

Early. The index, its checking system, the market contracts, the bots and the indexer are built and tested on local chains and on forks of Monad testnet. Since Oct 4 2026 the real-calendar index and the market run on Monad testnet (addresses in `contracts/deployments/10143.json` and `10143-indexes.json`). On Oct 5 a real-user journey passed every check on a live demo month: test dollars, long, short, pay me daily, a limit order, the daily claim, the month end and the settle. The app reads the live testnet through `@agate/client`. The Dynamic layer (sign-in, the main account and each AI's pocket, the MCP server, approvals and the autopilot) was exercised live on Oct 4, including real trades by an AI from its pocket, and is wired into the app. Since Oct 6 the robots and the AI server run on a rented server and the app on Vercel. On Oct 8 a full pass passed: every package's tests, the live services, a fork journey through the month end, and a signed-in run on a real account (test dollars, a Long with pay me daily and its close, a Short and its close, connecting an AI and disconnecting it), with Hermes and OpenClaw calling agate's tools through a connector URL.

## Attribution

- **Price data:** each cloud's own public pricing page (Verda, Nebius, Lambda, CoreWeave, Civo, Hyperstack), read as
  published; the ECB's euro reference rates. GPU Economy (CC BY 4.0) and GPUTable are read only to check our readings,
  never as an input. Traded GPU prices from the Akash chain are shown for comparison only.
- **Code we build on:** OpenZeppelin Contracts (MIT) and forge-std (MIT/Apache-2.0); viem (MIT); Next.js, React and
  TanStack Query (MIT); Hono (MIT); the MCP TypeScript SDK (MIT); Dynamic's and ZeroDev's SDKs; the Chainlink CRE SDK
  (used as a dependency, not vendored); Envio (used as a dependency, not vendored). Kuru's contracts are called through
  interfaces that declare only the functions agate uses, from Kuru's public documentation and SDK.
- **Fonts:** Apfel Grotezk by Collletttivo (SIL OFL 1.1, self-hosted); Erode by the Indian Type Foundry (ITF Free Font
  License, loaded from Fontshare).

## Built with AI tools

agate was built with AI coding tools (Claude Code). The team directed the work, reviewed it and tested it, and every
change went through code review and the test suites.

## License

MIT, see [LICENSE](LICENSE).
