// Browser only: Dynamic's headless JS SDK set up for agate, and the wallet steps the app performs. No Dynamic UI is
// used; the app draws its own sheets. Every function takes the client so the app can hold one instance.
//
// Wallets of one person (Dynamic embedded wallets, TSS-MPC):
//  - main: created at sign-up; owns the main Kernel account (index 0) and every pocket (index 1, 2, ...). Never
//    delegated.
//  - Assistant: a second EVM embedded wallet, created and delegated to agate only when the person connects an AI.
//    It signs nothing but the pockets' session keys (checked onchain), and Transaction Review checks it again.
import {
  authenticatePasskeyMFA,
  completeSocialRedirect,
  createDynamicClient,
  detectSocialRedirectUrl,
  type DynamicClient,
  getElevatedAccessToken,
  getPasskeys,
  getUserSocialAccounts,
  getWalletAccounts,
  initializeClient,
  logout,
  onEvent,
  refreshAuth,
  registerPasskey,
  requestExternalAuthElevatedToken,
  SandboxMaximumThresholdReachedError,
  sendEmailOTP,
  signInWithExternalJwt,
  signInWithPasskey,
  signInWithSocialRedirect,
  switchActiveNetwork,
  unlinkSocialAccount,
  verifyOTP,
} from "@dynamic-labs-sdk/client";
import { getSessionKeys } from "@dynamic-labs-sdk/client/core";
import { createWaasWalletAccounts, delegateWaasKeyShares, getChainsMissingWaasWalletAccounts, hasDelegatedAccess, isWaasWalletAccount, revokeWaasDelegation } from "@dynamic-labs-sdk/client/waas";
import type { EvmWalletAccount } from "@dynamic-labs-sdk/evm";
import { createWalletClientForWalletAccount } from "@dynamic-labs-sdk/evm/viem";
import { addWaasEvmExtension } from "@dynamic-labs-sdk/evm/waas";
import { addZerodevExtension } from "@dynamic-labs-sdk/zerodev";
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { Address, LocalAccount } from "viem";
import { toAccount } from "viem/accounts";
import { monadTestnet } from "./chain.ts";
import { realEmail } from "./placeholder.ts";

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

/** Completes the email code. `stepUp: true` asks for the scope that delegating a wallet needs, but SDK 1.38 sends
 *  requestedScopes only on a signed-in step-up, never on this sign-in call, so Dynamic never grants it here and
 *  connecting an AI still asks its own "Confirm it's you" (canDelegate is false). allowNewMFALinking: a person
 *  without MFA gets a credential:link scope for a while, so "Add a passkey" right after needs no code. */
export function finishEmailSignIn(client: DynamicClient, otp: EmailOtp, code: string, opts: { stepUp?: boolean } = {}) {
  return verifyOTP({ otpVerification: otp, verificationToken: code, allowNewMFALinking: true, ...(opts.stepUp ? { requestedScopes: ["wallet:delegate" as never] } : {}) }, client);
}

// ------------------------------------------------------------------ sign-in (Google)

/** "Continue with Google": leaves the page for Google and comes back to `redirectUrl` (an allowed origin). */
export function startGoogleSignIn(client: DynamicClient, redirectUrl: string = globalThis.location?.href ?? ""): Promise<void> {
  return signInWithSocialRedirect({ provider: "google", redirectUrl }, client);
}

/** Call once on page load: when the URL is Google's return, completes the sign-in and returns true; otherwise does
 *  nothing and returns false. `stepUp` is dropped like finishEmailSignIn's: SDK 1.38 sends requestedScopes only when
 *  linking Google to someone already signed in (oauthVerify), not on this sign-in (oauthSignIn). */
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

// ------------------------------------------------------------------ sign-in (passkey)

/** "Sign in with a passkey": the browser offers the passkeys saved for this site, and one added earlier with addPasskey
 *  signs that person in. A passkey cannot sign up: a new person signs up with an email code or Google first. This
 *  sign-in carries no delegate scope, so connecting an AI after it asks "Confirm it's you" with the passkey
 *  (confirmWithPasskey: Dynamic refuses an email code once a person has one). */
