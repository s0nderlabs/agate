# agate

agate makes the price of compute tradable.

It turns GPU compute into a financial asset: an open onchain price for GPU-hours that anyone, whether a person, an app or an agent, can trade, hedge or build on.

## Why

GPU rental prices move fast, and there is no open way to lock one in. Renters cannot hedge a rising compute bill, GPU owners cannot protect their income, and there is no open, multi-source price for compute onchain.

## How it works

1. **A standard unit.** One GPU-hour of a defined GPU model, rented on demand.
2. **An open price.** For each GPU model, the clouds' own public price pages are read every hour and combined into a median of companies. A second, independent reader checks the same pages and must countersign every change, so no single key can move the price. Every source is shown beside the median and the method is public. A Chainlink CRE workflow carries the index onchain on Monad.
3. **A cash-settled claim.** Fully collateralized UP and DOWN GPU-hour tickets with a floor and a ceiling, settling on the monthly average of the index and paying out daily. No GPUs change hands.

## Ways in (planned)

- **Web app:** see the price, trade it, hedge with it.
- **API:** for developers.
- **Onchain feed:** for contracts that need a compute price.
- **Agent connector (MCP):** for agents that analyze or trade.

## Repository

- `contracts/`: the index contract `AgateIndex` (Foundry). `forge install --no-git foundry-rs/forge-std@v1.17.0 && forge test`
- `wall/`: the price readers, the two writers (Chainlink CRE and a standby), the watcher and attester, the guardian CLI, and end-to-end and chaos tests on a local chain. `cd wall && bun install && bun test`
- `docs/wall/BUILD-SPEC.md`: the full specification of the index and its checks.
- `spikes/login/`: login and wallet experiments (Mera, Privy, Dynamic) on Monad testnet.

## Status

Early. The index and its checking system are built and tested on local chains. The market contracts and the app are next.
