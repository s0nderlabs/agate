---
slug: accounts
title: Accounts and gas
description: A passkey alone, email or Google; a smart account per person with sponsored gas; no wallet to install.
group: Concepts
order: 6
source: 'wallet/src, wallet/README.md'
---

# No wallet to install, no gas to pay.

People sign up with a passkey alone, an email code or Google. Behind that sits a real onchain account,
a smart account on Monad, whose transactions Agate pays for. The account layer is Dynamic for sign-in and embedded
wallets, and ZeroDev for the smart accounts and gas sponsorship.

## Who holds what

| Wallet | What it is | Signs |
|---|---|---|
| main | the person's first Dynamic embedded wallet (TSS-MPC, made at sign-in) | everything the person does in the app |
| main account | a Kernel smart account (index 0) owned by main | holds the money and the positions |
| Assistant | a second embedded wallet, created and delegated to Agate only when the person connects an AI | nothing but an AI pocket's session key |
| pocket | a Kernel smart account (index 1, 2, ... one per AI) owned by main | holds only that AI's budget |

The main wallet is never delegated. Smart accounts are Kernel v3.1 on EntryPoint 0.7 (ERC-4337).

## Gas

Every user operation is sponsored through ZeroDev under the project's chain policy (at most 2 MON a user operation,
1,000 a day; the heaviest measured is 0.77 MON, a first trade that installs a pocket's permission). A trade is one
batched user operation: an approval when one is short, then the router call. When the sponsor refuses, nothing is
sent and the app says so.

## Passkey accounts

**Continue with a passkey** makes an account from a passkey alone, with no email. The browser's own dialog makes the
passkey (Touch ID, Face ID, Windows Hello or a phone). Agate's server checks it and hands the app a sign-in token that
lives 60 seconds; Dynamic checks that token against Agate's public key and opens a normal session (Dynamic's Bring
Your Own Auth). The main wallet, the 10,000 test dollars and everything after are the same as for any account.

- **Next time, in the same browser,** the same button signs in. **In another browser or on a new device,** tap
  **I already have a passkey**: it uses a passkey synced there, or one on your phone. The main button there would
  make a second, empty account.
- **The passkey is the way in, and backup codes are the way back.** One saved to iCloud Keychain or Google Password
  Manager follows you to your other devices. When the account is made, the app shows **ten backup codes** once
  (`XXXX-XXXX`, with Copy and Download). If every copy of the passkey is lost, **Sign in**, then **Lost your passkey?
  Use a backup code**: the code makes a new passkey on the same account, and is used up. **Make new backup codes**
  on the Account sheet replaces the set and asks for your passkey first. Losing the passkey and every code loses
  the account and its test dollars ([Limits](16-limits.md)).
- **An email or Google account stays separate.** The two are never joined. A passkey added earlier to an email or
  Google account still signs that account in: tap **I already have a passkey**, then **Continue**.
- Dynamic needs an email on every account, so a passkey account carries a placeholder address that takes no mail. The
  app never shows it ([Built on](15-built-on.md#dynamic-sign-in-and-wallets)).
- Agate's server keeps no secrets, only public keys and keyed hashes of the backup codes, so its database alone
  cannot sign anyone in. A code is 40 bits; guessing is held to 5 tries a minute per network.

## Step-up

Sensitive actions (connecting a new AI, delegating the Assistant) ask the person to confirm again: a passkey account
with its passkey, an email or Google account with a code. An email or Google account can also add a passkey from the
Account sheet; once it has one, every confirmation goes through it instead of a code.

## Test dollars

The test dollar (tUSD, 6 decimals) has an open faucet: 10,000 per account every 24 hours of real time, counted from
that account's last drip (`dripPeriod` is 86,400 s on `AgateDollar`), not per calendar day. The app takes the first
drip at the first sign-in. Too soon, the faucet refuses with `DripTooSoon` and the app says when the next one opens.
Pocket budgets move from the main account to the pocket and back.

## Measured on Monad testnet

Oct 4 2026, n = 1 to 3 each:

| Step | Time |
|---|---|
| sign-in with a code | 1.7 s |
| main wallet created | 9.8 s |
| a sponsored user operation from the main account | 6.0 s |
| pocket permission signed, pocket funded, grant accepted | 9.6 s |
| an AI trade from the pocket, signed by the delegated Assistant | 5.6 to 7.6 s |

Passkey accounts, Oct 11 2026, in a test browser with a software passkey (so no time for a person in the dialog):

| Step | Time |
|---|---|
| passkey dialog to a signed-in session | 2.8 to 3.8 s |
| main wallet created | 7 to 9 s |
| confirming again with the passkey (step-up) | 2.4 s |

## Signed out

Signed out, the app shows a practice account with example positions, so every screen can be explored before signing
in.
