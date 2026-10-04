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

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_MOCK_CONTROLS` | on in `bun dev`, off in `bun run build` | `on` or `off`. The Mock controls panel, the made-up data states and any design option being judged read from the URL. Off, only Simple/Pro, theme, GPU and sign-in come from the URL. |

`NEXT_PUBLIC_*` values are inlined when the app is built, so set them before `bun run build`.

## Data

Screens read from `src/lib/mock/` for now (prices, book, wallet, sign-in). The live data comes from `@agate/client` in `../client`. Trade sizes follow its steps: 0.0001 GPU-hour, dollars in cents, limit orders of 1 to 1,000,000 GPU-hours (`src/lib/size.ts`).
