# @agate/wallet

agate's accounts on Dynamic + ZeroDev, shared by the app (browser) and the server. Monad testnet (10143),
Kernel v3.1 on EntryPoint 0.7 (ERC-4337), every user operation sponsored by ZeroDev, under the project's chain
policy (at most 2 MON a user operation, 1,000 a day; the heaviest measured is 0.77 MON, a first trade that installs the
pocket's permission). When the paymaster refuses, `isSponsorRefusal(e)` is true and `SPONSOR_REFUSAL_TEXT` is the
sentence to show: nothing was sent.

## Who holds what

| Wallet | What it is | Signs |
|---|---|---|
| main | the person's first Dynamic embedded wallet (TSS-MPC, made at sign-in) | everything the person does in the app, in the browser |
| main account | Kernel index 0 owned by main | holds the money and positions |
| Assistant | a second embedded wallet, created and delegated to agate only when the person connects an AI | nothing but the pocket's session key |
| pocket | Kernel index 1 (2, 3, ... for more AIs) owned by main | holds only the AI's budget |

The main wallet is never delegated. The pocket's session key (signer: the Assistant) may only: approve the agate
router, open a long / daily long / short up to the per-trade cap with the payee pinned to the main account, close
its positions, take faucet dollars; at most N operations a day; until the end date. No transfers, no other
approvals, no ERC-1271 signatures. Checked onchain by the Kernel (ZeroDev CallPolicy 0.0.4, TimestampPolicy,
RateLimitPolicy with reset, SignatureCallerPolicy), again by agate's server, and again by Dynamic Transaction Review.

## In the app (browser)

```ts
import { createAgateDynamic, startEmailSignIn, finishEmailSignIn, ensureMainWallet, ensureAssistantWallet,
  delegateAssistant, revokeAssistant, walletSigner, wallets, sessionToken } from "@agate/wallet/dynamic";
import { kernelAccount, accountClient, zerodev, sendCalls, createPocketPermission, fundPocketCalls,
  shortTokensCapFor, AGATE } from "@agate/wallet";

const client = await createAgateDynamic();                     // headless, no Dynamic UI
const otp = await startEmailSignIn(client, email);
await finishEmailSignIn(client, otp, code);                    // delegating needs its own step-up later (confirmStepUp)
const main = await ensureMainWallet(client);
const signer = await walletSigner(client, main);               // viem account backed by the embedded wallet
const account = await kernelAccount(publicClient, signer);     // the main account (Kernel v3.1)
const kc = accountClient(account, publicClient, zerodev(ZERODEV_RPC));
await sendCalls(kc, calls);                                    // one batched, sponsored user operation
```

Connect an AI (the Allow page): `ensureAssistantWallet` -> `delegateAssistant` -> `createPocketPermission(pc, signer,
terms)` (one signature by main) -> `sendCalls(kc, fundPocketCalls(AGATE.dollar, pocket, budget))` -> POST the grant to
agate's server (`/api/grants`, `Authorization: Bearer ${sessionToken(client)}`). Disconnect: `revokeAssistant` +
`POST /api/grants/:id/disconnect`. The working reference is `lab/main.ts` (`bun run lab`, http://localhost:5174).
A delegation whose webhook agate's server missed (`/api/me` lists no active delegation, yet `isDelegated(client,
assistant)` is true) is redone in the app: `revokeAssistant` (a failed revoke is shown, never ignored), a fresh step-up
when the scope has lapsed, then `delegateAssistant`, so Dynamic sends the share again.

## Measured on Monad testnet (Oct 4 2026, test account, n = 1 to 3 each)

- sign-in with a code 1.7 s; main wallet created 9.8 s; Assistant created 6.4 s; delegated 5.7 s
- sponsored user operation from the main account 6.0 s
- pocket permission signed + pocket funded + grant accepted 9.6 s
- AI trade from the pocket, signed by the delegated Assistant: 5.6 to 7.6 s (prepare 0.8 to 1.6, sign 2.8 to 3.5)
- onchain refusals with the server bypassed: over cap `CallViolatesParamRule()`, transfer `InvalidCallData()`,
  4th operation in a day `RateLimited()`

## Tests

`bun test` (unit); `FORK=1 bun test ./test/pocket.fork.test.ts` (anvil fork of Monad testnet through
`wall/scripts/anvil-safe.sh`: 8 checks of the pocket's onchain limits).
