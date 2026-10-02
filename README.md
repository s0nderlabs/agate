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
- `wall/`: the price readers, the two writers (Chainlink CRE and a standby), the watcher and attester, the guardian CLI, and end-to-end and chaos tests on a local chain. `cd wall && bun install && bun test`
- `docs/wall/BUILD-SPEC.md`: the full specification of the index and its checks.
- `docs/market/BUILD-SPEC.md`: the specification of the market (the monthly token, short positions, daily payouts, the router to Kuru, the test dollar), with a reference model in `docs/market/model/`. `cd docs/market/model && python3 -m unittest`
- `spikes/login/`: login and wallet experiments (Mera, Privy, Dynamic) on Monad testnet.

## Status

Early. The index and its checking system are built and tested on local chains. The market contracts are built and tested, including against Kuru's testnet order books on a fork. The bots, the indexer, the testnet deployment and the app are next.