export function startPasskeySignIn(client: DynamicClient) {
  return signInWithPasskey({}, client);
}

/** Adds a passkey to the signed-in person (the browser's own dialog), for "Sign in with a passkey" next time. Dynamic
 *  needs a fresh credential:link scope for it (canAddPasskey): an email-code sign-in carries one for a while (only
 *  while the person has no passkey yet); otherwise requestStepUp then confirmStepUp(..., ["credential:link"]) gets one,
 *  or confirmWithPasskey(..., ["credential:link"]) once a passkey exists. Needs the environment's passkey method on
 *  (security.mfa.methods passkey; MFA enforcement itself stays off). */
export function addPasskey(client: DynamicClient) {
  return registerPasskey({}, client);
}

/** "Confirm it's you" with a passkey (the browser's own dialog) for `scopes`. Once a person has a passkey, Dynamic
 *  routes every step-up there and refuses an email code ("mfa_required_for_elevated_auth"). */
export function confirmWithPasskey(client: DynamicClient, scopes: string[]) {
  return authenticatePasskeyMFA({ requestedScopes: scopes as never }, client);
}

/** True while the session holds an unexpired credential:link scope, so addPasskey needs no code first. */
export function canAddPasskey(client: DynamicClient): boolean {
  return Boolean(getElevatedAccessToken({ scope: "credential:link", consume: false }, client));
}

/** How many passkeys the signed-in person has. */
export async function passkeyCount(client: DynamicClient): Promise<number> {
  return (await getPasskeys(client)).length;
}

// ------------------------------------------------------------------ passkey accounts (a passkey alone, no email)

/** "Continue with a passkey": sign up or sign in with a passkey alone. These are agate's passkeys, checked by agate's
 *  server, which answers a JWT that lives 60 seconds; Dynamic turns it into a normal session (Bring Your Own Auth),
 *  and the main wallet and test dollars follow as for any sign-up. startPasskeySignIn and addPasskey above stay for
 *  people who added a Dynamic passkey to an email or Google account; a passkey account never has one.
 *  `server` is agate's server base (AGATE_SERVER). Every failure is an AgatePasskeyError with a code. */

export type PasskeyCeremony = { ceremonyId: string; options: unknown };
/** a sign-in and a sign-up ceremony fetched when the sheet opens, so the tap opens the browser's dialog at once.
 *  Each is used once (the functions below mark the object spent) and is not used after 4 minutes. */
export type PasskeyPrepared = { signin: PasskeyCeremony; register: PasskeyCeremony | null; signupClosed: boolean; at: number };
export type PasskeyResult = { sub: string; created: boolean };
export type PasskeyErrorCode =
  /** this browser has no passkeys */
  | "unsupported"
  /** the browser's dialog was closed, or no passkey was picked (the two cannot be told apart) */
  | "cancelled"
  /** this passkey already has an account: sign in instead */
  | "exists"
  /** not one of agate's passkeys: most likely an older Dynamic passkey (offer startPasskeySignIn) */
  | "unknown_passkey"
  /** the request ended (5 minutes): try again */
  | "expired"
  | "rate_limited"
  /** new passkey accounts are paused for today: email or Google still work */
  | "signups_paused"
  /** agate refused the passkey (not verified, wrong account, ...) */
  | "rejected"
  /** the passkey checked out but Dynamic did not finish the sign-in or the step-up */
  | "dynamic"
  /** a backup code that does not work (wrong, used, or replaced by a newer set) */
  | "bad_code"
  /** agate's server could not be reached or failed */
  | "service";

export class AgatePasskeyError extends Error {
  override name = "AgatePasskeyError";
  constructor(
    readonly code: PasskeyErrorCode,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
    /** the server's own code (for example "passkey_needed"), when it answered one */
    readonly serverCode?: string,
  ) {
    super(message, options);
  }
}

