---
name: agate
description: Use when the user wants GPU-hour rental prices (H100, H200, B200 and more), to hedge a GPU rental bill, or to trade Long or Short on agate. Trades run from the user's AI pocket on Monad testnet within the budget, per-trade cap, daily count and end date they set.
---

# agate

agate makes the price of GPU compute tradable. A daily index of GPU-hour rental prices across clouds, and monthly
tokens that pay that month's average price. **Long** gains when GPU rent rises (a renter's hedge); **Short** gains when
it falls (a provider's hedge). Test dollars on Monad testnet.

## Before any trade

1. `my_limits`: what is left (pocket dollars, per-trade cap, trades left today, end date). Never guess these.
2. `get_prices` (and `quote` for a size): today's index and the months you can trade, with the band (the range a
   month token can pay: the most you can win or lose is bounded by it).
3. Size a hedge with `size_for` (GPUs x days x 24 GPU-hours).

## Trading

- `open_long { gpu, month, dollars, pay_me_daily? }`. `pay_me_daily` turns the position into daily payouts, which
  always go to the user's main account (the part already sure at opening comes back into the pocket at once).
- `open_short { gpu, month, gpu_hours, pay_me_daily? }` (collateral = GPU-hours x the band's top; most comes back).
- `close_long`, `close_long_daily`, `close_short` end positions early (ids from `get_portfolio`).
- `roll_long { gpu, from_month, to_month, gpu_hours? }` keeps a hedge going: sells the held month and buys the later
  one with the proceeds in one transaction (both or neither). Proceeds above the cap are refused: roll in parts.
- `get_test_dollars` takes the pocket's daily faucet.
- Always pass an `idempotency_key` (any unique string): a retry with the same key never trades twice.

## When the answer is no

- A trade above the per-trade cap returns `needs_approval` with a link. Give the user the link, then poll
  `approval_status`. The user approves in the agate app and it runs from their main account (closing a Short runs from your pocket,
  signed by their main wallet).
- Refusals name the rule: `over_per_trade_cap`, `budget_left`, `daily_limit`, `bad_amount`, `grant_expired`, `grant_revoked`,
  `price_moved` (a fresh quote is attached), `thin_book`, `above_band`, `below_band`. Explain the rule to the user;
  do not retry blindly.

## Never

- Never invent or round a transaction hash: report only `tx_hash` values a tool returned (with its `explorer` link).
- Never promise a trade went through before the tool says `status: "done"`. `status: "sent"` means agate sent it but
  has not seen it land yet: check `activity` before trying again, and never retry it with a new idempotency key.
- The pocket can only trade on agate; nothing can send the user's money anywhere else, so do not offer to.
