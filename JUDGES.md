# agate for judges: try it in three minutes

agate makes the price of compute tradable: an open onchain price for renting a GPU for an hour, and monthly markets
on it that anyone (a person, an app or an AI agent) can trade to lock that price in. Everything runs on Monad testnet
with free test dollars.

**Open:** https://agate.elpabl0.xyz (phone or desktop)

## 1. Sign in (30 seconds)

- Tap **Sign in** and use your email (a code arrives) or Google. No wallet, no extension, no gas: your account is
  created for you and network fees are on agate.
- The first sign-in adds **10,000 test dollars** (about 6 seconds). You can take 10,000 more each day.
- No inbox to hand? The portal's access instructions give a test login that works without one.

## 2. Trade (2 minutes)

On **Markets**, pick **H100**, month **November 2026**. You see today's price, the market price, the month's range
(a floor of $1.95 and a ceiling of $8.00 an hour) and Kuru's order book (switch to **Pro** for the full book).

1. **Long:** enter $100 and confirm. You now hold November's H100 price: you get back November's average price for
   each GPU-hour you bought. The confirmation links to the transaction on Monad.
2. **Short, paid daily:** pick Short, tick **Pay me daily**, enter a size and confirm. You've locked in what you earn
   per GPU-hour; each day of November pays its share as soon as that day's price is final.
3. **Positions:** both trades are there. **Close** either one at the market price.

Every trade is fully backed when it's made, so there are no margin calls and no liquidations.

## 3. Check the price (30 seconds)

