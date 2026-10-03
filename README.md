# agate

agate makes the price of compute tradable.

It turns GPU compute into a financial asset: an open onchain price for GPU-hours that anyone, whether a person, an app or an agent, can trade, hedge or build on.

## Why

GPU rental prices move fast, and there is no open way to lock one in. Renters cannot hedge a rising compute bill, GPU owners cannot protect their income, and there is no open, multi-source price for compute onchain.

## How it works

1. **A standard unit.** One GPU-hour of a defined GPU model, rented on demand.
2. **An open price.** For each GPU model, the clouds' own public price pages are read every hour and combined into a median of companies. A second, independent reader checks the same pages and must countersign every change, so no single key can move the price. Every source is shown beside the median and the method is public. A Chainlink CRE workflow carries the index onchain on Monad.
3. **A cash-settled claim.** One token per GPU model per month that pays the month's average index price, clamped between a floor and a ceiling (half and twice the reference price). Going short means locking the ceiling and selling the token, so every token is fully backed. Holders are paid after the month, or daily if they choose. No GPUs change hands.

## Ways in (planned)

- **Web app:** see the price, trade it, hedge with it.
- **API:** for developers.
- **Onchain feed:** for contracts that need a compute price.
- **Agent connector (MCP):** for agents that analyze or trade.

## Repository

- `contracts/`: the index contract `AgateIndex` and the market contracts in `src/market/` (Foundry). `forge install --no-git foundry-rs/forge-std@v1.17.0 && forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.4.0 && forge test`
- `wall/`: the price readers, the two writers (Chainlink CRE and a standby), the watcher and attester, the guardian CLI, a page check that compares each price with public price trackers, a repair agent that drafts a fix when a cloud changes its page (a person approves every change, which then takes effect after a 48-hour notice), a reader of traded GPU prices on the Akash chain (shown for comparison only), and end-to-end and chaos tests on a local chain. `cd wall && bun install && bun test`

## Status

Early. The index and its checking system are built and tested on local chains. The market contracts are built and tested, including against Kuru's testnet order books on a fork. The bots, the indexer, the testnet deployment and the app are next.