const PREPARED_MS = 4 * 60_000;
const HINT_KEY = "agate-passkey-v1";

export async function passkeySupport(): Promise<{ webauthn: boolean; autofill: boolean }> {
  return { webauthn: browserSupportsWebAuthn(), autofill: browserSupportsWebAuthn() && (await browserSupportsWebAuthnAutofill()) };
}

/** True when this browser made or used an agate passkey before (kept through sign-out): "Continue" then signs in
 *  first instead of making a new account. */
export function hasPasskeyHint(): boolean {
  try {
    return Boolean(globalThis.localStorage?.getItem(HINT_KEY));
  } catch {
    return false;
  }
}

function writeHint(): void {
  try {
    globalThis.localStorage?.setItem(HINT_KEY, JSON.stringify({ at: Date.now() }));
  } catch {
    // storage blocked (a private window): the next tap asks to create again
  }
}

/** agate's codes that the app tells apart; any other refusal is "rejected" */
const SERVER_CODES = new Set<string>(["unknown_passkey", "expired", "signups_paused", "exists", "rate_limited", "bad_code"] satisfies PasskeyErrorCode[]);

/** a call to agate's passkey routes; `body` undefined is a GET */
async function agatePost<T>(server: string, path: string, body: unknown, token?: string | null): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${server.replace(/\/+$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "omit",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new AgatePasskeyError("service", "Agate's server could not be reached", undefined, { cause: e });
  }
  const j = (await r.json().catch(() => null)) as { error?: string; code?: string } | null;
  if (r.ok && j) return j as T;
  const code: PasskeyErrorCode = r.status === 429 ? "rate_limited" : j?.code && SERVER_CODES.has(j.code) ? (j.code as PasskeyErrorCode) : r.status >= 500 || !j ? "service" : "rejected";
  throw new AgatePasskeyError(code, j?.error ?? `Agate's server answered ${r.status}`, r.status, undefined, j?.code);
}

function fromBrowser(e: unknown): AgatePasskeyError {
  const { name, code } = (e ?? {}) as { name?: string; code?: string };
  if (name === "NotAllowedError" || name === "AbortError" || code === "ERROR_CEREMONY_ABORTED") return new AgatePasskeyError("cancelled", "The passkey dialog was closed.", undefined, { cause: e });
  if (name === "InvalidStateError" || code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return new AgatePasskeyError("exists", "This device already has a passkey for Agate: sign in instead.", undefined, { cause: e });
  return new AgatePasskeyError("unsupported", "This browser could not use a passkey.", undefined, { cause: e });
}

function fromDynamic(e: unknown): AgatePasskeyError {
  if (e instanceof SandboxMaximumThresholdReachedError) return new AgatePasskeyError("signups_paused", "New accounts are paused right now: try email or Google later.", undefined, { cause: e });
  return new AgatePasskeyError("dynamic", "Your passkey worked, but sign-in didn't finish. Try again.", undefined, { cause: e });
}

function needWebAuthn(): void {
  if (!browserSupportsWebAuthn()) throw new AgatePasskeyError("unsupported", "This browser has no passkeys: use email or Google.");
}

/** the browser's dialog, its failures named */
async function dialog<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw fromBrowser(e);
  }
}

/** agate checks the dialog's answer and hands back a JWT, which goes to Dynamic once */
async function finishPasskey(client: DynamicClient, server: string, path: "/api/passkey/register" | "/api/passkey/signin" | "/api/passkey/recover", ceremonyId: string, response: unknown, created: boolean): Promise<PasskeyResult & { codesLeft?: number }> {
  const { externalJwt, sub, codesLeft } = await agatePost<{ externalJwt: string; sub: string; codesLeft?: number }>(server, path, { ceremonyId, response });
  // before Dynamic: if its step fails, the account exists and the next tap signs in instead of making another
  writeHint();
  await intoDynamic(client, externalJwt);
  return { sub, created, ...(codesLeft === undefined ? {} : { codesLeft }) };
}

