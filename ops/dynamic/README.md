# agate's Dynamic environment, as code

`sandbox.json` is the Dynamic sandbox environment agate runs on (`db2880bd-...`): every settings group, the enabled
providers (email code, Google, passkey, embedded wallets), the delegation webhook, the Transaction Review config and
the allowed origins (the app on :3317 and the lab on :5174; social sign-in stays off in Dynamic until one is set). The server's public base is written as `${PUBLIC_BASE}` because it changes with every tunnel. There
are no secrets in it: the webhook secret, the review HMAC secret and Ed25519 key, the delegation RSA key and the API
tokens live in `~/.agate-dynamic/` and are never read back from Dynamic.

From `server/` (needs the admin token in `~/.agate-dynamic/admin.env` and `AGATE_PUBLIC_BASE`):

- `bun run scripts/env.ts export`: write the file from the live environment.
- `bun run scripts/env.ts diff`: list what differs between the file and the live environment.
- `bun run scripts/env.ts apply`: point the webhook and Transaction Review at `AGATE_PUBLIC_BASE` with the file's
  switches (run it after the tunnel or host changes). `--settings` also writes the file's settings (the live providers
  are sent back unchanged; a masked value in the file stops it).

Google sign-in: the OAuth client lives in Google Cloud project `agate-signin` (consent screen "agate", External,
Testing: only listed test users can sign in until the app has a public home page and privacy policy to publish
with). Its id and secret sit in `~/.agate-dynamic/google-oauth.env`; `server/scripts/providers.ts google <file>`
hands them to Dynamic. Allowed origins: `server/scripts/origins.ts`.

What it records that matters for agate: Monad testnet (10143) and mainnet (143) enabled; embedded wallets created at
sign-up, several per chain (the main wallet and the Assistant); delegated access on; session JWT 2 hours; no emails
on signed transactions; no device registration; Transaction Review off with failure policy ALLOW until Dynamic's
proxy for it works on 10143 (asked them on Oct 4 2026).
