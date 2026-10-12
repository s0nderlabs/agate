---
slug: errors
title: Errors and fixes
description: Every error a reader can hit, in the app, the API, the MCP tools, the SDK and the contracts, with the exact words and what to do.
group: Reference
order: 17
source: 'server/src/developer.ts, server/src/mcp/server.ts, server/src/mcp/routes.ts, server/src/grants.ts, wallet/src/allowed.ts, app/src/lib/account/errors.ts, client/src, contracts/src'
---

# Every error, its exact words, and what to do.

This page lists every error Agate gives: the app's messages, the developer API's answers, the MCP refusals, the SDK's
`WriteError`s and the contracts' reverts. One rule holds everywhere: a refusal **before sending** means nothing was
sent and no money moved. An error after sending (an SDK `receipt` stage, an MCP `sent` or `reverted`), or an SDK
error whose `txs` is not empty, needs a look at the chain before trying again.

## In the app

The app words its own messages (`app/src/lib/account/errors.ts`); the sentences below are what it shows.

| What you see | Why | What to do |
|---|---|---|
| no sign-in code arrives | the email is still on its way, or in spam | wait a minute, check spam, or use Google |
| `That code doesn't match. Check the newest email from Agate and try again.` | a mistyped or older code | use the newest email's code |
| `Your next 10,000 test dollars arrive <when>.` | test dollars come once every 24 hours per account | wait until then |
| `Agate couldn't pay the network fee this time. Nothing was sent. Try again in a minute.` | the sponsored-fee policy refused (2 MON a user operation, 1,000 a day) | try again in a minute |
| a code or passkey prompt | connecting an AI or delegating the Assistant asks you to confirm again | confirm ([Accounts and gas](06-accounts.md#step-up)) |
| `No passkey was made.` | the passkey dialog was closed before a passkey was made | **Try again**, **I already have a passkey**, or **Use your email instead** |
| `No passkey signed you in.` | the dialog was closed, or the browser found no Agate passkey (it cannot tell which) | **Try again or use my phone**, **Make a new passkey**, or **Use your email instead** |
| `This device already has a passkey for Agate. Sign in with it.` | this device already holds an Agate passkey | **Sign in with it** |
| `This passkey is from the older sign-in, where a passkey was added to an email or Google account.` | this passkey belongs to an email or Google account | **Continue**: it signs that account in |
| `That took too long. Try again.` | a passkey request lasts 5 minutes | try again |
| `Too many tries from this network. Wait a minute, then try again.` | too many passkey requests from one network in a minute | wait a minute, or use Google or your email |
| `Too many new accounts from this network. Try again in an hour.` | 5 new passkey accounts were made from this network in the last hour | **Use your email instead**, or try again in an hour |
| `New passkey accounts are paused for today. Use Google or your email instead.` | the day's cap on new passkey accounts (150) is reached, or Dynamic's test environment is full (then Google and email fail too) | use Google or your email, or try tomorrow |
| `Agate couldn't accept that passkey. Try again.` | Agate's server could not verify the passkey's answer | try again |
| `Your passkey worked, but sign-in didn't finish. Try again.` | Dynamic did not finish the sign-in | **Try again**: the account now exists, so it signs in |
| `That code doesn't work. Check it, or try another of your backup codes.` | the backup code is wrong, used, or replaced by a newer set | type it again, or use another of your codes |
| `That isn't a backup code. They look like K7QD-9XMP: 8 letters and numbers.` | what was typed has the wrong shape | type the code as saved; case, spaces and the dash do not matter |
| `No new passkey was made, so your code still works.` | the passkey dialog was closed while using a backup code | try again: the code was not used up |
| `Agate can't be reached right now. Try again in a moment.` | Agate's server did not answer | try again in a moment |
| `This browser can't use passkeys. Use Google or your email instead.` | the browser has no passkey support | use Google or your email, or another browser |
| `Your passkey didn't confirm it. Try again, or Cancel.` | confirming again with a passkey did not go through | try again |
| `Your passkey worked, but it didn't finish. Try again.` | confirming again: Dynamic did not finish | try again |
| `It now fills <x> GPU-hours at $<p> on average for $<d>.` | the book moved between the quote and the send | look at the new numbers and confirm again |
| `At prices <month> can still pay, the book holds $<x> (<h> GPU-hours). The rest would buy above that.` | the book is thinner than your order | buy at most that, or wait for the maker to requote |
| `At these prices this trade can only lose: the asks are above what <month> can pay. Nothing was sent.` | buying above the ceiling can only lose | wait for a lower ask |
| `At these prices this trade can only lose: the bids are below the least <month> will pay. Nothing was sent.` | selling below the floor can only lose | wait for a higher bid, or hold to the end |
| `This trade needs more test dollars than your account holds. Nothing was sent.` | not enough test dollars | trade less, or take the day's test dollars |
| `<Month> settles once every day is final. Nothing was sent.` | settle opens only after the month's last day is final | wait until about 07:00 UTC on the 1st |

## Developer API

Every error, a path the API does not have included, is `{ "error": "<sentence>" }` with `400`, `404`, `429` or
`503`, and `429` and `503` carry a `retry-after`. The full table, sentence by sentence: [Developer API](08-api.md#errors).

## MCP connection

What the server answers before any tool runs (`server/src/mcp/routes.ts`):

| Status | `error` | Why | What to do |
|---|---|---|---|
| `401` | `missing credential` | no token and no connector URL | sign in (OAuth) or use the connector URL |
| `401` | `invalid or expired access token` | the OAuth token ended or the connection passed its end date | sign in again (`/mcp` in Claude Code, `codex mcp login agate`) |
| `401` | `unknown connection` | the connector URL is wrong | the person checks the URL they saved; a URL shows only once, so for a new one they connect the AI again from **Connected AIs** |
| `401` | `this AI connection was disconnected: connect it again from Agate` | the person disconnected this connection (its URL is replaced and its OAuth tokens revoked); a tool call on it gets this sentence as the `grant_revoked` refusal instead (status `200`), since AI apps show a `401` as a connection error | the person connects the AI again from Agate |
| `405` | `method not allowed` | a GET on the MCP address | MCP clients POST; this is not a page to open |
| `413` | `payload too large` | a request body over the limit | send less in one call |
| `429` | `rate limit exceeded for this connection` | more than 240 requests a minute on one connection | slow down |
| `429` | `too many requests` | more than 30 wrong connector URLs a minute from one address | stop guessing |

## MCP refusals

A tool refusal is `{ "status": "refused", "rule": "<rule>", "detail": "<sentence>" }` with the MCP error flag set.
Nothing was signed.

| `rule` | Why | What to do |
|---|---|---|
| `over_per_trade_cap` | the trade, or a Short's collateral, is above the cap per trade; or a roll's proceeds are | trade less, roll in parts, or `request_approval` |
| `budget_left` | the pocket does not hold enough dollars | trade less; only the person can add to the budget |
| `daily_limit` | the connection used its trades of the last 24 hours (`<used> of <n> trades used in the last 24 hours`) | wait; `my_limits` shows what is left |
| `grant_expired` | the connection is past its end date | the person connects it again |
| `grant_revoked` | the person disconnected it | stop; nothing more can be done from it |
| `above_band` | the buy would average above the ceiling, a sure loss | wait for a lower ask |
| `below_band` | the sale would average below the floor, a sure loss | wait for a higher bid |
| `price_moved` | the book moved between the quote and the send | `quote` again, then trade |
| `thin_book` | the book holds less than the order within the band | trade the amount `detail` names, or wait |
| `empty_book` | no asks at all | wait for the maker to quote |
| `not_enough_tokens` | the pocket holds fewer GPU-hours than asked to sell or roll | `get_portfolio`, then a smaller size |
| `drip_too_soon` | the pocket's test dollars were taken less than 24 hours ago | wait until the time in `detail` |
| `sponsor_limit` | the network fee could not be sponsored right now | try later |
| `bad_amount` | an amount with too many decimals, off the 0.0001 GPU-hour lot or the $0.01 price grid | round it |
| `bad_input` | a `quote` without the amount its side needs | pass `dollars` for a Long, `gpu_hours` for a Short |
| `no_market` | the month has no order book yet (a trade says `<gpu> <month> has no Kuru market yet`) | `get_prices` lists the tradable months |
| `parts_too_small` | a pay-me-daily Long too small for that many daily parts (`the size is too small for that many parts`) | buy more |
| `refused` | a check with no rule of its own | read `detail` |
| `not_found` | an approval or autopilot order of another connection, or none | use an id this connection got |
| `not_allowed_contract`, `not_allowed_function` | a call the pocket may never make | only the trade tools trade |
| `payee_must_be_you`, `approve_router_only`, `no_native_value` | a call that would pay someone else, approve another spender, or send MON | never; these protect the person |

A month that is not listed at all, or a GPU with a price and no market, answers `status: "error"` with a `message`
(`<gpu> <month> is not listed`, `<gpu> is price only: ...`), not a refusal.

`status: "sent"` is not a refusal: the trade was sent and has not been seen landing yet. Check `activity` before
trying again; the same `idempotency_key` returns the first answer.

## The Allow page

When the person connects an AI, Agate's server refuses a connection that breaks a limit:

| `error` | What to do |
|---|---|
| `the per-trade cap must be above 0 and at most the budget` | lower the cap or raise the budget |
| `trades per day: 1 to 50` | choose 1 to 50 |
| `the end date must be within 90 days` | choose an earlier end date |
| `the Assistant is not delegated to agate yet (try again in a few seconds)` | wait a few seconds and allow again |
| `pocket_in_use: this pocket already serves "<label>"; ...` | disconnect that AI, or use the next pocket |
| `the signed permission does not match: ...` | allow again; the app signs a fresh permission |

## SDK errors

Every SDK failure is a `WriteError` with a `stage`, a `reason` and a `message` (and a `hash` once sent).

A write can be several transactions; the stage names the step that failed, and `WriteError.txs` lists the ones
that already landed (an approval before a failed trade, say).

| `stage` | `reason` | Why | This step sent? |
|---|---|---|---|
| `check` | `AboveBand` | a buy above the ceiling, or a buy-back that costs more than holding the Short pays | no |
| `check` | `BelowBand` | a sale below the floor | no |
| `check` | `ThinBook`, `Depth` | the book cannot fill the order within the band | no |
| `check` | `EmptyBook` | no asks | no |
| `check` | `PriceMoved` | Kuru's simulation fills less than the book read beside it | no |
| `check` | `InsufficientBalance` | not enough test dollars | no |
| `check` | `InsufficientTokens` | not enough GPU-hours of that month | no |
| `check` | `DripTooSoon` | the faucet's 24 hours have not passed | no |
| `check` | `MonthNotFinal` | settle before every day of the month is final | no |
| `check` | `PostOnlyError` | a post-only limit order would cross the book | no |
| `check` | `NoMarket` | the month has no Kuru order book yet (`<gpu> <month> has no Kuru market yet`) | no |
| `check` | `PartsTooSmall` | a pay-me-daily Long too small to split into that many daily parts (`the size is too small for that many parts`) | no |
| `check` | `NoPositions` | a close or claim with no position ids (`no positions given`) | no |
| `simulate` | the contract error's name | the call reverts in simulation | no |
| `estimate` | the RPC's error name | gas estimation failed | no |
| `send` | the wallet's error name | the wallet did not send | no |
| `receipt` | `NoReceipt` | sent, no receipt within 120 s: it may still land | **look the `hash` up first** |
| `receipt` | `reverted` | landed and reverted | yes, and it failed |

An amount the SDK cannot use throws `AmountError` before anything is read: `<what> must be a decimal string or a
bigint, never a number`, `<what> "<v>" is not a plain decimal like 12.34`, `<what> "<v>" has more than 6 decimals`,
`<what> must be a multiple of 0.0001 GPU-hour`, `<what> must be a positive multiple of $0.01`.

## Contract errors

What a reverted call names, by contract (from `contracts/src`):

| Contract | Error | Meaning |
|---|---|---|
| `AgateRouter` | `SlippageExceeded(got, min)` | the fill was worse than the bound in the call |
| `AgateRouter` | `BadAmount()`, `BadSize()` | zero, or off the 0.0001 GPU-hour lot |
| `AgateRouter` | `NoMarket(series)`, `NotSeries(series)` | the month has no book, or the address is not Agate's |
| `AgateRouter` | `BadPayee(payee)` | a payee that is one of Agate's own contracts (it could never claim) |
| `AgateRouter` | `NotYourPosition(id)`, `WrongSide(id)` | closing someone else's position, or the other side |
| `AgateSeries` | `MonthFinal()` | opening a pay-me-daily position once every day of the month is applied |
| `AgateSeries` | `MonthNotFinal()` | settling before every day of the month is final |
| `AgateSeries` | `TokenBalance()`, `ShortBalance()` | redeeming more than held |
| `AgateSeries` | `NoPosition(id)` | no such position |
| `AgateFactory` | `MonthNotOpen(month, current)` | only this month and the next can be listed |
| `AgateFactory` | `NotReady()` | the five reference days are not all final yet |
| `AgateFactory` | `BadBand(sum5)` | the reference days give no valid range |
| `AgateDollar` | `DripTooSoon(nextAt)` | the faucet's 24 hours have not passed |
| `AgatePriceFeed` | `NoFinalPrice()` | no final price for that day |
| AI pocket (session key) | `CallViolatesParamRule()` | above the cap, or another bound in the call |
| AI pocket (session key) | `InvalidCallData()` | a call the pocket may never make (a transfer, say) |
| AI pocket (session key) | `RateLimited()` | more operations than the day allows |