/** Fetches a sign-in and a sign-up ceremony (call when the sheet opens, and again when the result is 4 minutes old). */
export async function preparePasskey(server: string): Promise<PasskeyPrepared> {
  return { ...(await agatePost<Omit<PasskeyPrepared, "at">>(server, "/api/passkey/options", {})), at: Date.now() };
}

/** the prepared ceremonies if still usable, and marks them spent either way */
function takePrepared(p?: PasskeyPrepared): PasskeyPrepared | undefined {
  if (!p) return undefined;
  const usable = Date.now() - p.at < PREPARED_MS;
  p.at = 0;
  return usable ? p : undefined;
}

/** The session key Dynamic signs its requests with: a sign-out drops it and makes the next one in the background, so
 *  wait for it rather than sign in without one (the token would then carry no session key). */
async function sessionPublicKey(client: DynamicClient): Promise<string | undefined> {
  for (let i = 0; i < 60 && !getSessionKeys(client); i++) await new Promise((r) => setTimeout(r, 50));
  return getSessionKeys(client)?.publicKey;
}

/** Hands agate's JWT to Dynamic (once: it is never retried, stored or logged). Someone else signed in is signed out
 *  first, after the browser's dialog, so a closed dialog leaves them signed in. */
async function intoDynamic(client: DynamicClient, externalJwt: string): Promise<void> {
  try {
    if (client.user) await logout(client);
    await signInWithExternalJwt({ externalJwt, sessionPublicKey: await sessionPublicKey(client) }, client);
  } catch (e) {
    throw fromDynamic(e);
  }
}

/** A new account from a new passkey: one browser dialog, then a Dynamic session (then ensureMainWallet as for any
 *  sign-up). */
export async function createAccountWithPasskey(client: DynamicClient, server: string, prepared?: PasskeyPrepared): Promise<PasskeyResult> {
  needWebAuthn();
  const p = takePrepared(prepared) ?? (await preparePasskey(server));
  const reg = p.register;
  if (!reg) throw new AgatePasskeyError("signups_paused", "New passkey accounts are paused for today: use email or Google.");
  const response = await dialog(() => startRegistration({ optionsJSON: reg.options as never }));
  return finishPasskey(client, server, "/api/passkey/register", reg.ceremonyId, response, true);
}

/** Signs in with a passkey made here before (the browser offers the ones saved for this site, synced ones too). */
export async function signInWithAgatePasskey(client: DynamicClient, server: string, prepared?: PasskeyPrepared): Promise<PasskeyResult> {
  needWebAuthn();
  const p = takePrepared(prepared) ?? (await preparePasskey(server));
  const response = await dialog(() => startAuthentication({ optionsJSON: p.signin.options as never }));
  return finishPasskey(client, server, "/api/passkey/signin", p.signin.ceremonyId, response, false);
}

/** The one button: signs in when this browser used an agate passkey before, else makes a new account. "I already
 *  have a passkey" passes mode "signin" (a new browser with a synced passkey). */
export function continueWithPasskey(client: DynamicClient, server: string, opts: { mode?: "auto" | "signin" | "create"; prepared?: PasskeyPrepared } = {}): Promise<PasskeyResult> {
  const mode = opts.mode === "signin" || opts.mode === "create" ? opts.mode : hasPasskeyHint() ? "signin" : "create";
  return mode === "signin" ? signInWithAgatePasskey(client, server, opts.prepared) : createAccountWithPasskey(client, server, opts.prepared);
}

/** The person's email to show, or null: a passkey account's address is a placeholder Dynamic requires
 *  (pk-<hex>@...), nobody's mailbox; a real email linked later is shown. */
export function shownEmail(client: DynamicClient): string | null {
  return realEmail(client.user?.email) ?? client.user?.verifiedCredentials?.map((c) => (String(c.format) === "email" ? realEmail(c.email) : null)).find(Boolean) ?? null;
}

