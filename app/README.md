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

The site sits at the root and the app under `/app`; every old app address (`/positions`, `/gpu-index`, `/ai`, `/connect`, `/approve`, `/landing`) redirects to its new one with its query (`next.config.ts`).

- `/app` trade screen: index price, the month's price, chart, order ticket. Simple keeps to one month, the next full one (from the 1st, while the current month still pays out, Simple already shows the next), and sizes a trade in dollars or GPUs for the month; Pro adds a tab per month that trades, the book with recent trades, limit orders, size in GPU-hours or dollars, open orders and an account summary. Signed in, a limit order rests on Kuru (post-only; a Short mints the pairs it sells), Open orders lists and cancels it, and what a fill leaves at Kuru moves back to the account (`src/components/trade/useLimitRun.ts`). In a month part paid, the most you can lose or make and what pay me daily pays at once follow the days already priced (`bandNow` in `src/lib/data/derive.ts`, as `@agate/client`'s `band()`).
- `/app/gpu-index` the index for every GPU it prices (H100, H200, B200 and the price-only B300, A100, L40S): today's readings, the history, the prices beside it
- `/app/positions` what you hold, by month: how many of the month's days are priced, what each holding is worth and has been paid, and its one action (Sell or Close while the month trades, Collect once it is final)
- `/app/connect` let an AI trade for you: name it, set what it may use (pocket size, trade size, trades a day, end date) and fund its pocket. Opened by Agate's server as `/connect?request=<id>` (redirected) when an AI app asks (the OAuth Allow page), or from the app.
- `/app/ai` your connected AIs, and how to add Agate to Claude or Claude Code; `/app/ai/<id>` one AI: its pocket, activity, Autopilot, add or take back dollars, disconnect
- `/app/approve?request=<id>` an AI asked to go over its limit: see the trade and approve or decline it
- `/docs` the documentation, from `../docs/site` (read when the app is built, so `docs/site` must ship with a deploy): a contents page with four ways in, `/docs/<slug>` per chapter with its sidebar and "On this page", `/docs/raw/<slug>.md` each chapter as markdown, `/docs/search.json` (every chapter and every H2 and H3 section, searched from a dialog: Cmd/Ctrl+K or "/"), and `/llms.txt` and `/llms-full.txt` for agents. Chapters are rendered at build (`src/lib/docs/markdown.ts`): code highlighted with Shiki and a Copy button, callouts (`> **Note.**` or `> [!WARNING]`), a link on every H2 and H3, external links marked. Each chapter has page actions (Copy page, View as Markdown, Open in Claude or ChatGPT), Edit on GitHub, its own share image, and the site footer. `links.test.ts` checks every link between chapters. The docs and `/privacy` sit under the site's own bar (the landing's), not the app's; any unknown address gets a light 404 (`src/app/not-found.tsx`)
- `/` the public site: the folded A loads into the hero film (chips sliding into the price chart), the camera dives into an H100 (`public/landing/h100`, frames scrubbed on scroll), then the market page: the jump, what makes Agate different, your AI, five clouds to one price, paid every day, build on the price, questions and the close (`src/components/landing/site/`). Its options are judged in Mock controls; a hosted build shows the picked ones. The link preview is `src/app/opengraph-image.jpg` and `twitter-image.jpg`

The theme someone picks is kept in a cookie (`agate-theme`), read by every page on the server (`pageConfig` in `src/lib/mock/savedTheme.ts`), so a reload renders in it with no flash; a theme in the link still wins and is never saved. With neither, the docs follow the device's light or dark setting (never saved, never put in the address or in links) until a theme is picked.

Phones (under 640 px) get one column with a Long/Short bar over four bottom tabs (Markets, Positions, Index, More); the ticket opens as a bottom sheet with Simple | Pro in its head. From 640 px the chart and the ticket sit side by side under a compact top bar; from 1100 px the trade screen is the full app shell. While a design is being judged, Mock controls keeps the previous phone layout as "Stacked (before)".

