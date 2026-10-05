// Browser only: Dynamic's headless JS SDK set up for agate, and the wallet steps the app performs. No Dynamic UI is
// used; the app draws its own sheets. Every function takes the client so the app can hold one instance.
//
// Wallets of one person (Dynamic embedded wallets, TSS-MPC):
//  - main: created at sign-up; owns the main Kernel account (index 0) and every pocket (index 1, 2, ...). Never
//    delegated.
//  - Assistant: a second EVM embedded wallet, created and delegated to agate only when the person connects an AI.
//    It signs nothing but the pockets' session keys (checked onchain), and Transaction Review checks it again.
import {
  completeSocialRedirect,
  createDynamicClient,
  detectSocialRedirectUrl,
  type DynamicClient,
  getElevatedAccessToken,
  getUserSocialAccounts,
  getWalletAccounts,
  initializeClient,
  logout,
  onEvent,
  refreshAuth,
  sendEmailOTP,
  signInWithSocialRedirect,
  switchActiveNetwork,
  unlinkSocialAccount,
  verifyOTP,
} from "@dynamic-labs-sdk/client";
import { createWaasWalletAccounts, delegateWaasKeyShares, getChainsMissingWaasWalletAccounts, hasDelegatedAccess, isWaasWalletAccount, revokeWaasDelegation } from "@dynamic-labs-sdk/client/waas";
import type { EvmWalletAccount } from "@dynamic-labs-sdk/evm";
import { createWalletClientForWalletAccount } from "@dynamic-labs-sdk/evm/viem";
import { addWaasEvmExtension } from "@dynamic-labs-sdk/evm/waas";
import { addZerodevExtension } from "@dynamic-labs-sdk/zerodev";
import type { Address, LocalAccount } from "viem";
import { toAccount } from "viem/accounts";
import { monadTestnet } from "./chain.ts";

export const AGATE_DYNAMIC_ENVIRONMENT_ID = "db2880bd-e52a-4f00-aa83-2c3ec77281cb";

const monadNetwork = {
  blockExplorerUrls: [monadTestnet.blockExplorers.default.url],
  chain: "EVM" as const,
  displayName: monadTestnet.name,
  iconUrl: "",
  name: monadTestnet.name,
  nativeCurrency: { decimals: 18, name: "Monad", symbol: "MON" },
  networkId: String(monadTestnet.id),
  rpcUrls: { http: [...monadTestnet.rpcUrls.default.http] },
  testnet: true,
};

export async function createAgateDynamic(environmentId = AGATE_DYNAMIC_ENVIRONMENT_ID, appName = "agate"): Promise<DynamicClient> {
  const client = createDynamicClient({
    environmentId,
    autoInitialize: false,
    metadata: { name: appName },
    transformers: {
      // the dashboard lists Monad testnet, but keep it present even if the public settings lag behind
      networksData: (list) => (list.some((n) => n.chain === "EVM" && n.networkId === String(monadTestnet.id)) ? list : [...list, monadNetwork]),
    },
  });
  addWaasEvmExtension(client);
  addZerodevExtension(client);
  await initializeClient(client);
  return client;
}

// ------------------------------------------------------------------ sign-in (email code)

export type EmailOtp = Awaited<ReturnType<typeof sendEmailOTP>>;

export function startEmailSignIn(client: DynamicClient, email: string): Promise<EmailOtp> {
  return sendEmailOTP({ email }, client);
}

/** Completes the email code. `stepUp: true` also asks for the scope that delegating a wallet needs, so connecting an
 *  AI right after sign-in needs no second code ("Confirm it's you" is this same code). */
export function finishEmailSignIn(client: DynamicClient, otp: EmailOtp, code: string, opts: { stepUp?: boolean } = {}) {
  return verifyOTP({ otpVerification: otp, verificationToken: code, ...(opts.stepUp ? { requestedScopes: ["wallet:delegate" as never] } : {}) }, client);
}

// ------------------------------------------------------------------ sign-in (Google)

