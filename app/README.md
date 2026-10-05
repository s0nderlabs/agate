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
- `/connect` let an AI trade for you: name it, set what it may use (pocket size, trade size, trades a day, end date) and fund its pocket. Opened by Agate's server as `/connect?request=<id>` when an AI app asks (the OAuth Allow page), or from the app.
- `/ai` your connected AIs, and how to add Agate to Claude or Claude Code; `/ai/<id>` one AI: its pocket, activity, Autopilot, add or take back dollars, disconnect
- `/approve?request=<id>` an AI asked to go over its limit: see the trade and approve or decline it

Phones (under 640 px) get one column with a Long/Short bar over four bottom tabs (Markets, Positions, Index, More); the ticket opens as a bottom sheet with Simple | Pro in its head. From 640 px the chart and the ticket sit side by side under a compact top bar; from 1100 px the trade screen is the full app shell. While a design is being judged, Mock controls keeps the previous phone layout as "Stacked (before)".

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_MOCK_CONTROLS` | on in `bun dev`, off in `bun run build` | `on` or `off`. The Mock controls panel, the example data and its states and any design option being judged read from the URL. Off, only Simple/Pro, theme, GPU and sign-in come from the URL, and the data is always live. |
| `NEXT_PUBLIC_AGATE_GRAPHQL_URL` | unset | The indexer's GraphQL URL. Unset, a page on localhost asks `http://localhost:8080/v1/graphql` and a hosted page reads the chain only (no candles, fills or listing times). Set it before a hosted build. |
| `NEXT_PUBLIC_AGATE_RPC_URL` | Monad testnet's public RPC | A key-free RPC URL, only if the public one is not wanted. |
| `NEXT_PUBLIC_GOOGLE_SIGNIN` | unset | `on` shows "Continue with Google" on the real sign-in, once the Google client is set up. The practice sign-in always shows it. |

`NEXT_PUBLIC_*` values are inlined when the app is built, so set them before `bun run build`.

## Data

Screens read through `src/lib/data/`: one shape (`@agate/client`'s types) from one of two sources. Mock controls' "Data source" row (or `?source=live`) picks the example data (`src/lib/mock/`, with its states under "Data") or the live testnet through `@agate/client` in `../client`; without Mock controls it is always live. TanStack Query merges identical reads, so a page makes one markets read every 30 seconds whatever shows it. The wallet stays a practice wallet in this browser until sign-in, with its own storage for live prices. Trade sizes follow the client's steps: 0.0001 GPU-hour, dollars in cents, limit orders of 1 to 1,000,000 GPU-hours (`src/lib/size.ts`).

`@agate/client` and `@agate/wallet` are workspace packages: `bun install` at the repo root links them into the hoisted `node_modules`, with one viem for the app and both packages. They ship TypeScript source, so `next.config.ts` lists them in `transpilePackages`, with the repo as Turbopack's root.

## Account

Screens read the signed-in person through `useAccount()` (`src/lib/account/`): sign-in, balance, positions, and trades as a plan then a send. For now it is the practice account (`pretend.tsx`): no email is sent, any 6 digits sign in, and trades land in the practice wallet. The AI screens talk to Agate's server through `api.ts` (the paths in `../server/API.md`), answered for now by a pretend server (`fakeServer.ts`) whose redirects and links are never followed. The real account (Dynamic sign-in, `@agate/wallet`) and the real server replace both behind the same seams.
