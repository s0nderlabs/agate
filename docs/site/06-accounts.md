---
slug: accounts
title: Accounts and gas
description: Email, Google or a passkey; a smart account per person with sponsored gas; no wallet to install.
group: Concepts
order: 6
source: 'wallet/src, wallet/README.md'
---

# No wallet to install, no gas to pay.

People sign in with an email code or Google (and can add a passkey after). Behind that sits a real onchain account,
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

## Step-up

Sensitive actions (connecting a new AI, delegating the Assistant) ask the person to confirm again with a code or a
passkey. Signing in works with an email code or Google alone; a passkey is optional.

## Test dollars

The test dollar (tUSD, 6 decimals) has an open faucet: 10,000 a day per account, taken automatically at the first
sign-in. Pocket budgets move from the main account to the pocket and back.

## Measured on Monad testnet (Oct 4 2026, n = 1 to 3 each)

| Step | Time |
|---|---|
| sign-in with a code | 1.7 s |
| main wallet created | 9.8 s |
| a sponsored user operation from the main account | 6.0 s |
| pocket permission signed, pocket funded, grant accepted | 9.6 s |
| an AI trade from the pocket, signed by the delegated Assistant | 5.6 to 7.6 s |

## Signed out

Signed out, the app shows a practice account with example positions, so every screen can be explored before signing
in.