/** True for a person who signed up with a passkey alone: "Confirm it's you" then uses confirmWithAgatePasskey (they
 *  have no email for a code and no Dynamic passkey). */
export function isAgatePasskeyAccount(client: DynamicClient): boolean {
  return Boolean(client.user?.verifiedCredentials?.some((c) => String(c.format) === "externalUser"));
}

/** "Confirm it's you" for a passkey account: the browser's dialog with this account's passkeys only, then Dynamic
 *  grants `scope` (wallet:delegate before connecting an AI, so canDelegate turns true; credential:link before adding
 *  an email). */
export async function confirmWithAgatePasskey(client: DynamicClient, server: string, scope: "wallet:delegate" | "credential:link"): Promise<void> {
  needWebAuthn();
  const token = sessionToken(client);
  if (!token) throw new AgatePasskeyError("rejected", "Sign in first.");
  const o = await agatePost<PasskeyCeremony>(server, "/api/passkey/stepup/options", { scope }, token);
  const response = await dialog(() => startAuthentication({ optionsJSON: o.options as never }));
  const { externalJwt } = await agatePost<{ externalJwt: string }>(server, "/api/passkey/stepup", { ceremonyId: o.ceremonyId, response }, token);
  try {
    await requestExternalAuthElevatedToken({ externalJwt }, client);
  } catch (e) {
    throw fromDynamic(e);
  }
}

// ------------------------------------------------------------------ backup codes (a lost passkey)

/** Ten one-time backup codes for this passkey account, shown once ("XXXX-XXXX"): each adds a new passkey to the
 *  account when every copy of the old one is lost. A new account's first set right after sign-up needs nothing more;
 *  replacing codes asks for the passkey (the browser's dialog) in the same request, so this function does that
 *  step itself when agate asks for it. A new set replaces every earlier code. */
export async function passkeyMakeCodes(client: DynamicClient, server: string): Promise<string[]> {
  const token = sessionToken(client);
  if (!token) throw new AgatePasskeyError("rejected", "Sign in first.");
  try {
    return (await agatePost<{ codes: string[] }>(server, "/api/passkey/codes", {}, token)).codes;
  } catch (e) {
    if (!(e instanceof AgatePasskeyError && e.serverCode === "passkey_needed")) throw e;
  }
  needWebAuthn();
  const o = await agatePost<PasskeyCeremony>(server, "/api/passkey/stepup/options", { scope: "backup_codes" }, token);
  const response = await dialog(() => startAuthentication({ optionsJSON: o.options as never }));
  return (await agatePost<{ codes: string[] }>(server, "/api/passkey/codes", { ceremonyId: o.ceremonyId, response }, token)).codes;
}

/** How many of this account's backup codes are unused (0 when it never made any). */
export async function passkeyCodesLeft(server: string, token: string): Promise<number> {
  return (await agatePost<{ left: number }>(server, "/api/passkey/codes", undefined, token)).left;
}

/** "Lost your passkey? Use a backup code": the code makes a NEW passkey on the same account (the browser's dialog),
 *  then signs in with it like continueWithPasskey. The code is used up only when the new passkey checks out. */
export async function passkeyRecover(client: DynamicClient, server: string, code: string): Promise<PasskeyResult & { codesLeft: number }> {
  needWebAuthn();
  const o = await agatePost<PasskeyCeremony>(server, "/api/passkey/recover/options", { code });
  const response = await dialog(() => startRegistration({ optionsJSON: o.options as never }));
  const r = await finishPasskey(client, server, "/api/passkey/recover", o.ceremonyId, response, false);
  return { sub: r.sub, created: false, codesLeft: r.codesLeft ?? 0 };
}

// ------------------------------------------------------------------ session

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

/** "Confirm it's you" for a person already signed in (before the first delegation, and again after Revoke Assistant;
 *  a sign-in never carries the delegate scope): send a code to the person's email, then confirmStepUp with it. A
 *  person with a passkey must use confirmWithPasskey instead. */
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
