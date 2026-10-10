---
slug: quickstart
title: Quickstart
description: Sign in, go Long, go Short with pay me daily, close, and check the price. Three minutes, no wallet, no gas.
group: Get started
order: 2
source: 'app/, JUDGES.md'
---

# Three minutes, no wallet, no gas.

This page takes you through the app at https://agate.elpabl0.xyz (phone or desktop) from signing in to a closed
trade, then shows the same data from a terminal and from code.

## 1. Sign in

Tap **Sign in** and use your email (a code arrives) or Google; you can add a passkey after. There is no wallet to
install and no gas to pay: an account is created for you (a smart account, see [Accounts](06-accounts.md)) and network
fees are paid by Agate. The first sign-in adds **10,000 test dollars** in about 6 seconds; you can take 10,000 more
each day.

## 2. Go Long

On **Markets**, pick **H100** and **November 2026**. The screen shows today's index price, the month's market price,
its range (H100 November: a floor of $1.95 and a ceiling of $8.00 per GPU-hour) and Kuru's order book (switch to
**Pro** for the full book and limit orders).

Enter $100 and confirm. You now hold November's H100 price: at the end of November you get November's average price
for every GPU-hour you bought. The confirmation links to the transaction on Monad.

## 3. Go Short, paid daily

Pick **Short**, tick **Pay me daily**, enter a size and confirm. You put up the ceiling and sold at today's price, so
you have locked what you earn per GPU-hour. With pay me daily, each day of November pays its share as soon as that
day's price is final. How the money works: [The monthly market](05-the-market.md).

## 4. Close

**Positions** lists both trades. **Close** either one at the market price; your gain or loss is the difference from
where you opened.

## 5. Check the price

Open **Index**. Each GPU's price is the median across companies of what the clouds charge on their own pages, and
every cloud's price is shown beside it. How: [How the price is made](04-the-price.md).

## The same data without the app

```sh
curl https://agate.elpabl0.xyz/api/v1/prices                      # every GPU, with its sources
curl https://agate.elpabl0.xyz/api/v1/markets/H100/2026-11        # a month and its order book
cast call 0xC68687dd7d7b40281FB07E9006538aa45fAF3D98 \
  "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url https://testnet-rpc.monad.xyz
```

```ts
import { createAgateClient } from "@agate/client"; // the workspace package in this repo
const agate = createAgateClient({ graphqlUrl: "https://agate-1.tailf06dd7.ts.net:8443/v1/graphql" });
const h100 = await agate.getMarket("H100");
console.log(h100.price, h100.sources);
```

Next: [Connect an AI](03-connect-an-ai.md) to let an agent trade for you, or the [Developer API](08-api.md).
