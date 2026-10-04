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

- `/` trade screen: index price, the month's price, chart, book, order ticket (Simple and Pro)
- `/index` the index: price sources and method
- `/archive` the first round of screens, kept for judging (only while Mock controls are on)

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_MOCK_CONTROLS` | on in `bun dev`, off in `bun run build` | `on` or `off`. The Mock controls panel, the archive and every design option read from the URL. Off, only Simple/Pro, theme, GPU and sign-in come from the URL. |

`NEXT_PUBLIC_*` values are inlined when the app is built, so set them before `bun run build`.

## Data

Screens read from `src/lib/mock/` for now (prices, book, wallet, sign-in). The live data comes from `@agate/client` in `../client`.