Being judged in Mock controls (a hosted build keeps each one's "before" until it is decided): "Close from the panel" (Open | Close tabs over the ticket, a part of held tokens sold from the panel), "Candle size" (the range picks hourly, 4-hour or daily candles; Pro can pick its own), and "Positions page" / "Index page" in the market page's frame (`PositionsMarket.tsx`, `IndexMarket.tsx`: a strip, a header of figures, a chart panel and a right-hand panel, as on the trade screen), beside their Oct 6 rework and the page before.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `AGATE_DEV_ORIGINS` | unset | Development only: more addresses (a comma list) allowed to load the dev server besides `127.0.0.1`, such as a private network name for testing on a phone. Set it in a local env file. |
| `NEXT_PUBLIC_MOCK_CONTROLS` | off (the look is locked); `on` brings the panel back | `on` or `off`. The Mock controls panel, the example data and its states and any design option being judged read from the URL. Off, only Simple/Pro, theme, GPU and sign-in come from the URL, and the data is always live. |
| `NEXT_PUBLIC_AGATE_GRAPHQL_URL` | unset | The indexer's GraphQL URL, or several separated by commas: a query goes to the first, and one that is unreachable, busy or failing rests 60 s while queries go to the next. The hosted app lists Envio Cloud first (100 queries a minute on its free plan), then Agate's server (`https://agate-1.tailf06dd7.ts.net:8443/v1/graphql`). Unset, a page on localhost asks `http://localhost:8080/v1/graphql` and a hosted page reads the chain only (no candles, fills or listing times). Set it before a hosted build. |
| `NEXT_PUBLIC_AGATE_RPC_URL` | Monad testnet's public RPC | The RPC, or several separated by commas, tried in order. Only a key-free URL, or a key the provider locks to the app's origins with a key-free URL after it: the hosted app uses the Alchemy app `agate-browser` (Node API only, domains agate.elpabl0.xyz, agate-topaz.vercel.app and localhost; Keychain `agate.alchemy-browser-key`), then `https://testnet-rpc.monad.xyz`. |
| `NEXT_PUBLIC_AGATE_SNAPSHOT_URL` | unset | Agate's markets snapshot (`https://agate-1.tailf06dd7.ts.net/api/markets`): the markets and every listed book in one request instead of each visitor reading the chain. Down or late, the app reads the chain itself. |
| `NEXT_PUBLIC_ZERODEV_RPC` | unset | The ZeroDev bundler and paymaster URL for Monad testnet: the real account's sponsored operations. Unset, live data shows "Sign in is not set up on this build". |
| `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` | `@agate/wallet`'s sandbox | The Dynamic environment the real sign-in uses. |
| `NEXT_PUBLIC_AGATE_SERVER` | unset | Agate's server (`../server`), for Connect your AI, the AI pages and approvals on the real account. Unset, every server call reads as offline. |
| `NEXT_PUBLIC_GOOGLE_SIGNIN` | unset | `on` shows "Continue with Google" on the real sign-in (on in the hosted app since Oct 6). The practice sign-in always shows it. |
| `AGATE_WALL_HOME` | `~/.agate-wall` | Server side: where `/api/akash` reads the shared Akash robot's `akash/akash-traded.json` (`../wall/apps/akash`) for the Akash price beside the index. Without the file the dated reading stays. |
| `AGATE_AKASH_URL` | unset | Server side: a URL serving that same `akash-traded.json`, for a hosted build with no robot folder (Vercel). Set, it replaces the folder read; a good reading is kept ten minutes, and a URL that does not answer within five seconds counts as no reading. |

`NEXT_PUBLIC_*` values are inlined when the app is built, so set them before `bun run build`.

On Vercel, pages render in Singapore (`vercel.json` `regions: ["sin1"]`, next to Agate's server); every page reads its settings from the URL, so pages render per request rather than as static files. The page head opens the connections to the markets snapshot, the first indexer URL and the first RPC URL while it loads, and Dynamic's connection opens when Dynamic starts.

## Data

Screens read through `src/lib/data/`: one shape (`@agate/client`'s types) from one of two sources. Mock controls' "Data source" row (or `?source=live`) picks the example data (`src/lib/mock/`, with its states under "Data", the month timeline under "Day": two months live, a month's last hour, the gap before its last day is final, and after, in `timeline.ts`, and an example November holder under "Holds") or the live testnet through `@agate/client` in `../client`; without Mock controls it is always live. TanStack Query merges identical reads, so a page makes one markets read every 30 seconds whatever shows it. The wallet stays a practice wallet in this browser until sign-in, with its own storage for live prices. Trade sizes follow the client's steps: 0.0001 GPU-hour, dollars in cents, limit orders of 1 to 1,000,000 GPU-hours (`src/lib/size.ts`).

`@agate/client` and `@agate/wallet` are workspace packages: `bun install` at the repo root links them into the hoisted `node_modules`, with one viem for the app and both packages. They ship TypeScript source, so `next.config.ts` lists them in `transpilePackages`, with the repo as Turbopack's root.

## Account

Screens read the signed-in person through `useAccount()` (`src/lib/account/`): sign-in, balance, positions, and trades as a plan then a send. On live data it is the real account (`real.tsx`): Dynamic email-code sign-in (or Google, or a passkey added from the Account sheet; a passkey never signs up a new person), the main account (a Kernel account with ZeroDev-sponsored operations, `main.ts`), trades planned by `@agate/client` and sent as one operation, closes from Positions. On example data it is the practice account (`pretend.tsx`): no email is sent, any 6 digits sign in, and trades land in the practice wallet.

A passkey is stored as one of the person's Dynamic verified credentials (format `passkey`), not as an MFA device, but it still needs the environment's passkey method on (Security, MFA methods; MFA enforcement stays off). Adding one needs a fresh `credential:link` scope: an email-code sign-in carries one while the person has no passkey yet, otherwise a code is sent first. Once a person has a passkey, Dynamic routes every "Confirm it's you" through it and refuses email codes, so Connect your AI asks for the passkey instead of a code for them. The AI screens talk to Agate's server through `api.ts` (the paths in `../server/API.md`): the real server on live data (`realAi.ts`: the trading key, pocket permissions, funding and take back), a pretend server (`fakeServer.ts`) on example data, whose redirects and links are never followed.
