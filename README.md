# agate

agate makes the price of compute tradable.

It turns GPU compute into a financial asset: an open onchain price for GPU-hours that anyone, whether a person, an app or an agent, can trade, hedge or build on.

## Why

GPU rental prices move fast, and there is no open way to lock one in. Renters cannot hedge a rising compute bill, GPU owners cannot protect their income, and there is no open, multi-source price for compute onchain.

## How it works

1. **A standard unit.** One GPU-hour of a defined GPU model, rented on demand.
2. **An open price.** For each GPU model, the clouds' own public price pages are read every hour and combined into a median of companies. A second, independent reader checks the same pages and must countersign every change, so no single key can move the price. Every source is shown beside the median and the method is public. A Chainlink CRE workflow carries the index onchain on Monad.
3. **A cash-settled claim.** One token per GPU model per month that pays the month's average index price, clamped between a floor and a ceiling (half and twice the reference price). Going short means locking the ceiling and selling the token, so every token is fully backed. Holders are paid after the month, or daily if they choose. No GPUs change hands.

Six GPU models have a daily index price: H100, H200, B200, B300, A100 and L40S. The first three also have monthly markets; the other three are price only for now.

## Ways in (planned)

- **Web app:** see the price, trade it, hedge with it.
- **API:** for developers.
- **Onchain feed:** for contracts that need a compute price.
- **Agent connector (MCP):** for agents that analyze or trade.

## Repository

- `contracts/`: the index contract `AgateIndex` and the market contracts in `src/market/` (Foundry). `forge install --no-git foundry-rs/forge-std@v1.17.0 && forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.4.0 && forge test`
- `wall/`: the price readers, the two writers (Chainlink CRE and a standby), the watcher and attester, the guardian CLI, a page check that compares each price with public price trackers, a repair agent that drafts a fix when a cloud changes its page (a person approves every change, which then takes effect after a 48-hour notice), a reader of traded GPU prices on the Akash chain (shown for comparison only), the market bots (a market maker that keeps buy and sell orders on Kuru for every open month, a lister that opens each new month's market, and a payer that pays out daily positions), and end-to-end and chaos tests on a local chain and on a fork of Monad testnet. `cd wall && bun install && bun test`
- `client/`: `@agate/client`, the app's live data layer: every screen's data (index prices and their sources, months, the Kuru book, fills, candles, wallets, open orders) read from the chain and the indexer, and every user action (test dollars, long, short, pay me daily, claims, limit orders) with price and depth guards, plus an end-to-end run of every flow. `cd client && bun install && bun test`
- `ops/testnet/`: the operator kit for Monad testnet: deploy scripts for the index and the market, the processes' start and stop scripts, a status check and the runbook (`ops/testnet/RUNBOOK.md`).
- `app/`: the web app (Next.js): the trade screen with Simple and Pro modes (index price, the month's market price, chart, Kuru book, order ticket, positions and open orders), the index page and test-dollar sign-in. It runs on example data for now; `@agate/client` brings in the live data next. A Mock controls panel for comparing design options is on in development and off in production builds (`NEXT_PUBLIC_MOCK_CONTROLS`). `cd app && bun install && bun dev`
- `indexer/`: an Envio HyperIndex indexer of the market, the index and the Kuru order books, serving balances, positions, payouts, daily prices and each month's market price over GraphQL. `cd indexer && bun install && bun run test`

## Status

Early. The index, its checking system, the market contracts, the bots and the indexer are built and tested on local chains and on forks of Monad testnet. Since Oct 4 2026 the real-calendar index and the market run on Monad testnet (addresses in `contracts/deployments/10143.json` and `10143-indexes.json`). The app's screens are built on example data; wiring them to the live chain is next.
