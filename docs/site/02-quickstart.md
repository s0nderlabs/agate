---
slug: quickstart
title: Quickstart
description: Sign in, go Long, go Short with pay me daily, close, and check the price. Three minutes, no wallet, no gas.
group: Get started
order: 2
source: 'app/, JUDGES.md'
---

# Three minutes, no wallet, no gas.

This page takes you through the app at https://agate.elpabl0.xyz/app (phone or desktop) from signing in to a
closed trade, then shows the same data from a terminal and from code.

**Before you start:** a browser on a device that can save a passkey (Touch ID, Face ID, Windows Hello, or a phone
nearby), or an email address or a Google account. Nothing to install, no wallet, nothing to fund: test dollars are
free and have no value.

## 1. Sign in

Tap **Sign in**, then **Continue with a passkey**. One Touch ID or Face ID makes your account, with no email. In
another browser or on a new device, tap **I already have a passkey** instead. Or use Google or your email (a code
arrives). There is no wallet to install and no gas to pay: an account is created for you (a smart account, see
[Accounts](06-accounts.md#passkey-accounts)) and network fees are paid by Agate. The first sign-in adds
**10,000 test dollars** in about 6 seconds; you can take 10,000 more 24 hours after the last time.

**You should see** your balance at the top: $10,000.00.

## 2. Go Long

On **Markets**, pick **H100** and **November 2026**. The screen shows today's index price, the month's market price,
its range (H100 November: a floor of $1.95 and a ceiling of $8.00 per GPU-hour) and Kuru's order book (switch to
**Pro** for the full book and limit orders).

Enter $100 and confirm. You now hold November's H100 price: at the end of November you get November's average price
for every GPU-hour you bought.

**You should see** a receipt with the GPU-hours you bought (about 24.8 for $100 at a $4.03 ask) and a link to the
transaction on the Monad explorer, a few seconds after you confirm.

## 3. Go Short, paid daily

Pick **Short**, tick **Pay me daily**, enter a size and confirm. You put up the ceiling and sold at today's price, so
you have locked what you earn per GPU-hour. With pay me daily, each day of November pays its share as soon as that
day's price is final. How the money works: [The monthly market](05-the-market.md).

## 4. Close

**Positions** lists both trades. **Close** either one at the market price; your gain or loss is the difference from
where you opened. For example, $100 at a $4.03 ask buys 24.81 GPU-hours; sold at once at a $3.95 bid they come back
as $98.01: the $1.99 you lose is the spread between the bid and the ask.

## 5. Check the price

Open **Index**. Each GPU's price is the median across companies of what the clouds charge on their own pages, and
every cloud's price is shown beside it. How: [How the price is made](04-the-price.md).

## Check it

- **In the app:** Positions lists the trade, and the receipt's link opens it on the explorer.
- **From the API:** your fill appears among the month's trades within about 15 seconds:

```sh
curl -s "https://agate.elpabl0.xyz/api/v1/markets/H100/2026-11/trades?limit=1"
```

```text
{"gpu":"H100","month":"2026-11","trades":[{"at":"2026-10-10T11:49:39Z","side":"buy","price":4.03,"size":495.5459,
"txHash":"0xfa8f5d439431ae31fac2786227c49c78d877d867a88d218f7ff5eb6683487f00"}]}
```

## If it fails

| What you see | What to do |
|---|---|
| no sign-in code arrives | wait a minute, check spam, or use Google |
| `Your next 10,000 test dollars arrive <when>.` | test dollars come once every 24 hours; wait until then |
| `Agate couldn't pay the network fee this time. Nothing was sent. Try again in a minute.` | try again in a minute |
| `It now fills ...` | the book moved; look at the new numbers and confirm again |
| `At prices November can still pay, the book holds ...` | the book is thinner than your order; buy at most that |
| a code or passkey prompt | connecting an AI and delegating ask you to confirm again ([Accounts](06-accounts.md#step-up)) |

A refusal before sending says that nothing was sent. Every message and its cause: [Errors](17-errors.md#in-the-app).

## The same data without the app

```sh
curl -s https://agate.elpabl0.xyz/api/v1/markets/H100/2026-11 | jq -c '{symbol, phase, floor, ceiling, bid, ask, last}'
```

```text
{"symbol":"H100-NOV26","phase":"trading","floor":1.95,"ceiling":8,"bid":3.95,"ask":4.03,"last":4.03}
```

The same price from a contract, with its output decoded: [Onchain feeds](09-onchain.md). From TypeScript, a first
script and what it prints: [SDK](10-sdk.md#install). The numbers above were read on Oct 10 2026; yours will be that
day's.

Next: [Connect an AI](03-connect-an-ai.md) to let an agent trade for you, or the [Developer API](08-api.md).
