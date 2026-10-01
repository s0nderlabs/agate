# Login spike: Mera

Passkey EOA (Mera 0.2.0) on Monad testnet, prompt-free signing through a scoped session, gas from a 0.2 MON drip, and an agent that buys within an on-chain grant. Same contracts and 4 steps as the Privy and Dynamic spikes.

## Run

```sh
cd spikes/login/mera
bun install
cp .env.example .env.local      # fill DRIP_PRIVATE_KEY, AGENT_PRIVATE_KEY, VITE_AGENT_ADDRESS
bun run agent -- --address      # prints the agent address for VITE_AGENT_ADDRESS
bun run drip                    # terminal 1: drip server on 127.0.0.1:5181
curl -XPOST localhost:5181/drip -H 'content-type: application/json' -d '{"address":"<agent address>"}'   # gas for the agent
bun run dev                     # terminal 2: app on http://localhost:5171 (use localhost, not 127.0.0.1)
# after step 4 in the app, with the page closed:
bun run agent -- <user address>
```

## Check

```sh
bun run typecheck && bun run build
bun test test/passkey.test.ts   # passkey layer against a fake authenticator
bun test test/fork.test.ts      # full call sequence on its own anvil fork (port 8549), anvil dev keys only
bun run estimate                # read-only eth_estimateGas on Monad testnet vs an anvil fork on :8547
```
