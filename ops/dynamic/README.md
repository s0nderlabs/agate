# agate's Dynamic environment, as code

`sandbox.json` is the Dynamic sandbox environment agate runs on (`db2880bd-...`): every settings group, the enabled
providers (email code, Google, passkey, embedded wallets), the delegation webhook, the Transaction Review config and
the allowed origins (https://agate.elpabl0.xyz, https://agate-topaz.vercel.app, the app on :3317 and the lab on :5174;
social sign-in stays off in Dynamic until one is set). The server's public base is written as `${PUBLIC_BASE}`. There
are no secrets in it: the webhook secret, the review HMAC secret and Ed25519 key, the delegation RSA key and the API
tokens live in `~/.agate-dynamic/` and are never read back from Dynamic.

From `server/` (needs the admin token in `~/.agate-dynamic/admin.env` and `AGATE_PUBLIC_BASE`):

- `bun run scripts/env.ts export`: write the file from the live environment.
- `bun run scripts/env.ts diff`: list what differs between the file and the live environment.
- `bun run scripts/env.ts apply`: point the webhook and Transaction Review at `AGATE_PUBLIC_BASE` with the file's
  switches (run it after the server's host changes). `--settings` also writes the file's settings (the live providers
  are sent back unchanged; a masked value in the file stops it).

Google sign-in: the OAuth client lives in Google Cloud project `agate-signin` (consent screen "agate", External, In
production since Oct 6 2026: anyone can sign in; home https://agate.elpabl0.xyz, privacy /privacy). Its id and secret
sit in `~/.agate-dynamic/google-oauth.env`; `server/scripts/providers.ts google <file>` hands them to Dynamic.
Allowed origins: `server/scripts/origins.ts`.

Passkeys (since Oct 6 2026): the passkey method under `security.mfa.methods` is on so people can add one; MFA itself
stays off (`mfa.enabled` false, nothing required). In SDK 1.38 a passkey counts as the person's MFA: once they have
one, every "Confirm it's you" (connect an AI, add another passkey, unlink Google) must use it, and Dynamic refuses an
email code (403 `mfa_required_for_elevated_auth`). The passkey method has no backup codes (`allowBackupCodes` false).

What it records that matters for agate: Monad testnet (10143) and mainnet (143) enabled; embedded wallets created at
sign-up, several per chain (the main wallet and the Assistant); delegated access on; session JWT 2 hours; no emails
on signed transactions; no device registration; Transaction Review off with failure policy ALLOW until Dynamic's
proxy for it works on 10143 (asked them on Oct 4 2026).

## Passkey accounts (Bring Your Own Auth)

A person can sign up with a passkey alone. agate's server checks the passkey and signs a JWT with the key in
`~/.agate-dynamic/byoa-es256.pem` (P-256, made on first use, mode 600, never printed); Dynamic checks it against
`${PUBLIC_BASE}/.well-known/agate-jwks.json` and creates the person with an `externalUser` credential. The setting is
`settings.security.externalAuth` in `sandbox.json` (on since Oct 11 2026: `iss` https://agate.elpabl0.xyz, `aud` the
environment id, `jwksUrl`, `assumeEmailVerified` false, `stepUpEnabled` true), written with `env.ts apply --settings`.

Dynamic holds every account to an email while email sign-in is on: an external user without one gets a session
limited to "fill in your details" (scope `userDataForm`, `missingFields` email) and no wallet, even with the email
field set optional (tried Oct 11 2026: no effect, set back to required). So the server runs with
`AGATE_BYOA_EMAIL_DOMAIN=passkey.agate.elpabl0.xyz`: each sign-in JWT carries a verified placeholder address
`pk-<32 hex>@passkey.agate.elpabl0.xyz`, one way from the account's `sub`. The domain takes no mail. Dynamic accepts the
same sign-in JWT twice (it enforces single use only for step-up JWTs), so it lives 60 seconds.

- Kill switch: `externalAuth.enabled` false (then `apply --settings`). New passkey sign-ins and step-ups stop; email
  and Google keep working; passkey accounts cannot sign in until it is back on.
- The key: losing or replacing it is harmless. The next key is served at the same address and JWTs live 60 seconds;
  accounts are keyed by their `sub`, not by the key.
- The database: `agate-server.db` maps each passkey to its account (tables `passkey_accounts`,
  `passkey_credentials`, `passkey_codes`; public keys and code hashes only). Losing it orphans every passkey account.
  The server copies it a minute after start and then daily to `~/.agate-dynamic/backups/agate-server-YYYY-MM-DD.db`
  (mode 600, the last 7 kept); the copies sit on the same disk, so copy one off the server before a rebuild. To
  restore: stop the server, put the copy back as `agate-server.db` (no `-wal` or `-shm` files beside it), put
  `backup-codes.key` back too (below), start it.
- The backup-code pepper: `~/.agate-dynamic/backup-codes.key` (made on first use, mode 600, never printed). Backup
  codes are stored only as HMACs under it, so it is deliberately NOT in the database copies: keep a copy of it off the
  server with the database copy, apart from it. Unlike the sign-in key, losing it is NOT harmless: every saved code
  stops working. While any code is stored the server refuses to make a new pepper (code `codes_unavailable`, 503)
  instead of silently replacing it.
- A passkey account that lost its passkey: synced passkeys (iCloud Keychain, Google Password Manager) cover most
  cases; check another device first. Otherwise one of the account's backup codes (shown once, at sign-up or when
  remade from the Account sheet) adds a new passkey to the same account. With neither, the account and its test
  dollars are lost.

## A person lost their passkey

What still works: signing in (email code or Google) and trading, since neither needs a step-up. What is blocked:
connecting a new AI and adding a passkey. Most passkeys sync (iCloud Keychain, Google Password Manager), so check
another of their devices first.

There is no reset we can run. Tested Oct 6 2026 on the test account agatepk4 (`35a3b494-...`):

- Dashboard, Users, the person, Reset MFA: clears MFA devices only. The passkey stays (it is a verified credential,
  not an MFA device) and an email step-up is still refused.
- Admin API: `DELETE /users/{id}/mfa` answers 401 with our admin token; no admin path deletes a passkey (404).
- The person deleting it themselves (`DELETE /sdk/{env}/users/passkeys`) needs a credential:unlink step-up, which
  needs the passkey.
- Turning the environment's passkey method off (even for 90 s) does not help: the step-up still requires the passkey.

This is about a Dynamic passkey added to an email or Google account (a passkey account made from a passkey alone
recovers with its own backup codes, above). The ways out, in order: (1) ask Dynamic support to remove the passkey
credential (give them the user id and the credential id from `GET /users/{id}`); (2) if it cannot wait, the person
signs up again with another email, moves their funds and positions over with ordinary sends from the old account
(signing needs no step-up), then the old user can be deleted in the dashboard. Prevention for later: turn on Dynamic's
own backup codes for the passkey method and show them once in the app when a passkey is added.