/** "Continue with Google": leaves the page for Google and comes back to `redirectUrl` (an allowed origin). */
export function startGoogleSignIn(client: DynamicClient, redirectUrl: string = globalThis.location?.href ?? ""): Promise<void> {
  return signInWithSocialRedirect({ provider: "google", redirectUrl }, client);
}

/** Call once on page load: when the URL is Google's return, completes the sign-in (with the delegate scope when
 *  `stepUp`, like finishEmailSignIn) and returns true; otherwise does nothing and returns false. */
export async function finishGoogleSignIn(client: DynamicClient, url: string = globalThis.location?.href ?? "", opts: { stepUp?: boolean } = {}): Promise<boolean> {
  const u = new URL(url);
  if (!(await detectSocialRedirectUrl({ url: u }, client))) return false;
  await completeSocialRedirect({ url: u, ...(opts.stepUp ? { requestedScopes: ["wallet:delegate" as never] } : {}) }, client);
  return true;
}

/** Google accounts linked to the signed-in person. NOTE: finishing a Google redirect while someone is already signed
 *  in LINKS that Google account to them (it is not a sign-in), so sign out before "Continue with Google". */
export function googleAccounts(client: DynamicClient) {
  return getUserSocialAccounts(client).filter((a) => a.provider === "google");
}

export async function unlinkGoogle(client: DynamicClient): Promise<number> {
  const linked = googleAccounts(client);
  for (const a of linked) await unlinkSocialAccount({ verifiedCredentialId: a.verifiedCredentialId }, client);
  return linked.length;
}

/** The user's Dynamic session JWT, for agate's own API (verified there against Dynamic's JWKS). */
export function sessionToken(client: DynamicClient): string | null {
  return client.token;
}

/** When the session ends (the SDK signs out by itself at this moment, reason "token-expired"; it never refreshes on
 *  its own). Project setting: 2 hours. */
export function sessionExpiresAt(client: DynamicClient): Date | null {
  return client.sessionExpiresAt ?? null;
}

/** Extends the session (call on focus and ~10 minutes before sessionExpiresAt while the tab is in use). */
export async function refreshSession(client: DynamicClient): Promise<void> {
  await refreshAuth(client);
}

export function signOut(client: DynamicClient): Promise<void> {
  return logout(client);
}

export type SessionEvent =
  | { kind: "signed-out"; reason: string }
  | { kind: "token-changed" }
  | { kind: "session-expiry-changed"; expiresAt: Date | null }
  | { kind: "wallets-changed" }
  | { kind: "user-changed" };

/** One stream of the session events the app reacts to; returns an unsubscribe. */
export function onSessionEvent(client: DynamicClient, cb: (e: SessionEvent) => void): () => void {
  const offs = [
    onEvent({ event: "logout", listener: (m?: { reason?: string }) => cb({ kind: "signed-out", reason: m?.reason ?? "user-intent" }) }, client),
    onEvent({ event: "tokenChanged", listener: () => cb({ kind: "token-changed" }) }, client),
    onEvent({ event: "sessionExpiresAtChanged", listener: () => cb({ kind: "session-expiry-changed", expiresAt: client.sessionExpiresAt ?? null }) }, client),
    onEvent({ event: "walletAccountsChanged", listener: () => cb({ kind: "wallets-changed" }) }, client),
    onEvent({ event: "userChanged", listener: () => cb({ kind: "user-changed" }) }, client),
  ];
  return () => offs.forEach((off) => off());
}

// ------------------------------------------------------------------ step-up (delegating needs a fresh code)

/** True while the session holds an unexpired wallet:delegate scope (checked without using it up). */
export function canDelegate(client: DynamicClient): boolean {
  return Boolean(getElevatedAccessToken({ scope: "wallet:delegate", consume: false }, client));
}

/** "Confirm it's you" for a person already signed in (only needed again after Revoke Assistant): send a code to the
 *  person's email, then confirmStepUp with it. */
export function requestStepUp(client: DynamicClient, email: string): Promise<EmailOtp> {
  return sendEmailOTP({ email }, client);
}

