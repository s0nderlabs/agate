---
slug: ai-pockets
title: AI pockets and limits
description: Each AI trades from a separate pocket, with a budget, a cap per trade, trades a day and an end date, checked by Agate's server and by the chain.
group: Concepts
order: 7
source: 'server/src/grants.ts, wallet/src/allowed.ts, server/src/autopilot.ts'
---

# An AI can only spend what you put in its pocket, the way you allowed.

When you connect an AI, Agate makes it a **pocket**: a separate smart account that holds only the budget you give it.
The AI trades from the pocket, never from your main account, and every trade is checked against your limits by
Agate's server and again by the chain itself.

## The limits you set

| Limit | Meaning |
|---|---|
| Budget | the dollars moved into the pocket: the hard total the AI can ever use |
| Cap per trade | the most one trade may spend (or lock, for a Short) |
| Trades a day | how many operations the pocket may make in any 24 hours (1 to 50) |
| End date | after it, the permission stops working onchain (at most 90 days) |

The budget must be above zero and the cap per trade at most the budget. One live AI per pocket: a second AI gets the
next pocket.

Profits and payouts always go to your **main account**, never back to the AI.

## Where the limits are checked

1. **Agate's server** refuses by rule name before anything is signed: over the cap (`over_per_trade_cap`), over the
   budget (`budget_left`), out of trades (`daily_limit`), past the end date (`grant_expired`), disconnected
   (`grant_revoked`), price outside the band (`above_band`, `below_band`). Every rule: [Errors](17-errors.md#mcp-refusals).
2. **The chain itself**: the pocket carries a session key that the smart account enforces. It may only call Agate's
   router, only up to the cap, only with your main account as the payee, only N operations in any 24 hours, only until the end
   date, and never sign anything else. Measured refusals with the server bypassed: over the cap `CallViolatesParamRule()`,
   a transfer `InvalidCallData()`, a fourth operation in a day `RateLimited()`.
3. **Dynamic** holds the Assistant as an MPC wallet, so no single machine has its key. A third gate is built and
   waiting: Agate's server answers Dynamic Transaction Review, approving only signatures it built in the last minute
   for a live connection inside the pocket's limits. Dynamic has not yet turned Transaction Review on for Monad
   testnet, so today the first two checks are the ones that apply.

## Above the cap

An AI that wants to do more than its cap does not split the trade. It calls `request_approval` (or a trade tool
answers `needs_approval` by itself) and hands you a link, `https://agate.elpabl0.xyz/app/approve?request=<id>`; you
approve and run the trade from your main account in the app, or deny it. A request lives 15 minutes, and moves
through `pending`, then `approved` or `denied`, then `done` (with its transaction) or `failed`; one nobody answers is
`expired`. The AI reads the state with `approval_status`.

## Autopilot

"Keep my hedge going": `keep_hedge_going { gpu }` asks Agate to roll the pocket's Long of that GPU into the next listed
month by itself, before the held month closes, in parts under the cap. `lead_minutes` (default 60, from 10 to
10,080, a week) sets how long before the close it acts. One order per GPU; asking again returns the existing one.
Each roll counts as a trade. `stop_keep_hedge_going` ends it.

## Disconnect

On the **AI** page, **Disconnect** ends a connection everywhere it could still act: Agate stops signing for it, its
pending approvals and autopilot orders end, its connector URL and OAuth tokens die, and the app moves the pocket's dollars
back to your main account. "Stop every AI" also revokes the Assistant with Dynamic, which stops its signing at once.

## AI companies with their own wallet

An AI company's agent does not need a person's pocket: it can hold its own Dynamic server wallet (TSS-MPC) that owns a
gas-sponsored smart account, and trade with the SDK's plan builders as single user operations. Agate's reference agent
(`server/src/company/agent.ts`) keeps one rule, hold N GPU-hours of the next open month, buying the shortfall in parts
while the best ask is under a ceiling, and journals every decision with its transaction hash.
