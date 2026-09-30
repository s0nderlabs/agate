# agate

agate makes the price of compute tradable.

It turns GPU compute into a financial asset: an open onchain price for GPU-hours that anyone, whether a person, an app or an agent, can trade, hedge or build on.

## Why

GPU rental prices move fast, and there is no open way to lock one in. Renters cannot hedge a rising compute bill, GPU owners cannot protect their income, and there is no open, multi-source price for compute onchain.

## How it works

1. **A standard unit.** One GPU-hour of a defined GPU model, rented on demand.
2. **An open price.** For each GPU model, several independent price sources are combined into a median, with quorum, staleness, outlier and max-move checks. Every source is shown beside the median and the method is public. A Chainlink CRE workflow carries the index onchain on Monad.
3. **A cash-settled claim.** Fully collateralized LONG and SHORT GPU-hour tokens with a floor and a cap, settling on the monthly average of the index. No GPUs change hands.

## Ways in (planned)

- **Web app:** see the price, trade it, hedge with it.
- **API:** for developers.
- **Onchain feed:** for contracts that need a compute price.
- **Agent connector (MCP):** for agents that analyze or trade.

## Status

Early. The index, the contracts and the app are being built in this repository.
