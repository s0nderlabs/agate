# @agate/server: agate's Dynamic layer

The always-on service behind "Connect your AI": it receives Dynamic's delegation notices, answers Transaction Review,
keeps each AI connection's limits, serves agate's MCP server (connector URL and OAuth 2.1), runs the autopilot and
signs as the AI's Assistant. The browser half (sign-in, wallets, the pocket permission) is `@agate/wallet`
(`../wallet`). The app's contract is [API.md](API.md).

Run: `scripts/run.sh` (or `scripts/restart.sh` into tmux). Secrets live in `~/.agate-dynamic/` (mode 700), never in
the repo. Tests: `bun test` (70). The public developer API (`/v1`, read-only, no key) is `src/developer.ts`, documented in [`../docs/site/08-api.md`](../docs/site/08-api.md). `MONAD_RPC_URL` takes one RPC URL or a comma list (tried in order). The environment itself is code: [`../ops/dynamic`](../ops/dynamic/README.md).

## Code usage per Dynamic primitive

Everything below ran on Monad testnet (10143) on Oct 4 2026 unless marked.

| Dynamic primitive | What agate does with it | Code |
|---|---|---|
| Headless JS SDK, email code sign-in | agate's own sign-in sheet, no Dynamic UI | [`wallet/src/dynamic.ts`](../wallet/src/dynamic.ts#L45) `createAgateDynamic`, `startEmailSignIn`, `finishEmailSignIn` |
| Embedded wallets (TSS-MPC), several per chain | the person's main wallet plus a separate Assistant for their AIs | [`wallet/src/dynamic.ts`](../wallet/src/dynamic.ts#L147) `ensureMainWallet`, `ensureAssistantWallet` |
| ZeroDev extension / smart accounts | the main account and each AI's pocket are Kernel accounts; every trade is a sponsored user operation | [`wallet/src/kernel.ts`](../wallet/src/kernel.ts), [`wallet/src/pocket.ts`](../wallet/src/pocket.ts#L52) |
| Step-up (`requestedScopes: wallet:delegate`) | "Confirm it's you" before the Assistant is delegated | [`wallet/src/dynamic.ts`](../wallet/src/dynamic.ts#L117) `canDelegate`, `requestStepUp`, `confirmStepUp` |
| Delegated access | the Assistant (never the main wallet) is delegated to agate; it signs only the pocket's session key | [`wallet/src/dynamic.ts`](../wallet/src/dynamic.ts#L169) `delegateAssistant`, `revokeAssistant` |
| Delegation webhooks (`wallet.delegation.created/revoked/signature`), RSA-encrypted shares | HMAC-checked, idempotent; shares decrypted and sealed at rest; revoked shares dropped | [`src/dynamic/webhook.ts`](src/dynamic/webhook.ts#L22), [`src/store.ts`](src/store.ts#L24) |
| Delegated signing (`@dynamic-labs-wallet/node-evm`) | the Assistant signs each AI trade with the user operation as context, retried on transient MPC failures | [`src/dynamic/signer.ts`](src/dynamic/signer.ts#L83) `sendWithIntent` |
| Transaction Review (HMAC request, Ed25519 response) | agate approves only signatures it built in the last minute for a live connection, inside the pocket's limits (blocked on Dynamic's side on 10143, asked) | [`src/dynamic/review.ts`](src/dynamic/review.ts#L73) `decide`, [`src/app.ts`](src/app.ts#L123) |
| Session JWT + JWKS, user API | every app call is the signed-in person; wallets created after sign-in are refreshed from Dynamic | [`src/dynamic/jwt.ts`](src/dynamic/jwt.ts#L17), [`src/dynamic/users.ts`](src/dynamic/users.ts#L19) |
| Server wallets (`DynamicEvmWalletClient`) | an AI company's agent owns its own smart account through one; the payer bot signs with one since Oct 5 (`AGATE_PAYER_SIGNER=dynamic`) | [`src/dynamic/serverWallet.ts`](src/dynamic/serverWallet.ts#L26), [`src/company/agent.ts`](src/company/agent.ts#L41) |
| Session events, refresh, sign-out | the app keeps a person signed in while they use it | [`wallet/src/dynamic.ts`](../wallet/src/dynamic.ts#L87) `refreshSession`, `onSessionEvent`, `signOut` |
| Test accounts (`+dynamic_test`) | judges and the live tests sign in without an inbox | [`../ops/dynamic/sandbox.json`](../ops/dynamic/sandbox.json) |
| Management API (admin token) | the environment as code: export, diff, apply; re-points the webhook and Transaction Review after a host change | [`scripts/env.ts`](scripts/env.ts) |

## What holds an AI back, outermost first

1. agate's server: typed refusals by rule name (cap, budget, daily trades, end date, price bounds, the allowed-call
   list in [`wallet/src/allowed.ts`](../wallet/src/allowed.ts#L68)), one operation at a time per connection.
2. Transaction Review, once Dynamic turns it on for Monad.
3. The pocket's onchain session key (ZeroDev CallPolicy, timestamp, daily rate limit, no ERC-1271), compiled from the
   same allowed-call list ([`pocketPermissions`](../wallet/src/allowed.ts#L121)).
4. The pocket's balance: the AI can never reach the person's main account.

MCP tools ([`src/mcp/server.ts`](src/mcp/server.ts)): reads `get_prices`, `quote`, `size_for`, `get_portfolio`,
`my_limits`, `activity`, `approval_status`; trades `open_long` (pay me daily), `open_short`, `close_long`,
`close_long_daily`, `close_short`, `roll_long`, `get_test_dollars`, `request_approval`; autopilot `keep_hedge_going`,
`stop_keep_hedge_going` ([`src/autopilot.ts`](src/autopilot.ts#L55)).
