---
slug: limits
title: Limits, stated
description: What Agate is not yet, said plainly.
group: Background
order: 16
source: 'docs/site'
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
- **Thin books.** Depth comes from Agate's own market maker. Outside traders are few so far.
- **Three GPUs trade.** H100, H200 and B200 have monthly markets; B300, A100 and L40S have a daily price only.
- **The venue.** Kuru's V1 order book on testnet lets anyone open a market; on mainnet, new Kuru markets are listed
  by Kuru, so a mainnet market depends on that.
- **Not audited.** The contracts are tested (unit, fuzz, invariant, adversarial and fork tests) but have had no
  outside audit.
- **One server.** The always-on processes run on one rented server, with the standby writer on a second machine; a
  day survives an outage (late days are closed and carried), but the robots stop while it is down.
- **Dynamic Transaction Review waits on Dynamic.** It is built on Agate's side; until Dynamic turns it on for Monad
  testnet, an AI pocket's limits are checked by Agate's server and the chain ([AI pockets](07-ai-pockets.md)).
- **The SDK is not on npm yet.** It is built and tested as `agate-sdk`; for now, use it from this repository.
