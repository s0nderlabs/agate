# Claims a judge can check in two minutes

Each claim points at the line that enforces it, in this repository at the commit that last changed this file. Run
`forge test` in `contracts/` and `bun test` in `client/`, `server/` and `wallet/` to see the tests that pin them. The
three-minute tour of the live product is [`JUDGES.md`](../JUDGES.md).

## The price

| Claim | File | Line | Note |
|---|---|---|---|
| Only Chainlink's forwarder can deliver a CRE report | `contracts/src/AgateIndex.sol` | 96 | `A1_NotForwarder` |
| The index has no proxy, no pause and no upgrade; its logic runs in linked libraries | `contracts/src/AgateIndex.sol` | 17 | |
| A day is computed from one writer's stored readings, never a mix | `contracts/src/lib/IndexDays.sol` | 40 | `pick` returns one source |
| A day below quorum cannot close | `contracts/src/lib/IndexDays.sol` | 43 | `C3_BelowQuorum` |
| The day's price is the median across companies, to the cent | `contracts/src/lib/IndexFormula.sol` | 180 | median at IndexFormula.sol:18 |
| A changed record needs a second key's countersign | `contracts/src/lib/IndexDays.sol` | 52 | `needsSign` when the record changed |
| An unchanged record is final 6 hours later | `contracts/src/lib/IndexDays.sol` | 55 | `tPend` = 21,600 s on testnet (`contracts/deployments/10143.json`) |
| The attester countersigns, a guardian vetoes, a guardian can suspend a writer | `contracts/src/AgateIndex.sol` | 130 | veto :139, suspend :145 |
| A changed record nobody countersigns is dropped after 7 days | `contracts/src/lib/IndexDays.sol` | 83 | |
| Changes go through a public 48-hour queue, reader swaps included | `contracts/src/lib/IndexAdmin.sol` | 11 | `queue` AgateIndex.sol:166, `queueReaderSwap` :183 |

## The market

| Claim | File | Line | Note |
|---|---|---|---|
| A pair (one token, one short unit) is always worth exactly the ceiling; no owner, no admin | `contracts/src/market/AgateSeries.sol` | 35 | every term immutable |
| Minting takes the full ceiling up front and credits the short side to the payer | `contracts/src/market/AgateSeries.sol` | 135 | credit at :136 |
| Nothing settles before the month is final | `contracts/src/market/AgateSeries.sol` | 269 | `MonthNotFinal` |
| A short unit pays the ceiling minus the month's average | `contracts/src/market/AgateSeries.sol` | 278 | the Long side at :275 |
| The band is half and twice the reference, on a $0.05 grid | `contracts/src/market/lib/BandLib.sol` | 9 | |
| A month always settles: a day with no final price falls back after 60 days | `contracts/src/market/lib/LastResortLib.sol` | 10 | `LAST_RESORT_DAYS` MarketTypes.sol:7 |
| The price bound is checked inside the trade, onchain | `contracts/src/market/AgateRouter.sol` | 283 | `SlippageExceeded` |
| One GPU for one day is 24 GPU-hours | `contracts/src/market/AgateRouter.sol` | 201 | `sizeFor` |

## AI pockets

| Claim | File | Line | Note |
|---|---|---|---|
| A pocket's limits compile to an onchain session key (router only, cap, payee, rate, end date) | `wallet/src/allowed.ts` | 121 | `pocketPermissions` |
| The server checks a batch exactly as the onchain policy would, before signing | `wallet/src/allowed.ts` | 68 | `checkPocketCalls` |
| The daily trade count is refused by rule name | `server/src/grants.ts` | 139 | `dailyLimitRefusal` |
| Disconnect ends signing, approvals, autopilot, the connector URL and OAuth tokens | `server/src/grants.ts` | 127 | `endGrant`; the pocket's dollars come back in a separate step, `app/src/components/flow/DisconnectSheet.tsx` |
| Transaction Review approves only signatures agate built for a live connection | `server/src/dynamic/review.ts` | 73 | waits on Dynamic for Monad testnet |

## For developers

| Claim | File | Line | Note |
|---|---|---|---|
| The public API limits each caller by the address the proxy saw, never a header it sent | `server/src/developer.ts` | 122 | |
| The onchain feed never reports a carried day as fresh | `contracts/src/examples/AgatePriceFeed.sol` | 73 | `_computedAt` |
| Redeeming pairs defaults to whole lots of what the wallet holds | `client/src/plan.ts` | 416 | |
| The SDK's writes never use floats for money (reads return plain numbers for display) | `client/src/units.ts` | 1 | |

## What is not built

See [Limits, stated](site/16-limits.md).
