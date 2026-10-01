# Login spike: Privy

Same 4 steps as the other spikes, on Monad testnet (10143), using the shared contracts in `../shared/config.ts`.

## Run

```bash
# 1. agent setup (once per one-day window): needs agent/.env.local, see agent/.env.example
cd spikes/login/privy/agent
bun install
bun run policy            # creates the Privy policy, writes agent/policy.json (ids only)

# 2. web app on http://localhost:5172
cd ../app
bun install
bun run dev               # restart after ids.json or policy.json changes

# 3. after step 4 in the app, with the tab closed if you like
cd ../agent
bun run agent --user 0xUSER [--wallet-id <privy wallet id>]   # both shown in the app

# checks
cd ../app && bun run build
cd ../agent && bun test fork.test.ts   # anvil fork of Monad testnet, default anvil accounts only
```

`bun run policy --dry-run` and `bun run agent --user 0x... --dry-run` print the exact request without
touching Privy.
