# Login spike: Dynamic + ZeroDev

Dynamic headless JS SDK (email code or passkey login, embedded MPC wallet) as the owner of a ZeroDev Kernel v3.1
smart account on Monad testnet. Every user transaction is a sponsored ERC-4337 user operation; the agent uses a
ZeroDev session key (permission validator) with a 200 testUSD budget for one day.

## Setup

```sh
cd spikes/login/dynamic
bun install                      # bunfig/overrides stub an unpublished peer of @dynamic-labs/sdk-api-core
cp .env.example .env.local       # fill VITE_AGENT_ADDRESS and AGENT_SESSION_PRIVATE_KEY (your own testnet key)
```

Dashboard ids come from `../shared/ids.json` (dynamicEnvironmentId, zerodevBundlerRpc, zerodevPaymasterRpc).

## Run

```sh
bun run dev                      # http://localhost:5173
bun run typecheck && bun run build
bun run fork:test                # starts its own anvil fork of Monad testnet on port 18573, runs the full flow
```

After step 4 in the app, download `grant.json` into `agent/` and run:

```sh
bun agent/run.ts                 # buys 50 testUSD of spUP for the user with the session key, sponsored
bun agent/run.ts --amount 25 --grant path/to/grant.json
```
