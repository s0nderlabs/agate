---
slug: api
title: Developer API
description: Read-only JSON for prices, sources, history, months, books, trades and candles. No key.
group: Reference
order: 8
source: 'server/src/developer.ts'
---

# Every number on the screen, as JSON.

The developer API (v1) serves read-only market data for Agate: the open onchain price of renting a GPU for an hour, and the monthly markets that
settle on it. No key, no sign-up. JSON over HTTPS.

- **Base URL:** `https://agate.elpabl0.xyz/api` (the same API also answers at `https://agate-1.tailf06dd7.ts.net`,
  Agate's server, without the `/api`)
- **Spec:** [`/v1/openapi.json`](https://agate.elpabl0.xyz/api/v1/openapi.json) (OpenAPI 3.1)
- **Units:** prices are US dollars per GPU-hour, sizes are GPU-hours, times are ISO 8601 in UTC.
- **Network:** Monad testnet (chain 10143). Every token is a test asset with no monetary value.
- **Limits:** 120 requests a minute per IP. Through `agate.elpabl0.xyz/api` callers share Vercel's edge addresses,
  so the limit there is 1,200 a minute per edge address. Over it: `429` with `retry-after: 60`.
- **Freshness:** prices, months and books come from one server read every few seconds (`readAt`, `ageMs` on each
  answer); trades are cached 15 s, candles 60 s. Answers carry a short `cache-control`.
- **Stability:** v1 only ever adds fields. A rename or removal would be v2.

```sh
curl https://agate.elpabl0.xyz/api/v1/prices
```

## Endpoints

Paths below are relative to the base URL.

| Endpoint | What you get |
|---|---|
| `GET /v1` | This list, the chain and the index contract |
| `GET /v1/prices` | Today's price of every GPU (H100, H200, B200, B300, A100, L40S), with each cloud's own price |
| `GET /v1/prices/{gpu}` | One GPU, plus its daily history |
| `GET /v1/markets` | Every month on sale: floor, ceiling, best bid and ask, last trade, open interest, contracts |
| `GET /v1/markets/{gpu}/{month}` | One month, with its order book on Kuru |
| `GET /v1/markets/{gpu}/{month}/trades?limit=50` | Recent trades, newest first (limit 1 to 200) |
| `GET /v1/markets/{gpu}/{month}/candles` | Hourly candles from the month's first trade |
| `GET /v1/status` | When each price was last made final and how many sources it counted |
| `GET /v1/openapi.json` | The OpenAPI description |

`{gpu}` is any case (`h100` works). `{month}` is `YYYY-MM`, for example `2026-11`.

## The price

Each GPU's price is the median across companies of the clouds' own public price pages, read every hour. A day's price
is published at the day's close and becomes final six hours later; a changed price also needs a second, independent
reader's countersign. `GET /v1/prices/H100`:

```json
{
  "gpu": "H100",
  "price": 3.99,
  "date": "2026-10-07",
  "previousPrice": 3.99,
  "change": 0,
  "finalAt": "2026-10-08T07:02:46Z",
  "nextCloseAt": "2026-10-09T01:00:00Z",
  "nextFinalAt": "2026-10-09T07:00:00Z",
  "sourcesCounted": 5,
  "panelSize": 6,
  "sources": [
    {
      "company": "Verda", "price": 3.83, "counted": true, "reserve": false,
      "page": { "sha256": "2660a4cf0c8c4413d313715c93bbeb0c102545aad1ea018ad300980b96267840", "fetchedAt": "2026-10-07T23:18:04Z", "price": 3.85 }
    },
    {
      "company": "Lambda", "price": 3.99, "counted": true, "reserve": false,
      "page": { "sha256": "cf517d807032af0c53b0c8608c794896d6a425b5c8b669e8b9a5ee2668826e71", "fetchedAt": "2026-10-07T23:18:04Z", "price": 3.99 }
    },
    { "company": "Hyperstack", "price": null, "counted": false, "reserve": true, "page": null }
  ],
  "tradable": true,
  "history": [{ "date": "2026-10-07", "price": 3.99, "status": "final" }],
  "beforeOnchain": [{ "date": "2026-10-03", "price": 3.99, "status": "final" }]
}
```

- `price` is `null` before a GPU's first final day; `previousPrice` and `change` are `null` until there is a day before it.
- A `reserve` source counts only when a main source fails.
- `page` is the page behind a source's price: the watcher's newest clean reading of that cloud's price page on
  `date` (the watcher is the independent reader the attester checks each day against). `sha256` is the fingerprint of
  the exact bytes it fetched, `fetchedAt` when, and `price` the price read from that one page (the source's own
  `price` is the day's average, so the two can differ when a cloud changed its price that day). `page` is `null` for
  a source without a price, a source held from an earlier day, or when the page had no clean reading that day. It is kept by Agate's server, not onchain.
- `history` is the onchain record (`status: "carried"` means no new reading that day, the day before carried).
- `beforeOnchain` holds days our logger recorded before the index went onchain: shown for context, nothing settles
  on them.
- `tradable: false` marks the price-only GPUs (B300, A100, L40S today).

## The months

One token per GPU per month pays that month's average price, kept between the month's `floor` and `ceiling`. Going
Long buys the token; going Short locks the ceiling and sells it. `GET /v1/markets/H100/2026-11`:

```json
{
  "gpu": "H100",
  "month": "2026-11",
  "symbol": "H100-NOV26",
  "phase": "trading",
  "floor": 1.95,
  "ceiling": 8,
  "days": 30,
  "startsAt": "2026-11-01T00:00:00Z",
  "closesAt": "2026-12-01T00:00:00Z",
  "bid": 3.95,
  "ask": 4.03,
  "last": 4.03,
  "lastTradeAt": "2026-10-08T04:22:06Z",
  "openInterest": 8364,
  "contracts": { "series": "0xbc28...c577", "token": "0x0fbf...ce28", "kuruMarket": "0xf245...3a9c" },
  "book": { "bids": [{ "price": 3.95, "size": 1000 }], "asks": [{ "price": 4.03, "size": 1000 }], "spread": 0.08 }
}
```

- `phase`: `upcoming` (not listed yet, see `opensOn`), `trading` (listed, month not started), `paying` (inside the
  month), `settled`.
- `bid` / `ask` are `null` when that side of the book is empty; `last` is `null` before the first trade.
- `floor`, `ceiling` and `contracts` are `null` while a month is `upcoming`. Once listed, `contracts` are the month's
  onchain addresses on Monad testnet; `kuruMarket` is its Kuru order book.

## Errors

Every error is JSON, `{ "error": "<sentence>" }`, with one of these statuses:

| Status | `error` | Where | `retry-after` |
|---|---|---|---|
| `400` | `gpu must be one of H100, H200, B200, B300, A100, L40S` | any `{gpu}` path | |
| `400` | `month is YYYY-MM, for example 2026-11` | any `{month}` path | |
| `404` | `<gpu> has no <month> market on sale (see /v1/markets)` | `/v1/markets/{gpu}/{month}` and below | |
| `404` | `no <gpu> price yet` | `/v1/prices/{gpu}` | |
| `404` | `no such endpoint: <method> <path> (see /v1 for the list)` | a path the API does not have, such as `/v1/price`, or a method other than GET | |
| `429` | `over 120 requests a minute; wait a minute` (`over 1200` through the app's address) | everywhere | `60` |
| `503` | `the markets could not be read right now; try again shortly` | prices, markets, books | `10` |
| `503` | `trades could not be read right now; try again shortly` | `/trades` | `15` |
| `503` | `candles could not be read right now; try again shortly` | `/candles` | `60` |
| `503` | `{ "ok": false, "error": "the markets could not be read right now" }` | `/v1/status` | `10` |

Trades and candles answer `503`, never an empty list, while the indexer is unreachable. Wait the `retry-after`
seconds, then ask again. CORS is open (`*`, GET only), so a browser page anywhere can call the API.

```sh
curl -s https://agate.elpabl0.xyz/api/v1/markets/H100/2026-12
```

```text
{"error":"H100 has no 2026-12 market on sale (see /v1/markets)"}
```

## Other ways in

- **Onchain:** the index contract and a Chainlink-style feed per GPU ([Onchain](09-onchain.md)).
- **TypeScript:** the SDK reads all of this, and builds every trade, straight from the chain and the indexer
  ([SDK](10-sdk.md)).
- **AI agents:** Agate's MCP server ([Connect an AI](03-connect-an-ai.md), [MCP tools](11-mcp-tools.md)).
