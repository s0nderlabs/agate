# agate server API (for the app)

Base: `NEXT_PUBLIC_AGATE_SERVER` (dev `http://127.0.0.1:5191`; public tunnel or host for AI apps). Every `/api/*` call
sends `Authorization: Bearer <Dynamic session JWT>` (`sessionToken(client)` from `@agate/wallet/dynamic`). Errors are
`{ error: "<plain sentence>" }` with a 4xx status; show the sentence.

## Setup

- `GET /api/markets` (no auth) -> the markets snapshot (`MarketsSnapshot` in `@agate/client`): `{ v: 1, chainId, index,
  readAt, ageMs, markets, books }`, `markets` as `getMarkets()` and `books` every listed month's book keyed
  `"GPU YYYY-MM"`. Read here once for every visitor (`src/snapshot.ts`): served as it is up to 5 s old, older ones at
  once while one read refreshes it, never past 50 s; kept warm every 15 s from the first ask on. `503`
  when it cannot be read. `Cache-Control: no-store` (`ageMs` is per answer). The app passes its URL as the client's
  `snapshotUrl` (`NEXT_PUBLIC_AGATE_SNAPSHOT_URL`).
- `GET /api/config` (no auth) -> `{ chainId, dollar, routers, factory, shortSizingPrice, maxGrantDays, maxTradesPerDay }`.
  Sign the pocket permission with exactly `routers` (same order) and `shortTokensCapFor(perTradeCap)`, or the grant
  fails with "the signed permission does not match".

## Connect your AI

0. Pocket index: `GET /api/me` -> `nextPocketIndex`. Each AI gets its own pocket (Kernel index 1, 2, ...); an index is
   never reused (a revoked pocket's old permission stays installed onchain until its end date). A pocket another live
   connection uses is refused: `409 "pocket_in_use: ..."`.
1. The app creates the Assistant and delegates it (`ensureAssistantWallet`, `delegateAssistant`), the main wallet signs
   the pocket permission (`createPocketPermission`) and funds the pocket (`fundPocketCalls`), then:
2. `POST /api/grants` `{ label, mainOwner, assistantAddress, budget, perTradeCap, tradesPerDay, validUntil, pocketIndex,
   approval }` (u strings, 1e6 = $1; validUntil unix seconds, at most 90 days) -> `201` the connection (below), active
   at once: the key installs itself inside the AI's first operation (~7 s instead of ~5 s). `409` when the
   Assistant's delegation has not reached the server yet: retry after 2 to 5 s. The Assistant is delegated once per
   person; later AIs need no new code (step-up only again after "Stop every AI"). The delegated key share reaches the
   server only in Dynamic's delegation webhook: if it was missed (the public base was down, Oct 5), delegating again
   is a no-op at Dynamic and the 409 never clears. Recover only while `/api/me` shows no active delegation: revoke the
   Assistant's delegation (`revokeAssistant`), then a fresh "confirm it's you" step-up (`requestStepUp`, needed again
   after a revoke) and `delegateAssistant`, so Dynamic sends the share once more. If the revoke fails, stop there and
   show it: the wallet still counts as delegated, so the delegate step would do nothing.
3. Give the AI app a way in, one of:
   - **Connector URL** (any app that adds a remote MCP server: Claude Code, Claude.ai, Codex, Hermes, OpenClaw,
     Cursor; per-app steps in `agents/AGENTS.md`): `POST /api/grants/:id/connector` ->
     `{ url, claudeCode, note }`. Shown once; asking again replaces it. Treat it like a password.
   - **OAuth** (the AI app starts it): the app gets a browser at `<app base>/connect?request=<id>` (the Allow page; `AGATE_APP_BASE`, `https://agate.elpabl0.xyz/app` live). Call
     `GET /api/oauth/requests/:id` -> `{ clientName, redirectHost, expiresAt }`; after the person allows and the
     connection exists, `POST /api/oauth/requests/:id/approve { grantId }` -> `{ redirect }`: navigate there. Deny:
     `POST /api/oauth/requests/:id/deny` -> `{ redirect }`.

Connection shape: `{ id, label, status: active|revoked|expired, pocket, mainAccount, assistant, budget, perTradeCap,
pocketIndex, tradesPerDay, expiresAt, createdAt }`.

## Connected AIs

