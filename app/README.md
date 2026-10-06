# Agate app

The web app for Agate: the GPU-hour index and its monthly markets on Monad testnet. Next.js (App Router), React 19, Tailwind v4, bun.

## Run it

```bash
bun install
bun dev            # http://localhost:3000
bun run typecheck  # next typegen, then tsc (PageProps and LayoutProps come from Next's generated types)
bun run build
```

## Pages

- `/` trade screen: index price, the month's price, chart, order ticket. Simple keeps to one month, the next full one (from the 1st, while the current month still pays out, Simple already shows the next), and sizes a trade in dollars or GPUs for the month; Pro adds a tab per month that trades, the book with recent trades, limit orders, size in GPU-hours or dollars, open orders and an account summary. In a month part paid, the most you can lose or make and what pay me daily pays at once follow the days already priced (`bandNow` in `src/lib/data/derive.ts`, as `@agate/client`'s `band()`).
- `/gpu-index` the index for every GPU it prices (H100, H200, B200 and the price-only B300, A100, L40S): today's readings, the history, the prices beside it
- `/positions` what you hold, by month: how many of the month's days are priced, what each holding is worth and has been paid, and its one action (Sell or Close while the month trades, Collect once it is final)
- `/connect` let an AI trade for you: name it, set what it may use (pocket size, trade size, trades a day, end date) and fund its pocket. Opened by Agate's server as `/connect?request=<id>` when an AI app asks (the OAuth Allow page), or from the app.
- `/ai` your connected AIs, and how to add Agate to Claude or Claude Code; `/ai/<id>` one AI: its pocket, activity, Autopilot, add or take back dollars, disconnect
- `/approve?request=<id>` an AI asked to go over its limit: see the trade and approve or decline it

Phones (under 640 px) get one column with a Long/Short bar over four bottom tabs (Markets, Positions, Index, More); the ticket opens as a bottom sheet with Simple | Pro in its head. From 640 px the chart and the ticket sit side by side under a compact top bar; from 1100 px the trade screen is the full app shell. While a design is being judged, Mock controls keeps the previous phone layout as "Stacked (before)".

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_MOCK_CONTROLS` | on in `bun dev`, off in `bun run build` | `on` or `off`. The Mock controls panel, the example data and its states and any design option being judged read from the URL. Off, only Simple/Pro, theme, GPU and sign-in come from the URL, and the data is always live. |
| `NEXT_PUBLIC_AGATE_GRAPHQL_URL` | unset | The indexer's GraphQL URL, or several separated by commas: a query goes to the first, and one that is unreachable, busy or failing rests 60 s while queries go to the next. The hosted app lists Envio Cloud first (100 queries a minute on its free plan), then Agate's server (`https://agate-1.tailf06dd7.ts.net:8443/v1/graphql`). Unset, a page on localhost asks `http://localhost:8080/v1/graphql` and a hosted page reads the chain only (no candles, fills or listing times). Set it before a hosted build. |
| `NEXT_PUBLIC_AGATE_RPC_URL` | Monad testnet's public RPC | A key-free RPC URL, only if the public one is not wanted. |
| `NEXT_PUBLIC_ZERODEV_RPC` | unset | The ZeroDev bundler and paymaster URL for Monad testnet: the real account's sponsored operations. Unset, live data shows "Sign in is not set up on this build". |
| `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` | `@agate/wallet`'s sandbox | The Dynamic environment the real sign-in uses. |
| `NEXT_PUBLIC_AGATE_SERVER` | unset | Agate's server (`../server`), for Connect your AI, the AI pages and approvals on the real account. Unset, every server call reads as offline. |
| `NEXT_PUBLIC_GOOGLE_SIGNIN` | unset | `on` shows "Continue with Google" on the real sign-in, once the Google client is set up. The practice sign-in always shows it. |
| `AGATE_WALL_HOME` | `~/.agate-wall` | Server side: where `/api/akash` reads the shared Akash robot's `akash/akash-traded.json` (`../wall/apps/akash`) for the Akash price beside the index. Without the file the dated reading stays. |
| `AGATE_AKASH_URL` | unset | Server side: a URL serving that same `akash-traded.json`, for a hosted build with no robot folder (Vercel). Set, it replaces the folder read; a good reading is kept ten minutes, and a URL that does not answer within five seconds counts as no reading. |

`NEXT_PUBLIC_*` values are inlined when the app is built, so set them before `bun run build`.

## Data

Screens read through `src/lib/data/`: one shape (`@agate/client`'s types) from one of two sources. Mock controls' "Data source" row (or `?source=live`) picks the example data (`src/lib/mock/`, with its states under "Data", the month timeline under "Day": two months live, a month's last hour, the gap before its last day is final, and after, in `timeline.ts`, and an example November holder under "Holds") or the live testnet through `@agate/client` in `../client`; without Mock controls it is always live. TanStack Query merges identical reads, so a page makes one markets read every 30 seconds whatever shows it. The wallet stays a practice wallet in this browser until sign-in, with its own storage for live prices. Trade sizes follow the client's steps: 0.0001 GPU-hour, dollars in cents, limit orders of 1 to 1,000,000 GPU-hours (`src/lib/size.ts`).

`@agate/client` and `@agate/wallet` are workspace packages: `bun install` at the repo root links them into the hoisted `node_modules`, with one viem for the app and both packages. They ship TypeScript source, so `next.config.ts` lists them in `transpilePackages`, with the repo as Turbopack's root.

## Account

Screens read the signed-in person through `useAccount()` (`src/lib/account/`): sign-in, balance, positions, and trades as a plan then a send. On live data it is the real account (`real.tsx`): Dynamic email-code sign-in, the main account (a Kernel account with ZeroDev-sponsored operations, `main.ts`), trades planned by `@agate/client` and sent as one operation, closes from Positions. On example data it is the practice account (`pretend.tsx`): no email is sent, any 6 digits sign in, and trades land in the practice wallet. The AI screens talk to Agate's server through `api.ts` (the paths in `../server/API.md`): the real server on live data (`realAi.ts`: the trading key, pocket permissions, funding and take back), a pretend server (`fakeServer.ts`) on example data, whose redirects and links are never followed.
