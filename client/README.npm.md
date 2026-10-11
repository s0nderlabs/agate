# agate SDK

Read the open onchain price of renting a GPU for an hour, and trade [agate](https://agate.elpabl0.xyz)'s monthly
GPU-hour markets on Monad, from TypeScript. The same code agate's own app runs on. One dependency:
[viem](https://viem.sh). Works in Node 18+, browsers (any bundler) and Bun.

> Monad testnet (chain 10143): every token is a test asset with no monetary value.

```sh
npm install @s0nderlabs/agate viem
```

## Read the price

```ts
import { createAgateClient } from "@s0nderlabs/agate";

// agate's public indexer adds history, trades and candles; graphqlUrl: null reads the chain only
const agate = createAgateClient({ graphqlUrl: "https://agate-1.tailf06dd7.ts.net:8443/v1/graphql" });

const markets = await agate.getMarkets(); // all six GPUs
for (const m of markets) {
  console.log(m.gpu, m.price, m.priceDate, m.sources.map((s) => `${s.family} ${s.price}`).join(", "));
}

const h100 = await agate.getMarket("H100");
const nov = h100.series.find((s) => s.month === "2026-11")!;
console.log(nov.floor, nov.cap, nov.quote); // the month's range and its Kuru bid, ask and last trade
```

Prices are US dollars per GPU-hour, sizes GPU-hours. Every reader returns plain numbers, typed (`Market`, `Series`,
`IndexDay`, `Book`, `Fill`, `Candle`, `Position`, `Wallet`, ...).

## Trade

Every action exists two ways: a function that sends it with a viem `WalletClient`, and a plan (`plan*`) that returns
the exact call batch for a smart account or a server to send.

```ts
import { createAgateClient, drip, buyLong, planBuyLong } from "@s0nderlabs/agate";

const agate = createAgateClient({ graphqlUrl: "https://agate-1.tailf06dd7.ts.net:8443/v1/graphql" });
await drip(agate, walletClient); // 10,000 test dollars a day
await buyLong(agate, walletClient, { gpu: "H100", month: "2026-11", dollars: "100", maxPrice: "4.10" });

// or, for a smart account: the calls to send as one user operation
const plan = await planBuyLong(agate, account, { gpu: "H100", month: "2026-11", dollars: "100", maxPrice: "4.10" });
```

Long, Short, pay me daily, close, limit orders, claims and settlement are all covered, each with price and depth
guards.

## Other ways in

- **No code:** the JSON API, `https://agate.elpabl0.xyz/api/v1/prices`.
- **Onchain:** a Chainlink-style feed per GPU on Monad testnet (`latestRoundData()`, 6 decimals).
- **AI agents:** agate's MCP server.

Docs and the method behind the price: https://github.com/s0nderlabs/agate (`docs/`). MIT licence.