- `GET /api/grants` -> connections, newest first.
- `GET /api/me` -> `{ userId, email, wallets, delegations, grants, nextPocketIndex }`.
- Disconnect ONE AI: `POST /api/grants/:id/disconnect` (agate stops signing for it; its tokens and connector URL die)
  and, by default, one main-wallet batch that takes the pocket's dollars home: `kernelAccount(pc, mainSigner,
  BigInt(pocketIndex))` sends `tUSD.transfer(mainAccount, balance)` (the main wallet is the pocket's owner, whatever
  the AI's key allows; proven live: 6.3 s, sponsored). Positions stay in the pocket and show under it; the same
  owner account can close them (planCloseShort / planSellLong with `me` = the pocket).
- Stop EVERY AI: `revokeAssistant(client, assistant)` (Dynamic stops the Assistant signing at once, for all pockets)
  plus disconnect each connection. Connecting again then needs a fresh code (`requestStepUp` / `confirmStepUp`).
- `GET /api/activity?limit=100[&grantId=]` -> events newest first `{ at, source, name, walletId, grantId, detail }`.
  Names: `grant.created`, `grant.connector_issued`, `grant.oauth_approved`, `grant.disconnected`, `pocket.trade`
  (detail: `summary` = the plan's TradeSummary { action, gpu, month, maxSpend, bound, gpuHours?, payee? }, userOpHash,
  txHash, success, ms), `pocket.refused` (detail: { action, rule, message, args }: what the AI tried and the rule that
  stopped it), `pocket.error`, `approval.requested|denied|done|failed`, `wallet.delegation.created|revoked|signature`.
  `grantId` must be one of the person's connections (else 404).

## Autopilot ("keep my hedge going")

A standing order of one AI connection: agate rolls the pocket's Long of a GPU into the next listed month by itself
when the month it holds closes within `leadMinutes`, in parts under the per-trade cap (one part a minute), through
the same path as the AI's own `roll_long`. Each roll is a trade: it counts against the connection's daily trades.

- `GET /api/standing-orders[?grantId=]` -> `[{ id, grantId, gpu, kind: "roll_long", leadMinutes, status:
  active|stopped, lastRunAt, lastResult }]`. `lastResult` is `{ skip }` (why it waited, e.g. "nothing due",
  "daily_limit: ..."), `{ rolled: { from, to, gpuHours }, txHash }`, `{ refused, detail }` or `{ error }`.
- `POST /api/standing-orders { grantId, gpu, leadMinutes? (10 to 10080, default 60) }` -> the order (`201`), or the
  existing active one for that GPU.
- `POST /api/standing-orders/:id/stop`. Disconnecting the AI stops its orders too.
- The AI has the same through MCP: `keep_hedge_going { gpu, lead_minutes? }` and `stop_keep_hedge_going { order_id }`;
  `my_limits` lists the active orders. Activity names: `autopilot.started|rolled|skipped|refused|stopped|error`.

## Session (from `@agate/wallet/dynamic`)

The session JWT lives 2 h (project setting). The SDK never refreshes it by itself: at `sessionExpiresAt(client)` it
signs out with reason `token-expired`. `refreshSession(client)` resets it to the full 2 h (measured 1.7 s; it fires
`token-changed` and `user-changed`, not `session-expiry-changed`, so re-read `sessionExpiresAt` after it). Listen with
`onSessionEvent(client, cb)` -> unsubscribe; `signOut(client)` signs out. A sign-in never carries the `wallet:delegate`
scope (SDK 1.38 drops requestedScopes on sign-in), so the first delegation always asks "Confirm it's you"
(`requestStepUp` + `confirmStepUp`, or `confirmWithPasskey` once the person has a passkey); the scope is short-lived
and `canDelegate(client)` says whether it is still held.

## Passkey accounts (a passkey alone, no email)

agate's server runs the WebAuthn ceremonies (`src/passkey/`, rp id `agate.elpabl0.xyz`) and, once a passkey checks
out, answers a JWT that lives 60 seconds (ES256, `iss` https://agate.elpabl0.xyz, `aud` the Dynamic environment id,
`sub` the account `pk_...`); the app hands it to Dynamic (Bring Your Own Auth), which opens a normal session with an
`externalUser` credential whose public identifier is that `sub`. Dynamic holds every account to an email while email
sign-in is on, so with `AGATE_BYOA_EMAIL_DOMAIN` set the sign-in JWT also carries a verified placeholder address,
`pk-<32 hex>@<domain>`, made one way from the `sub` (nobody's mailbox; the server reports `email: null` for it and the
app never shows it). The session JWT the app holds is Dynamic's minified one, without verified credentials, so the
step-up routes look the account up through Dynamic's management API. Call them through `@agate/wallet/dynamic`, not
directly. Errors are `{ error: "<sentence>", code }`.

- `GET /.well-known/agate-jwks.json` (no auth): the public key Dynamic checks those JWTs with.
- `POST /api/passkey/options` (no auth; the request's `Origin` must be in `AGATE_PASSKEY_ORIGINS`, default
  `https://agate.elpabl0.xyz=agate.elpabl0.xyz`) -> `{ signin: { ceremonyId, options }, register: { ceremonyId,
  options } | null, signupClosed }`. Each ceremony is single use and lives 5 minutes.
- `POST /api/passkey/register { ceremonyId, response }` -> `201 { externalJwt, sub }`: a new account.
- `POST /api/passkey/signin { ceremonyId, response }` -> `{ externalJwt, sub }`. `404 unknown_passkey`: not one of
  agate's passkeys (most likely a Dynamic passkey added to an email account: offer `startPasskeySignIn`).
- `POST /api/passkey/stepup/options { scope }` (Bearer) and `POST /api/passkey/stepup { ceremonyId, response }`
  (Bearer) -> `{ externalJwt, scope, expiresAt }` for `wallet:delegate` or `credential:link` (anything else is
  `scope_not_allowed`); the account binds to its first Dynamic user, another one is `dynamic_mismatch`.

Codes: `origin_not_allowed`, `rate_limited` (options 30 a minute, sign-ins 20 a minute, new accounts 5 an hour per
address, failed tries not counted; step-ups 10 a minute per person), `signups_paused` (once
`AGATE_PASSKEY_SIGNUPS_PER_DAY`, default 150, accounts were made in the last 24 hours), `bad_request`, `expired`, `not_verified`, `not_discoverable`, `exists`, `unknown_passkey`,
`scope_not_allowed`, `not_a_passkey_account`, `dynamic_mismatch`, `lookup_failed` (503: Dynamic could not be asked
which passkey account a session is); `413` over 16 KB.

From `@agate/wallet/dynamic`: `preparePasskey(server)` when the sheet opens (so the tap opens the dialog at once),
`continueWithPasskey(client, server, { mode, prepared })` for the one button (signs in when this browser used an agate
passkey before, else makes an account; `mode: "signin"` for "I already have a passkey"), `createAccountWithPasskey`,
`signInWithAgatePasskey`, `isAgatePasskeyAccount(client)`, `confirmWithAgatePasskey(client, server, scope)` for
"Confirm it's you", `hasPasskeyHint()`, `passkeySupport()`, `shownEmail(client)` (the person's email, or null for a
passkey account's placeholder). Every failure is an `AgatePasskeyError` whose `code` is
`unsupported`, `cancelled` (the dialog was closed, or no passkey picked), `exists`, `unknown_passkey`, `expired`,
`rate_limited`, `signups_paused`, `rejected`, `dynamic` (the passkey worked, Dynamic did not finish) or `service`.

## Approval card (a trade an AI asked for above its cap)

The AI sends the person `<app base>/approve?request=<id>`.
- `GET /api/approvals` -> the person's approvals `{ id, grantId, action, params, summary, note, status, expiresAt, result }`
  (pending ones expire after 15 minutes, or at once when their AI is disconnected or passes its end date; those carry
  `result.reason`: "the AI was disconnected" or "the AI's permission ended").
- Approve = the app plans `params` with `@agate/client` (`planBuyLong` / `planOpenLongDaily` / `planOpenShort` /
  `planCloseShort`, same arguments as the MCP tool) for the account `summary.runFrom` names and sends it with
  `sendCalls(kc, plan.calls)`: `"main"` is the main account; `"pocket"` (closing a Short, whose positions belong to the
  pocket) is the AI's pocket, sent with the main wallet as its owner (`kernelAccount(pc, mainSigner,
  BigInt(grant.pocketIndex))`, the take-back path),
  then `POST /api/approvals/:id/done { txHash, userOpHash }` (or `/failed { reason }`; both are still accepted until
  15 minutes after the approval's own `expiresAt`, also when its AI ended it earlier, for a trade started just before). Deny: `POST /api/approvals/:id/deny`.
  The AI reads the outcome with `approval_status`.

## For AI apps (not the app)

MCP at `<public base>/mcp` (OAuth 2.1, discovery at `/.well-known/oauth-authorization-server`) or the connector URL.
Tools: `get_prices`, `quote`, `size_for`, `get_portfolio`, `my_limits`, `activity`, `approval_status`, and with a live
connection `open_long`, `open_short`, `close_long`, `close_long_daily`, `close_short`, `get_test_dollars`,
`request_approval`.