Open **Index**. Each GPU's price is the middle of what the clouds charge on their own public price pages, read every
hour; every cloud's price is shown beside it. How it's made: [agate.elpabl0.xyz/docs/the-price](https://agate.elpabl0.xyz/docs/the-price).

## 4. Connect an AI (optional, 2 minutes)

Open **AI**. It shows agate's link for AI apps and, for Claude Code, the command to run:

```sh
claude mcp add --transport http agate https://agate-1.tailf06dd7.ts.net/mcp
```

Your AI app then opens agate to ask for your OK: set a budget and limits (per trade, trades a day, end date) and
allow it. (Or use **Connect from here instead** to get a link for any other MCP app.) Then ask it "what's the H100 price on agate?" or "open a $50 H100 November long". Its trades come from its own pocket,
within your limits, and show on the AI page. Steps for Codex, Hermes, OpenClaw and others: [agents/AGENTS.md](agents/AGENTS.md).

## Proof onchain (Monad testnet, chain 10143)

| What | Address |
|---|---|
| The price (index contract) | [`0x4193...Da36`](https://testnet.monadexplorer.com/address/0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36) |
| H100 November 2026 market | [`0xbc28...c577`](https://testnet.monadexplorer.com/address/0xbc28e45ede13d0bd61d78f6f3d9f6341b78fc577) |
| Its Kuru order book | [`0xf245...3a9c`](https://testnet.monadexplorer.com/address/0xf2455ab8bbb5f8fa82d2a626a56bd5df7ef43a9c) |
| Market factory | [`0xEdBE...a0b5`](https://testnet.monadexplorer.com/address/0xEdBE3e696944443bBCe7eb3CD04E626e9396a0b5) |
| Test dollar | [`0x3A05...bF38`](https://testnet.monadexplorer.com/address/0x3A0513b2A19EE92eb3f73Dd06EefEe4D477CbF38) |

All addresses: [`contracts/deployments/10143.json`](contracts/deployments/10143.json). The same data as JSON, no key:
https://agate.elpabl0.xyz/api/v1/prices ([agate.elpabl0.xyz/docs/api](https://agate.elpabl0.xyz/docs/api)).

## Each sponsor, with proof (as of Oct 9 2026)

| Sponsor | What it does in agate | Proof you can click | Code |
|---|---|---|---|
| Chainlink CRE | the primary writer of the price: reads the index, then six clouds' pages every hour, nodes agree on each number, reports to the index and reads back what landed | 250 reports since Oct 4, all successful, 93% of readings: first [`0x4775...`](https://testnet.monadexplorer.com/tx/0x47751afb9ed7bf84253e5dc5eb42a97685a503997f62aba9b2bcf0f165d70df1), recent [`0x2d48...`](https://testnet.monadexplorer.com/tx/0x2d48b837a896f66570d596f8f8f400f80e99a100483ae9f3802bbc2d791d11ed); first run that reads the chain before and after [`0x1951...`](https://testnet.monadexplorer.com/tx/0x19516ae0dd2f5e30b9a2b752b56cffe05b90022dbeaccfc7bdcdab49b5a8a4cf) | `wall/apps/writer-cre/workflow/handler.ts` |
| Kuru | one order book per GPU per month; Long, Short, limit orders, cancels, a market maker | 12 markets created (H100 November [`0x0993...`](https://testnet.monadexplorer.com/tx/0x0993a12e4e2c9ead07ad59c632dc2cbe18c55d367fa3e231d83740fe2aab94c5)); 33 trades, 2,050 GPU-hours; a limit order [`0x6a17...`](https://testnet.monadexplorer.com/tx/0x6a17321fbfae99b7c3cd37f628f52d3e9312430c0addd4a5f9c59e075256f2c7) and its cancel [`0x3137...`](https://testnet.monadexplorer.com/tx/0x31376ac12f703f75881fa88f7adba1b56553f82f318c3ba04e5d4113c52bcacb) | `contracts/src/market/AgateRouter.sol`, `wall/apps/marketmaker` |
| Envio | indexes the index, every month and every Kuru book; drives candles, the trades tape, positions and the API | live on Envio Cloud: `https://indexer.dev.hyperindex.xyz/4b2eb56/v1/graphql` (13,253 events, at the chain head) | `indexer/` |
| Dynamic | sign-in and wallets; a delegated Assistant wallet signs each AI's trades; server wallets for the payer and an AI company's agent | an AI's trade signed by its delegated wallet [`0x9701...`](https://testnet.monadexplorer.com/tx/0x97011f941530d99490aef4d157245dbf1cc077bd20c42d67a04fddadb78c2087); the autopilot roll [`0x6d94...`](https://testnet.monadexplorer.com/tx/0x6d94893df4d7765a6af940ce978aefaa821af35a9e2d6f0d9b1c630f692a7723); a server wallet's buy [`0x79f9...`](https://testnet.monadexplorer.com/tx/0x79f908d996a6a55fd367d3e2ba852e49a315a81a48871fc1354852b93531a21a); 8 delegations, 15 delegated signatures | `wallet/src/dynamic.ts`, `server/src/dynamic/` |
| Sourcify | every live contract's source, checkable against the chain | all 20 verified, runtime and creation code matching: [the index](https://sourcify.dev/#/lookup/0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36) | `contracts/deployments/10143-sourcify.json` |
| Alchemy | sends every signing process's transactions, with a compute-unit meter and a daily budget; the app's reads on a domain-locked key | 11.49M compute units used by Oct 8, matching the processes' own meter | `wall/packages/report/src/meter.ts` |

Every action with its transaction, and what each sponsor does, feature by feature:
[agate.elpabl0.xyz/docs/built-on](https://agate.elpabl0.xyz/docs/built-on).

## Good to know

- Every part of agate is documented at https://agate.elpabl0.xyz/docs (the same pages as markdown in
  [`docs/site/`](docs/site/)); claims you can check line by line in the code: [`docs/judge.md`](docs/judge.md).
- The price is written onchain by a Chainlink CRE workflow (run in CRE's simulator, `cre workflow simulate
  --broadcast`) and must be countersigned by a second, independent reader before a changed price counts.
- Our own market maker keeps buy and sell orders on Kuru so there is always a price to trade at.
- Test dollars and tokens have no monetary value.
