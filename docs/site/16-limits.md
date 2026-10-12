---
slug: limits
title: Limits, stated
description: What Agate is not yet, said plainly.
group: Background
order: 16
source: 'contracts/src, server/src/grants.ts, wallet/src/allowed.ts, wall/apps'
---

# What Agate is not, yet.

- **Testnet only.** Agate runs on Monad testnet with test dollars that have no value. Nothing here is an offer of a
  financial product.
- **List prices, not deal prices.** The index is the clouds' posted on-demand prices. Clouds change them in steps, so
  the index moves rarely and in steps; negotiated and reserved prices are not in it.
- **A DEMO label on testnet.** A day closes with one fresh source on testnet; a mainnet index would need at least
  three ([How the price is made](04-the-price.md)).
- **One CRE node.** The primary writer runs in Chainlink's CRE simulator, so its agreement step is one node until a
  deployment on Chainlink's network. The standby writer and the attester's countersign still apply. The simulator
  also runs with its limits off, because CoreWeave's price page (437 KB) is bigger than CRE's 250 KB HTTP limit; on
  Chainlink's network that page would go through Confidential HTTP (500 KB).
- **Thin books.** Depth comes from Agate's own market maker. There are no outside traders yet. To keep the November
  books moving, a labeled test trader,
  [`0x14fB...C84a`](https://testnet.monadexplorer.com/address/0x14fB2CE8Fb6d7016e4E416bE7E58ca028Cc2C84a), trades in
  a market that has gone an hour without a trade: it buys $10 to $20 when it holds under $2 of the month and sells
  what it holds (up to $20) when it holds more, so it holds close to nothing, at most 72 trades and $1,000 a day. Its
  trades are Agate's own and never count as outside traders'.
- **Three GPUs trade.** H100, H200 and B200 have monthly markets; B300, A100 and L40S have a daily price only.
- **The venue.** Kuru's V1 order book on testnet lets anyone open a market; on mainnet, new Kuru markets are listed
  by Kuru, so a mainnet market depends on that.
- **Not audited.** The contracts are tested (unit, fuzz, invariant, adversarial and fork tests) but have had no
  outside audit.
- **Passkey accounts lean on Agate's server.** Signing in and confirming with an Agate passkey go through it: while
  it is down, passkey accounts cannot sign in (email and Google still can). Its database is the only record of which
  passkey opens which account, copied daily on the same server. New passkey accounts are capped at 150 a day, and 5
  an hour from one network.
- **One server.** The always-on processes run on one rented server, with the standby writer on a second machine; a
  day survives an outage (late days are closed and carried), but the robots stop while it is down.
- **Dynamic Transaction Review waits on Dynamic.** It is built on Agate's side; until Dynamic turns it on for Monad
  testnet, an AI pocket's limits are checked by Agate's server and the chain ([AI pockets](07-ai-pockets.md)).
- **An AI connection's end date depends on how it connected.** Past the end date a connector URL still answers
  reads (its trade tools are gone), while an OAuth connection stops answering within the hour, because its token is
  not renewed. Either way, connecting again with a new end date restores it.

## Who can do what

Every role is its own key, and no key can type a price: the index computes each day from stored readings, and
nobody can edit a recorded day. The contracts have no proxy, no pause and no upgrade.

| Who | Can | Cannot | Enforced in |
|---|---|---|---|
| a writer (CRE primary, standby) | post its own hourly readings; close a day from them | post for the other writer, write a price, change a final day | `AgateIndex` (`postReport`, `closeDay`) |
| the attester | countersign a changed day, or select the other writer's record of it | write a value; veto | `attest` |
| a guardian (a person) | veto a day before it is final; suspend a writer; countersign | type a price; act on a final day; appoint anyone | `veto`, `suspend`, `attest` |
| the index owner | register a new GPU (at once, append-only); queue a change of writer, attester, guardian, forwarder, owner, a source's dates or a reader, applied only after the 48-hour public queue | change a recorded day; skip the queue | `registerGpu`, `queue`, `execute`, `queueReaderSwap` |
| anyone | close or carry a due day; list the current or next month once its reference days are final; create its Kuru market; claim any pay-me-daily position's payout, which always goes to that position's payee | choose a band; settle or redeem someone else's tokens; send a payout anywhere else | `AgateIndex`, `AgateFactory`, `AgateSeries` |
| the factory | no owner at all | anything an owner could | `AgateFactory` |
| `marketAdmin` | record a replacement market for a month (a Kuru-made one on V1) | touch money, prices or positions | `attachMarket` |
| the test dollar's minter | mint test dollars (testnet only) | anything else | `AgateDollar` |
| the market maker, lister, payer, keeper | quote, list, pay daily positions, close days: what anyone may do, with their own keys | take a position's money; set a price | their keys can call only public functions |
| Agate's server | sign an AI's trades with the Assistant, inside the pocket's limits | move the main account's money; exceed the session key's limits | `server/src/grants.ts`, the pocket's session key |
| a leaked connector URL | trade that one pocket inside its limits until disconnected | reach the main account; raise a limit; trade after a disconnect | the session key; Disconnect ends the URL |

## What is public

Everything onchain is public on Monad: every reading, every day's price and its sources, every position, every
pocket's trades, every order in the book. Your account's address is visible to anyone who looks; your email is not
(it stays with Dynamic and Agate's server).

## What is not built yet

Beyond the limits above (one CRE node, no outside audit, Transaction Review):

- Kuru Spot V2 books for the app (the market maker is ready to quote them).
- A way back for a passkey account that lost its passkey AND every backup code: there is none (it has no email to
  fall back on).
