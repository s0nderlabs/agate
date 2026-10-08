---
slug: develop
title: Build and test
description: The repository's packages, how to install each, and the test suites.
group: Operate
order: 14
source: 'package.json, bunfig.toml'
---

# Clone it, install it, run every test.

Needs [Bun](https://bun.sh) and, for the contracts, [Foundry](https://getfoundry.sh).

```sh
git clone https://github.com/s0nderlabs/agate && cd agate
bun install          # app, client, wallet and server: one bun workspace (hoisted, see bunfig.toml)
```

`wall/` and `indexer/` install on their own.

## The packages

| Folder | What it is | Test |
|---|---|---|
| `contracts/` | `AgateIndex`, the market contracts (`src/market/`), the example feeds (`src/examples/`), Foundry | `forge test` (see [Contracts](12-contracts.md) for the two installs first) |
| `wall/` | the price readers, both writers, the watcher, attester and keeper, the guardian CLI, page check, repair agent, Akash reader, market maker, payer and lister, chaos tests | `cd wall && bun install && bun test` |
| `client/` | `@agate/client`, the SDK: reads, writes and plans ([SDK](10-sdk.md)) | `cd client && bun test` |
| `wallet/` | `@agate/wallet`: Dynamic sign-in, the main account and AI pockets as Kernel smart accounts, the pocket's session key | `cd wallet && bun test` (`FORK=1` adds the pocket's limits on a fork) |
| `server/` | `@agate/server`: MCP, OAuth 2.1, grants, approvals, autopilot, Dynamic webhooks, the markets snapshot, `/v1` | `cd server && bun test` |
| `app/` | the web app (Next.js 16, React 19) | `cd app && bun run typecheck`; `bun dev` to run it |
| `indexer/` | Envio HyperIndex of the index, the market and the Kuru books | `cd indexer && bun install && bun run test` |
| `agents/` | what an AI reads: `AGENTS.md`, `llms.txt`, a Claude plugin skill | |
| `ops/` | the testnet operator kit, the server split, Dynamic's environment as code | |
| `docs/` | these pages (`docs/site/`) and their images | |

Every TypeScript package also has `bun run typecheck`.

## End to end

- **On a fork of Monad testnet:** `cd client && bun run e2e:fork` runs every user flow through a month's end: test
  dollars, Long, Short, pay me daily, limit orders placed and cancelled (also as smart-account call batches), the
  daily claim, the close, the settle, the redeem.
- **On the live testnet:** `bun run e2e/run.ts testnet` (in `client/`) runs a guarded real-user journey on a
  fast-clock demo month, whose month lasts five hours.
- **The wall:** `cd wall && bun run e2e/scripts/run.ts` runs each scenario on its own local chain with the real
  `AgateIndex`: base runs of all six GPUs (one of 150 days), and chaos runs such as a cloud's page dark for six days,
  both writers blocked then dead, the local machine asleep, both RPCs down, a page layout change, a stolen primary
  key frozen, and every process restarted. `--list` names them all.

Fork tests read `MONAD_FORK_URL`; without it they skip.

## Running locally

`cd app && bun dev` starts the app on example data or the live testnet (`NEXT_PUBLIC_*` settings in `app/README.md`).
The operator kit (`ops/testnet/`) starts every process in tmux against testnet; its runbook covers keys, gas and the
demo session.
