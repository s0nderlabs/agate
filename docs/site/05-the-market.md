---
slug: the-market
title: The monthly market
description: One token per GPU per month pays the month's average price, between a floor and a ceiling. Long, Short, pay me daily, and what backs it.
group: Concepts
order: 5
source: 'contracts/src/market/AgateSeries.sol, contracts/src/market/AgateRouter.sol'
---

# You trade a month's average price, fully paid for up front.

Each GPU has a market per month. Its token pays that month's average index price; you can lock that price in from
either side, close early at the market price, or be paid day by day. Numbers on this page are the live H100 November
2026 market (floor $1.95, ceiling $8.00, 30 days).

## One token per GPU per month

The H100 November 2026 token (`H100-NOV26`) pays, for each GPU-hour it covers, November's average H100 price: the
average of November's 30 final daily prices, each kept inside the month's range. One token is one GPU-hour.

Two months are open at a time, this month and the next, each with its own Kuru order book. The **market price** of a
month (its bid, ask and last trade) is what traders expect that average to be; the **index price** is today's real
price. They differ, and the gap is the market's view.

## Long and Short

| | Long | Short |
|---|---|---|
| What you do | buy the token at the market price | put up the ceiling and sell the token at the market price |
| What you get at the end | the month's average, per GPU-hour | the ceiling minus the month's average, per GPU-hour |
| What you have locked | what you pay for compute | what you earn from compute |
| Good for | renters, AI companies | GPU owners, clouds |

Example, 100 GPU-hours. **Long** at $4.03 costs $403: if November averages $4.50 you get $450 (+$47); at $3.50 you get
$350 (-$53). **Short**: you put up $800 and get $395 back at once (at $3.95), so $405 is in; if November averages $3.50
you get $450 back (+$45), at $4.50 you get $350 (-$55). Either way the Short earned $3.95 an hour.

## The floor and the ceiling

Each month is listed with a range, fixed at listing and never changed. Every daily price is kept inside it before it
counts. The rule (`contracts/src/market/lib/BandLib.sol`, called from `AgateFactory`):

1. **The reference** is the average of the index's five final days just before the 1st of the month **before** the
   listed month (for November: Sep 26 to Sep 30). An index that started later than that has no five such days, so it
   uses its first final day five times instead (the month's `bandGrade` is then `SEEDED`; `RULE` is the normal case,
   `STALE` when one of the five days was carried).
2. **The floor** is half the reference, rounded **down** to $0.05.
3. **The ceiling** is twice the reference, rounded **up** to $0.05.

The index started on Oct 4 2026, so November's ranges are seeded from Oct 4's final prices:

| Month | Oct 4 price | Half, then down to $0.05 | Twice, then up to $0.05 |
|---|---|---|---|
| H100 November | $3.99 | $1.995 → **$1.95** | $7.98 → **$8.00** |
| H200 November | $4.85 | $2.425 → **$2.40** | $9.70 → **$9.70** |
| B200 November | $7.07 | $3.535 → **$3.50** | $14.14 → **$14.15** |

The rounding always widens the range, never narrows it. December, listed on Nov 1, is the first month with the normal
rule (Oct 27 to Oct 31). Read a month's terms onchain with `terms()` on its series ([Contracts](12-contracts.md)).

The range is what lets every trade be paid for up front:

- the most a Long can lose is the price paid minus the floor ($4.03 - $1.95 = $2.08 an hour);
- the most a Short can lose is the ceiling minus the sale price ($8.00 - $3.95 = $4.05 an hour);
- outside the range a hedge covers only up to the edge.

## What backs a token

A token is not a GPU-hour stored somewhere: like power futures, it is a cash-settled claim on a price. But it only
comes into existence when someone locks the month's ceiling in dollars ($8.00 a GPU-hour for H100 November). That one
deposit makes two sides: the token, worth the month's average, and a short position, worth the ceiling minus that
average. Together they always pay exactly the $8.00 that was locked, so every dollar any holder can be paid is already
in the contract. No margin calls, no liquidations, and no one can owe more than they put in.

## Pay me daily

Tick **Pay me daily** and each day of the month pays its share as soon as that day's price is final, instead of
everything at the end:

- **Long, paid daily:** the floor comes back at once ($1.95 an hour), then each day pays (that day's price - $1.95) / 30.
  At $3.99 that is about $0.068 an hour each day: $6.80 a day on 100 GPU-hours.
- **Short, paid daily:** each day pays ($8.00 - that day's price) / 30. At $3.99 that is about $0.134 an hour each day:
  $13.37 a day on 100 GPU-hours.

Over the month it adds up to the same as waiting for the end. A daily payer bot sends each day's payments; anyone can
also claim, with the SDK's `claim` and `claimDaily` or the series contract's `claim` (the app's **Positions** gets a
claim and Collect button for signed-in accounts before the first month ends on Dec 1). An order that rests in the book (a limit that does not fill at once) is paid at the month's end, not daily.

## Closing early and limit orders

Closing a Long sells it at the market price; closing a Short buys the token back. Your gain or loss is the difference
from where you opened. In **Pro**, limit orders rest in Kuru's book at your price: a Long rests as a bid, a Short as
an ask (pairs are minted for it); cancelling returns the funds to your account, and a cancelled Short's pairs can be
redeemed for the ceiling.

## When the month ends

1. Trading stops on the month's last day.
2. The last day's price becomes final about six hours after the month ends (the day closes at 01:00 UTC on the 1st,
   final at about 07:00 UTC); the average is fixed.
3. A plain Long collects the average, a plain Short the ceiling minus the average (`settle`); daily positions are
   already paid.

The next month is already open, so a hedge can roll on. An AI on autopilot does this for you
([AI pockets and limits](07-ai-pockets.md)).

## If the price stops

Markets read only final days. A day with no usable data is carried at the day before's price; a market day still
without a final price 60 days after it ended takes the last value that market applied, so every month settles and no
money is stuck ([How the price is made](04-the-price.md)).
