# Agate app

The web app for Agate: the GPU-hour index and its monthly markets on Monad testnet. Next.js (App Router), React 19, Tailwind v4, bun.

## Run it

```bash
bun install
bun dev            # http://localhost:3000
bun run typecheck
bun run build
```

## Pages

- `/` trade screen: index price, the month's price, chart, order ticket. Simple sizes a trade in dollars or GPUs for the month; Pro adds the book with recent trades, limit orders, size in GPU-hours or dollars, open orders and an account summary.
- `/index` the index: price sources and method
- `/positions` what you hold, what it is worth now and what has been paid

Phones (under 640 px) get one column with a Long/Short bar over four bottom tabs (Markets, Positions, Index, More); the ticket opens as a bottom sheet with Simple | Pro in its head. From 640 px the chart and the ticket sit side by side under a compact top bar; from 1100 px the trade screen is the full app shell. While a design is being judged, Mock controls keeps the previous phone layout as "Stacked (before)".

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_MOCK_CONTROLS` | on in `bun dev`, off in `bun run build` | `on` or `off`. The Mock controls panel, the example data and its states and any design option being judged read from the URL. Off, only Simple/Pro, theme, GPU and sign-in come from the URL, and the data is always live. |
| `NEXT_PUBLIC_AGATE_GRAPHQL_URL` | unset | The indexer's GraphQL URL. Unset, a page on localhost asks `http://localhost:8080/v1/graphql` and a hosted page reads the chain only (no candles, fills or listing times). Set it before a hosted build. |
| `NEXT_PUBLIC_AGATE_RPC_URL` | Monad testnet's public RPC | A key-free RPC URL, only if the public one is not wanted. |

`NEXT_PUBLIC_*` values are inlined when the app is built, so set them before `bun run build`.

## Data

Screens read through `src/lib/data/`: one shape (`@agate/client`'s types) from one of two sources. Mock controls' "Data source" row (or `?source=live`) picks the example data (`src/lib/mock/`, with its states under "Data") or the live testnet through `@agate/client` in `../client`; without Mock controls it is always live. TanStack Query merges identical reads, so a page makes one markets read every 30 seconds whatever shows it. The wallet stays a practice wallet in this browser until sign-in, with its own storage for live prices. Trade sizes follow the client's steps: 0.0001 GPU-hour, dollars in cents, limit orders of 1 to 1,000,000 GPU-hours (`src/lib/size.ts`).

`bun install` puts `@agate/client` in `node_modules` as per-file symlinks into `../client` (edits show at once; a new client file needs `bun install` again for TypeScript). Turbopack cannot read a symlinked `package.json`, so `next.config.ts` points the bundle at `../client/src/index.ts` and its `viem` at the app's copy, with the repo as Turbopack's root.