/** `scopes`: wallet:delegate (connect an AI) by default; credential:unlink before unlinkGoogle. */
export function confirmStepUp(client: DynamicClient, otp: EmailOtp, code: string, scopes: string[] = ["wallet:delegate"]) {
  return verifyOTP({ otpVerification: otp, verificationToken: code, requestedScopes: scopes as never }, client);
}

// ------------------------------------------------------------------ wallets

const isEvmWaas = (a: { chain: string }): a is EvmWalletAccount => a.chain === "EVM" && isWaasWalletAccount({ walletAccount: a as never });

export type Wallets = { main: EvmWalletAccount; assistant: EvmWalletAccount | null };

/** The person's embedded EVM wallets: main is the first; the Assistant is the delegated one, else the second. */
export function wallets(client: DynamicClient): Wallets | null {
  const evm = getWalletAccounts(client).filter(isEvmWaas);
  if (evm.length === 0) return null;
  const delegated = evm.filter((w) => hasDelegatedAccess({ walletAccount: w }, client));
  const main = evm.find((w) => !delegated.includes(w)) ?? evm[0]!;
  const assistant = delegated[0] ?? evm.find((w) => w !== main) ?? null;
  return { main, assistant };
}

export async function ensureMainWallet(client: DynamicClient): Promise<EvmWalletAccount> {
  const missing = getChainsMissingWaasWalletAccounts(client);
  if (missing.length) await createWaasWalletAccounts({ chains: missing }, client);
  const w = wallets(client);
  if (!w) throw new Error("no embedded wallet after creating one");
  return w.main;
}

/** Creates the Assistant (a second EVM embedded wallet) when the person has none. Needs "Allow multiple embedded
 *  wallets per chain" in the Dynamic dashboard. */
export async function ensureAssistantWallet(client: DynamicClient): Promise<EvmWalletAccount> {
  let w = wallets(client);
  if (!w) throw new Error("sign in first");
  if (!w.assistant) {
    await createWaasWalletAccounts({ chains: ["EVM"] }, client);
    w = wallets(client);
  }
  if (!w?.assistant) throw new Error("the Assistant wallet was not created (is multiple wallets per chain allowed?)");
  return w.assistant;
}

/** Whether Dynamic counts this wallet as delegated (agate's server may still lack the share if its webhook was missed). */
export function isDelegated(client: DynamicClient, account: EvmWalletAccount): boolean {
  return hasDelegatedAccess({ walletAccount: account }, client);
}

/** Delegates the Assistant (never the main wallet) to agate. Dynamic posts the encrypted share to agate's webhook. */
export async function delegateAssistant(client: DynamicClient, assistant: EvmWalletAccount): Promise<void> {
  const w = wallets(client);
  if (w && w.main.address.toLowerCase() === assistant.address.toLowerCase()) throw new Error("refusing to delegate the main wallet");
  if (hasDelegatedAccess({ walletAccount: assistant }, client)) return;
  await delegateWaasKeyShares({ walletAccount: assistant }, client);
}

/** "Disconnect": the Assistant stops signing at once, whatever agate's server does. */
export function revokeAssistant(client: DynamicClient, assistant: EvmWalletAccount): Promise<void> {
  return revokeWaasDelegation({ walletAccount: assistant }, client);
}

/** An embedded wallet as a viem account (for ZeroDev's validators), on Monad testnet. */
export async function walletSigner(client: DynamicClient, account: EvmWalletAccount): Promise<LocalAccount> {
  try {
    await switchActiveNetwork({ networkId: String(monadTestnet.id), walletAccount: account }, client);
  } catch {
    // the wallet client below is created for the active network; signatures do not depend on it
  }
  const wc = await createWalletClientForWalletAccount({ walletAccount: account }, client);
  return toAccount({
    address: account.address as Address,
    signMessage: ({ message }) => wc.signMessage({ account: wc.account, message }),
    signTypedData: (td) => wc.signTypedData({ account: wc.account, ...(td as object) } as never),
    signTransaction: async () => {
      throw new Error("agate's embedded wallets sign user operations, never raw transactions");
    },
  });
}
