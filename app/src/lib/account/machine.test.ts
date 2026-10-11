// Every transition of the account's machines (wallet spec 3), plus the events each state ignores.
import { describe, expect, test } from "bun:test";
import { COPY, CONNECT_COPY, type FreshQuote, type Refusal } from "./errors";
import {
  ALLOW_DEFAULTS,
  APPROVAL_REPORT_GRACE_MS,
  type ApprovalState,
  type ApprovalView,
  approvalOpen,
  approvalOrder,
  approvalReducer,
  approvalStart,
  canReport,
  canResend,
  checkTerms,
  cleanCode,
  type ConnectRun,
  type ConnectState,
  CONNECT_STEPS,
  connectDismissable,
  connectFunded,
  connectMarks,
  connectReducer,
  connectStart,
  CREATING_SLOW_MS,
  defaultTerms,
  type DisconnectState,
  disconnectDismissable,
  disconnectReducer,
  disconnectStart,
  disconnectSteps,
  guardFromQuote,
  isCode,
  isEmail,
  LIMIT_IDLE,
  limitBusy,
  limitReducer,
  type LimitState,
  limitStepText,
  nextConnectStep,
  ordersAfter,
  restingKey,
  withoutResting,
  NOT_YET_PATIENCE_MS,
  placingMarks,
  placingSlow,
  PLACING_SLOW_MS,
  REFRESH_BEFORE_MS,
  refreshDue,
  REPLAN_AFTER_MS,
  RESEND_AFTER_MS,
  resendWait,
  SIGNED_OUT,
  type SignInState,
  creatingSlow,
  signInClosable,
  signInReducer,
  termsWire,
  toAccountStep,
  toU,
  type TradeAsk,
  tradeDismissable,
  tradeReducer,
  type TradeState,
  validUntilOf,
  writesAllowed,
} from "./machine";
import type { Position } from "@/lib/mock/types";
import type { AccountPlan, DoneResult, LimitDone, LimitOrder, LimitPlan, Order, RestingOrder } from "./types";

const T0 = 1_760_000_000_000;

// ===================================================================================================================
describe("sign-in", () => {
  const go = signInReducer;
  const choosing: SignInState = { status: "choosing", email: "a@b.co" };
  const sending: SignInState = { status: "sendingCode", email: "a@b.co", resend: false };
  const codeSent: SignInState = { status: "codeSent", email: "a@b.co", sentAt: T0, resent: false };
  const verifying: SignInState = { status: "verifying", email: "a@b.co", via: "code", sentAt: T0, resent: false };
  const viaGoogle: SignInState = { status: "verifying", email: "", via: "google" };
  const creatingWallet: SignInState = { status: "creating", email: "a@b.co", part: "wallet", startedAt: T0 };
  const creatingDollars: SignInState = { status: "creating", email: "a@b.co", part: "dollars", startedAt: T0 };
  const ready: SignInState = { status: "ready", email: "a@b.co" };
  const walletError: SignInState = { status: "error", at: "wallet", message: "x", email: "a@b.co" };
  const sendError: SignInState = { status: "error", at: "sendCode", message: "x", email: "a@b.co" };

  test("mount: a hint restores, no hint stays signed out, other states ignore it", () => {
    expect(go(SIGNED_OUT, { type: "mount", hint: true, at: T0 })).toEqual({ status: "restoring", since: T0 });
    expect(go(SIGNED_OUT, { type: "mount", hint: false, at: T0 })).toBe(SIGNED_OUT);
    expect(go(ready, { type: "mount", hint: true, at: T0 })).toBe(ready);
  });

  test("restoreSlow: a long restore shows signed out", () => {
    expect(go({ status: "restoring", since: T0 }, { type: "restoreSlow" })).toEqual({ status: "signedOut" });
    expect(go(ready, { type: "restoreSlow" })).toBe(ready);
  });

  test("restored: ready, creating or signed out; a late answer with a user still signs in", () => {
    const r: SignInState = { status: "restoring", since: T0 };
    expect(go(r, { type: "restored", user: true, wallet: true, email: "a@b.co", at: T0 })).toEqual({ status: "ready", email: "a@b.co" });
    expect(go(r, { type: "restored", user: true, wallet: false, email: "a@b.co", at: T0 + 5 })).toEqual({ status: "creating", email: "a@b.co", part: "wallet", startedAt: T0 + 5 });
    expect(go(r, { type: "restored", user: false, wallet: false, at: T0 })).toEqual({ status: "signedOut" });
    expect(go(SIGNED_OUT, { type: "restored", user: true, wallet: true, at: T0 })).toEqual({ status: "ready", email: undefined });
    expect(go(choosing, { type: "restored", user: true, wallet: true, at: T0 })).toEqual({ status: "ready", email: undefined });
    expect(go(SIGNED_OUT, { type: "restored", user: false, wallet: false, at: T0 })).toBe(SIGNED_OUT);
    expect(go(choosing, { type: "restored", user: false, wallet: false, at: T0 })).toBe(choosing);
    expect(go(ready, { type: "restored", user: true, wallet: true, at: T0 })).toBe(ready);
  });

  test("open: the email step, the email kept", () => {
    expect(go({ status: "signedOut", email: "a@b.co" }, { type: "open" })).toEqual({ status: "choosing", email: "a@b.co" });
    expect(go({ status: "sessionEnded", email: "a@b.co" }, { type: "open" })).toEqual({ status: "choosing", email: "a@b.co" });
    expect(go(ready, { type: "open" })).toBe(ready);
  });

  test("close: only from a step that holds nothing, the email kept", () => {
    for (const s of [choosing, sending, codeSent, sendError]) expect(go(s, { type: "close" })).toEqual({ status: "signedOut", email: "a@b.co" });
    for (const s of [verifying, viaGoogle, { status: "googleRedirect" } as SignInState, creatingWallet, walletError, ready, { status: "signingOut" } as SignInState]) expect(go(s, { type: "close" })).toBe(s);
  });

  test("start: a good email sends a code, a bad one stays with its line", () => {
    for (const s of [SIGNED_OUT, choosing, { status: "sessionEnded" } as SignInState, sendError]) {
      expect(go(s, { type: "start", email: "  me@x.io " })).toEqual({ status: "sendingCode", email: "me@x.io", resend: false });
    }
    expect(go(choosing, { type: "start", email: "nope" })).toEqual({ status: "choosing", email: "nope", problem: "badEmail" });
    for (const s of [codeSent, walletError, ready, creatingWallet]) expect(go(s, { type: "start", email: "me@x.io" })).toBe(s);
  });

  test("gettingReady: once, while sending", () => {
    const g = go(sending, { type: "gettingReady" });
    expect(g).toEqual({ ...sending, gettingReady: true });
    expect(go(g, { type: "gettingReady" })).toBe(g);
    expect(go(codeSent, { type: "gettingReady" })).toBe(codeSent);
  });

  test("codeSent: the code step, resent after a resend", () => {
    expect(go(sending, { type: "codeSent", at: T0 })).toEqual({ status: "codeSent", email: "a@b.co", sentAt: T0, resent: false });
    expect(go({ ...sending, resend: true } as SignInState, { type: "codeSent", at: T0 })).toEqual({ status: "codeSent", email: "a@b.co", sentAt: T0, resent: true });
    expect(go(choosing, { type: "codeSent", at: T0 })).toBe(choosing);
  });

  test("sendFailed: an error at that step", () => {
    expect(go(sending, { type: "sendFailed", at: "init", message: "m" })).toEqual({ status: "error", at: "init", message: "m", email: "a@b.co" });
    expect(go(sending, { type: "sendFailed", at: "sendCode", message: "m" })).toEqual({ status: "error", at: "sendCode", message: "m", email: "a@b.co" });
    expect(go(codeSent, { type: "sendFailed", at: "sendCode", message: "m" })).toBe(codeSent);
  });

  test("verify: six digits check the code, anything else is wrong at once", () => {
    expect(go(codeSent, { type: "verify", code: "123456" })).toEqual(verifying);
    expect(go(codeSent, { type: "verify", code: "123 456" })).toEqual(verifying);
    expect(go(codeSent, { type: "verify", code: "12345" })).toEqual({ ...codeSent, problem: "wrong" } as SignInState);
    expect(go(choosing, { type: "verify", code: "123456" })).toBe(choosing);
  });

  test("codeRejected: back to the code step with each problem", () => {
    for (const problem of ["wrong", "expired", "tooMany", "network"] as const) {
      expect(go(verifying, { type: "codeRejected", problem })).toEqual({ ...codeSent, problem } as SignInState);
    }
    expect(go(viaGoogle, { type: "codeRejected", problem: "wrong" })).toBe(viaGoogle);
  });

  test("verified: ready, or set up first; also from a session found while sending", () => {
    expect(go(verifying, { type: "verified", wallet: true, at: T0 })).toEqual(ready);
    expect(go(verifying, { type: "verified", wallet: false, at: T0 + 1 })).toEqual({ ...creatingWallet, startedAt: T0 + 1 } as SignInState);
    expect(go(sending, { type: "verified", wallet: true, at: T0 })).toEqual(ready);
    expect(go(viaGoogle, { type: "verified", wallet: true, email: "g@gmail.com", at: T0 })).toEqual({ status: "ready", email: "g@gmail.com" });
    expect(go(codeSent, { type: "verified", wallet: true, at: T0 })).toBe(codeSent);
  });

  test("resend: after 30 s, or at once for an expired or used-up code", () => {
    expect(go(codeSent, { type: "resend", at: T0 + RESEND_AFTER_MS - 1 })).toBe(codeSent);
    expect(go(codeSent, { type: "resend", at: T0 + RESEND_AFTER_MS })).toEqual({ status: "sendingCode", email: "a@b.co", resend: true });
    expect(go({ ...codeSent, problem: "expired" } as SignInState, { type: "resend", at: T0 })).toEqual({ status: "sendingCode", email: "a@b.co", resend: true });
    expect(go({ ...codeSent, problem: "tooMany" } as SignInState, { type: "resend", at: T0 })).toEqual({ status: "sendingCode", email: "a@b.co", resend: true });
    const wrong = { ...codeSent, problem: "wrong" } as SignInState;
    expect(go(wrong, { type: "resend", at: T0 })).toBe(wrong);
    expect(go(choosing, { type: "resend", at: T0 + RESEND_AFTER_MS })).toBe(choosing);
  });

  test("resendWait and canResend count down to the button", () => {
    expect(resendWait(codeSent, T0)).toBe(30);
    expect(resendWait(codeSent, T0 + 29_500)).toBe(1);
    expect(resendWait(codeSent, T0 + 30_000)).toBe(0);
    expect(resendWait(choosing, T0)).toBe(0);
    expect(canResend(codeSent, T0)).toBe(false);
    expect(canResend(choosing, T0 + RESEND_AFTER_MS)).toBe(false);
  });

  test("otherEmail: the email step, filled", () => {
    expect(go(codeSent, { type: "otherEmail" })).toEqual(choosing);
    expect(go(sendError, { type: "otherEmail" })).toEqual(choosing);
    expect(go(walletError, { type: "otherEmail" })).toBe(walletError);
  });

  test("google: leaves for Google, never from ready (that would link, not sign in)", () => {
    for (const s of [SIGNED_OUT, choosing, { status: "sessionEnded" } as SignInState, sendError]) expect(go(s, { type: "google" })).toEqual({ status: "googleRedirect" });
    for (const s of [ready, creatingWallet, codeSent]) expect(go(s, { type: "google" })).toBe(s);
  });

  test("googleReturned: Google's way back on load verifies", () => {
    for (const s of [SIGNED_OUT, { status: "restoring", since: T0 } as SignInState, choosing, { status: "googleRedirect" } as SignInState, { status: "sessionEnded" } as SignInState]) {
      expect(go(s, { type: "googleReturned" })).toEqual(viaGoogle);
    }
    expect(go(ready, { type: "googleReturned" })).toBe(ready);
  });

  test("googleFailed: an error at google", () => {
    expect(go({ status: "googleRedirect" }, { type: "googleFailed", message: "m" })).toEqual({ status: "error", at: "google", message: "m" });
    expect(go(viaGoogle, { type: "googleFailed", message: "m" })).toEqual({ status: "error", at: "google", message: "m" });
    expect(go(verifying, { type: "googleFailed", message: "m" })).toBe(verifying);
  });

  const viaPasskey: SignInState = { status: "verifying", email: "", via: "passkey" };
  test("passkey: the browser's dialog, only from where a sign-in may start", () => {
    for (const s of [SIGNED_OUT, choosing, { status: "sessionEnded" } as SignInState, sendError]) expect(go(s, { type: "passkey" })).toEqual(viaPasskey);
    for (const s of [ready, creatingWallet, codeSent, verifying]) expect(go(s, { type: "passkey" })).toBe(s);
  });

  test("passkey: signs in like a code, a new person is set up", () => {
    expect(go(viaPasskey, { type: "verified", wallet: true, email: "a@b.co", at: T0 })).toEqual({ status: "ready", email: "a@b.co" });
    expect(go(viaPasskey, { type: "verified", wallet: false, email: "a@b.co", at: T0 })).toEqual({ status: "creating", email: "a@b.co", part: "wallet", startedAt: T0 });
  });

  test("passkeyFailed: an error at passkey, back to choosing on retry; the sheet holds while the dialog is up", () => {
    expect(go(viaPasskey, { type: "passkeyFailed", message: "m" })).toEqual({ status: "error", at: "passkey", message: "m" });
    expect(go(verifying, { type: "passkeyFailed", message: "m" })).toBe(verifying);
    expect(go(viaGoogle, { type: "passkeyFailed", message: "m" })).toBe(viaGoogle);
    expect(go({ status: "error", at: "passkey", message: "m" }, { type: "retry", at: T0 })).toEqual({ status: "choosing", email: undefined });
    expect(go(viaPasskey, { type: "close" })).toBe(viaPasskey);
    expect(go(viaPasskey, { type: "codeRejected", problem: "wrong" })).toBe(viaPasskey);
    expect(toAccountStep(viaPasskey)).toEqual({ status: "verifying", email: "", via: "passkey" });
  });

  test("creating: the wallet, then the first test dollars", () => {
    expect(go(creatingWallet, { type: "walletMade", at: T0 + 9_800 })).toEqual({ ...creatingDollars, startedAt: T0 + 9_800 } as SignInState);
    expect(go(creatingDollars, { type: "walletMade", at: T0 })).toBe(creatingDollars);
    expect(go(creatingWallet, { type: "walletFailed", message: "m" })).toEqual({ status: "error", at: "wallet", message: "m", email: "a@b.co" });
    expect(go(creatingDollars, { type: "walletFailed", message: "m" })).toBe(creatingDollars);
    expect(go(creatingDollars, { type: "dripped" })).toEqual(ready);
    expect(go(creatingDollars, { type: "dripFailed" })).toEqual({ status: "ready", email: "a@b.co", firstDripFailed: true });
    expect(go(creatingWallet, { type: "dripped" })).toBe(creatingWallet);
    expect(go(creatingWallet, { type: "dripFailed" })).toBe(creatingWallet);
  });

  test("dripped clears a failed first drip, once", () => {
    expect(go({ status: "ready", email: "a@b.co", firstDripFailed: true }, { type: "dripped" })).toEqual(ready);
    expect(go(ready, { type: "dripped" })).toBe(ready);
  });

  test("retry reruns the step that failed", () => {
    expect(go(walletError, { type: "retry", at: T0 + 7 })).toEqual({ ...creatingWallet, startedAt: T0 + 7 } as SignInState);
    expect(go({ status: "error", at: "init", message: "m", email: "a@b.co" }, { type: "retry", at: T0 })).toEqual(sending);
    expect(go(sendError, { type: "retry", at: T0 })).toEqual(sending);
    expect(go({ status: "error", at: "sendCode", message: "m" }, { type: "retry", at: T0 })).toEqual({ status: "choosing", email: undefined });
    expect(go({ status: "error", at: "google", message: "m" }, { type: "retry", at: T0 })).toEqual({ status: "choosing", email: undefined });
    expect(go({ status: "error", at: "verify", message: "m", email: "a@b.co" }, { type: "retry", at: T0 })).toEqual(choosing);
    expect(go({ status: "error", at: "wallet", message: "m" }, { type: "retry", at: T0 })).toEqual({ status: "creating", email: "", part: "wallet", startedAt: T0 });
    expect(go(ready, { type: "retry", at: T0 })).toBe(ready);
  });

  test("signOut, then signedOut (even when logout threw)", () => {
    expect(go(ready, { type: "signOut" })).toEqual({ status: "signingOut" });
    expect(go(walletError, { type: "signOut" })).toEqual({ status: "signingOut" });
    expect(go(codeSent, { type: "signOut" })).toBe(codeSent);
    expect(go({ status: "signingOut" }, { type: "signedOut" })).toEqual({ status: "signedOut" });
    expect(go(ready, { type: "signedOut" })).toBe(ready);
  });

  test("loggedOut: our own sign-out finishes, anything else is a session that ended", () => {
    expect(go({ status: "signingOut" }, { type: "loggedOut", reason: "user-intent" })).toEqual({ status: "signedOut" });
    expect(go({ status: "restoring", since: T0 }, { type: "loggedOut" })).toEqual({ status: "signedOut" });
    expect(go(ready, { type: "loggedOut", reason: "token-expired" })).toEqual({ status: "sessionEnded", email: "a@b.co" });
    expect(go(creatingDollars, { type: "loggedOut" })).toEqual({ status: "sessionEnded", email: "a@b.co" });
    expect(go(walletError, { type: "loggedOut" })).toEqual({ status: "sessionEnded", email: "a@b.co" });
    for (const s of [SIGNED_OUT, choosing, codeSent, verifying]) expect(go(s, { type: "loggedOut" })).toBe(s);
  });

  test("helpers: closable, slow, writes, refresh, email and code checks", () => {
    expect([choosing, sending, codeSent, sendError, verifying, creatingWallet, walletError, ready].map(signInClosable)).toEqual([true, true, true, true, false, false, false, false]);
    expect(creatingSlow(creatingWallet, T0 + CREATING_SLOW_MS.wallet)).toBe(false);
    expect(creatingSlow(creatingWallet, T0 + CREATING_SLOW_MS.wallet + 1)).toBe(true);
    expect(creatingSlow(creatingDollars, T0 + 12_001)).toBe(true);
    expect(creatingSlow(ready, T0 + 99_999)).toBe(false);
    expect(writesAllowed(ready)).toBe(true);
    expect(writesAllowed(creatingDollars)).toBe(false);
    const ends = T0 + 2 * 3_600_000;
    expect(refreshDue(ends, ends - REFRESH_BEFORE_MS - 1)).toBe(false);
    expect(refreshDue(ends, ends - REFRESH_BEFORE_MS)).toBe(true);
    expect(refreshDue(null, T0)).toBe(false);
    expect(isEmail("x@y.z")).toBe(true);
    expect(isEmail("x@y")).toBe(false);
    expect(isEmail("x y@z.io")).toBe(false);
    expect(cleanCode("12 34-56")).toBe("123456");
    expect(isCode("123456")).toBe(true);
    expect(isCode("12345a")).toBe(false);
  });

  test("toAccountStep: the Account's step for every state", () => {
    expect(toAccountStep(SIGNED_OUT)).toEqual({ status: "signedOut", email: undefined });
    expect(toAccountStep(choosing)).toEqual({ status: "signedOut", email: "a@b.co" });
    expect(toAccountStep({ status: "sessionEnded", email: "a@b.co" })).toEqual({ status: "signedOut", email: "a@b.co" });
    expect(toAccountStep({ status: "restoring", since: T0 })).toEqual({ status: "restoring" });
    expect(toAccountStep({ ...sending, gettingReady: true } as SignInState)).toEqual({ status: "sendingCode", email: "a@b.co", resend: false });
    expect(toAccountStep({ ...codeSent, problem: "expired" } as SignInState)).toEqual({ status: "codeSent", email: "a@b.co", sentAt: T0, resent: false, problem: "expired" });
    expect(toAccountStep(verifying)).toEqual({ status: "verifying", email: "a@b.co", via: "code" });
    expect(toAccountStep({ status: "googleRedirect" })).toEqual({ status: "verifying", email: "", via: "google" });
    expect(toAccountStep(creatingDollars)).toEqual({ status: "creating", email: "a@b.co", part: "dollars", startedAt: T0 });
    expect(toAccountStep({ status: "ready", email: "a@b.co", firstDripFailed: true })).toEqual({ status: "ready", firstDripFailed: true });
    expect(toAccountStep({ status: "signingOut" })).toEqual({ status: "signingOut" });
    expect(toAccountStep(walletError)).toEqual({ status: "error", at: "wallet", message: "x", email: "a@b.co" });
  });
});

// ===================================================================================================================
describe("trade", () => {
  type S = TradeState<string>;
  const go = (s: S, e: Parameters<typeof tradeReducer<string>>[1]) => tradeReducer<string>(s, e);
  const buy: Order = { kind: "buyLong", gpu: "H100", month: "2026-11", dollars: "1000.00", minGpuHours: "245.0980", maxPrice: "4.10", slippageBps: 0 };
  const ask: TradeAsk<string> = { n: "ticket", order: buy, need: 1000 };
  const plan: AccountPlan = { account: "0xA", calls: [], summary: { action: "openLong", gpu: "H100", month: "2026-11", maxSpend: 1000, bound: { kind: "minTokensOut", value: 245.098 } }, plannedAt: T0 };
  const quote: FreshQuote = { gpuHours: 240.12345, dollars: 980.005, avgPrice: 4.0812 };
  const result: DoneResult = { action: "openLong", txHash: "0xT", userOpHash: "0xU", gpuHours: 245.098, spent: 1000, refund: 0, avg: 4.08 };
  const idle: S = { step: "idle" };
  const signin: S = { step: "signin", ask };
  const funds: S = { step: "funds", ask };
  const dripping: S = { step: "dripping", ask };
  const planning: S = { step: "planning", ask, andSend: false, replanned: false };
  const placingPlan: S = { step: "planning", ask, andSend: true, replanned: false };
  const review: S = { step: "review", ask, plan };
  const signing: S = { step: "signing", ask, plan, replanned: false, resent: false };
  const sending: S = { step: "sending", ask, plan, userOpHash: "0xU", sentAt: T0, replanned: false };
  const pending: S = { step: "pending", ask, plan, userOpHash: "0xU" };
  const moved: S = { step: "moved", ask, quote };
  const thin: S = { step: "thin", ask, quote };
  const failed: S = { step: "failed", ask, message: "m", action: "retry" };
  const done: S = { step: "done", ask, result };
  const all: S[] = [idle, signin, funds, dripping, planning, placingPlan, review, signing, sending, pending, moved, thin, failed, done];
  const refusal = (r: Partial<Refusal>): Refusal => ({ sheet: "failed", message: "m", action: "retry", nothingSent: true, reason: "x", ...r });
  const others = (keep: S[]) => all.filter((s) => !keep.includes(s));

  test("submit: sign in first, then test dollars, then planning", () => {
    expect(go(idle, { type: "submit", ask, ready: false, balance: 0 })).toEqual(signin);
    expect(go(idle, { type: "submit", ask, ready: true, balance: 999.99 })).toEqual(funds);
    expect(go(idle, { type: "submit", ask, ready: true, balance: 1000 })).toEqual(planning);
    for (const s of others([idle])) expect(go(s, { type: "submit", ask, ready: true, balance: 5000 })).toBe(s);
  });

  test("signedIn: the kept trade moves on", () => {
    expect(go(signin, { type: "signedIn", balance: 10_000 })).toEqual(planning);
    expect(go(signin, { type: "signedIn", balance: 10 })).toEqual(funds);
    for (const s of others([signin])) expect(go(s, { type: "signedIn", balance: 10_000 })).toBe(s);
  });

  test("planned: Review, or straight to signing after Confirm", () => {
    expect(go(planning, { type: "planned", plan })).toEqual(review);
    expect(go(placingPlan, { type: "planned", plan })).toEqual(signing);
    expect(go({ ...placingPlan, replanned: true } as S, { type: "planned", plan })).toEqual({ ...signing, replanned: true } as S);
    for (const s of others([planning, placingPlan])) expect(go(s, { type: "planned", plan })).toBe(s);
  });

  test("refused while planning: every sheet", () => {
    const at = (r: Partial<Refusal>) => go(planning, { type: "refused", refusal: refusal(r) });
    expect(at({ sheet: "ticket", message: "Enter an amount above 0." })).toEqual({ step: "idle", inline: "Enter an amount above 0." });
    expect(at({ sheet: "funds" })).toEqual(funds);
    expect(at({ sheet: "drip", message: "next" })).toEqual({ step: "funds", ask, message: "next" });
    expect(at({ sheet: "thin", quote })).toEqual(thin);
    expect(at({ sheet: "thin" })).toEqual({ step: "failed", ask, message: "m", action: "retry" });
    expect(at({ sheet: "moved", quote })).toEqual(moved);
    expect(at({ sheet: "moved" })).toEqual({ step: "failed", ask, message: "m", action: "retry" });
    expect(at({ sheet: "signin", message: "s" })).toEqual({ step: "signin", ask, message: "s" });
    for (const action of ["retry", "back", "funds", "recheck"] as const) expect(at({ action })).toEqual({ step: "failed", ask, message: "m", action });
    expect(at({ action: "signin" })).toEqual({ step: "failed", ask, message: "m", action: "back" });
    expect(at({ action: "none" })).toEqual({ step: "failed", ask, message: "m", action: "back" });
    for (const sheet of ["review", "replan", "resend", "pending"] as const) expect(at({ sheet })).toEqual({ step: "failed", ask, message: "m", action: "retry" });
    expect(go(placingPlan, { type: "refused", refusal: refusal({ sheet: "moved", quote }) })).toEqual(moved);
    for (const s of others([planning, placingPlan])) expect(go(s, { type: "refused", refusal: refusal({}) })).toBe(s);
  });

  test("confirm: signs a fresh plan, plans a stale one again first", () => {
    expect(go(review, { type: "confirm", at: T0 + REPLAN_AFTER_MS })).toEqual(signing);
    expect(go(review, { type: "confirm", at: T0 + REPLAN_AFTER_MS + 1 })).toEqual(placingPlan);
    for (const s of others([review])) expect(go(s, { type: "confirm", at: T0 })).toBe(s);
  });

  test("back: the ticket, kept; never while placing", () => {
    for (const s of [review, moved, thin, funds, failed, signin, planning]) expect(go(s, { type: "back" })).toEqual(idle);
    for (const s of [idle, dripping, placingPlan, signing, sending, pending, done]) expect(go(s, { type: "back" })).toBe(s);
  });

  test("close: any sheet but Placing", () => {
    for (const s of [signin, funds, dripping, planning, review, pending, moved, thin, failed, done]) expect(go(s, { type: "close" })).toEqual(idle);
    for (const s of [idle, placingPlan, signing, sending]) expect(go(s, { type: "close" })).toBe(s);
    expect(all.map(tradeDismissable)).toEqual(all.map((s) => s !== placingPlan && s !== signing && s !== sending));
  });

  test("signed: the hash arrived, waiting for Monad", () => {
    expect(go(signing, { type: "signed", userOpHash: "0xU", at: T0 })).toEqual(sending);
    for (const s of others([signing])) expect(go(s, { type: "signed", userOpHash: "0xU", at: T0 })).toBe(s);
  });

  test("sendFailed: every sheet a send can go to", () => {
    const at = (s: S, r: Partial<Refusal>) => go(s, { type: "sendFailed", refusal: refusal(r) });
    expect(at(signing, { sheet: "review", message: COPY.cantSign })).toEqual({ step: "review", ask, plan, message: COPY.cantSign });
    expect(at(signing, { sheet: "signin", message: COPY.sessionTrade })).toEqual({ step: "signin", ask, message: COPY.sessionTrade });
    expect(at(signing, { sheet: "replan" })).toEqual({ step: "planning", ask, andSend: true, replanned: true });
    expect(at({ ...signing, replanned: true } as S, { sheet: "replan" })).toEqual({ step: "failed", ask, message: COPY.turnedDown, action: "back" });
    expect(at(sending, { sheet: "replan" })).toEqual({ step: "planning", ask, andSend: true, replanned: true });
    expect(at(signing, { sheet: "resend" })).toEqual({ ...signing, resent: true } as S);
    expect(at({ ...signing, resent: true } as S, { sheet: "resend" })).toEqual({ step: "failed", ask, message: COPY.sendGeneric, action: "retry" });
    expect(at(sending, { sheet: "resend" })).toEqual({ step: "failed", ask, message: COPY.sendGeneric, action: "retry" });
    expect(at(sending, { sheet: "pending" })).toEqual(pending);
    expect(at(signing, { sheet: "pending" })).toEqual({ step: "failed", ask, message: COPY.sendGeneric, action: "retry" });
    expect(at(signing, { sheet: "funds" })).toEqual(funds);
    expect(at(signing, { sheet: "failed", message: COPY.fee, action: "retry" })).toEqual({ step: "failed", ask, message: COPY.fee, action: "retry" });
    expect(at(sending, { sheet: "ticket", message: "t", action: "back" })).toEqual({ step: "failed", ask, message: "t", action: "back" });
    for (const s of others([signing, sending])) expect(at(s, { sheet: "failed" })).toBe(s);
  });

  test("landed, reverted, timedOut", () => {
    expect(go(sending, { type: "landed", result })).toEqual(done);
    expect(go(pending, { type: "landed", result })).toEqual(done);
    expect(go(sending, { type: "reverted" })).toEqual({ step: "failed", ask, message: COPY.landedMoved, action: "recheck" });
    expect(go(pending, { type: "reverted" })).toEqual({ step: "failed", ask, message: COPY.landedMoved, action: "recheck" });
    expect(go(sending, { type: "timedOut" })).toEqual(pending);
    for (const s of others([sending, pending])) {
      expect(go(s, { type: "landed", result })).toBe(s);
      expect(go(s, { type: "reverted" })).toBe(s);
    }
    for (const s of others([sending])) expect(go(s, { type: "timedOut" })).toBe(s);
  });

  test("newPrice: plans again with the quote as the guard", () => {
    expect(go(moved, { type: "newPrice" })).toEqual({ step: "planning", ask: { ...ask, order: { kind: "buyLong", gpu: "H100", month: "2026-11", dollars: "1000.00", minGpuHours: "240.1234", slippageBps: 0 }, need: 1000 }, andSend: false, replanned: false });
    for (const s of others([moved])) expect(go(s, { type: "newPrice" })).toBe(s);
  });

  test("buyInstead: buys what the book holds", () => {
    const next = go(thin, { type: "buyInstead" });
    expect(next).toEqual({ step: "planning", ask: { ...ask, order: { kind: "buyLong", gpu: "H100", month: "2026-11", dollars: "980.00", minGpuHours: "240.1234", slippageBps: 0 }, need: 980 }, andSend: false, replanned: false });
    for (const s of others([thin])) expect(go(s, { type: "buyInstead" })).toBe(s);
  });

  test("retry: Failed's one action", () => {
    expect(go(failed, { type: "retry" })).toEqual(planning);
    expect(go({ ...failed, action: "recheck" } as S, { type: "retry" })).toEqual(planning);
    expect(go({ ...failed, action: "funds" } as S, { type: "retry" })).toEqual(funds);
    expect(go({ ...failed, action: "back" } as S, { type: "retry" })).toEqual(idle);
    for (const s of others([failed])) expect(go(s, { type: "retry" })).toBe(s);
  });

  test("test dollars: drip, then planning when it covers the trade", () => {
    expect(go(funds, { type: "drip" })).toEqual(dripping);
    for (const s of others([funds])) expect(go(s, { type: "drip" })).toBe(s);
    expect(go(dripping, { type: "dripLanded", balance: 10_000 })).toEqual(planning);
    expect(go(dripping, { type: "dripLanded", balance: 999 })).toEqual(funds);
    expect(go(dripping, { type: "dripFailed", message: COPY.dripFee })).toEqual({ step: "funds", ask, message: COPY.dripFee });
    for (const s of others([dripping])) {
      expect(go(s, { type: "dripLanded", balance: 10_000 })).toBe(s);
      expect(go(s, { type: "dripFailed", message: "m" })).toBe(s);
    }
  });

  test("sessionEnded: a waiting trade moves to sign-in and keeps its order", () => {
    for (const s of [review, funds, moved, thin, failed, planning]) expect(go(s, { type: "sessionEnded" })).toEqual({ step: "signin", ask, message: COPY.sessionTrade });
    for (const s of [idle, signin, dripping, placingPlan, signing, sending, pending, done]) expect(go(s, { type: "sessionEnded" })).toBe(s);
  });

  test("guardFromQuote: every order kind", () => {
    const q: FreshQuote = { gpuHours: 24.509999999999, dollars: 100.4567, avgPrice: 4.1 }; // float noise past 8 decimals reads as 24.51
    expect(guardFromQuote(buy, q)).toEqual({ kind: "buyLong", gpu: "H100", month: "2026-11", dollars: "1000.00", minGpuHours: "24.5100", slippageBps: 0 });
    expect(guardFromQuote({ kind: "openLongDaily", gpu: "H100", month: "2026-11", dollars: "500.00", parts: 1, maxPrice: "4" }, q, "thin")).toEqual({ kind: "openLongDaily", gpu: "H100", month: "2026-11", dollars: "100.45", parts: 1, minGpuHours: "24.5100" });
    expect(guardFromQuote({ kind: "openShort", gpu: "B200", month: "2026-11", gpuHours: "10.0000", parts: 1, daily: true, minPrice: "8", minDollars: "90.00" }, q)).toEqual({ kind: "openShort", gpu: "B200", month: "2026-11", gpuHours: "10.0000", parts: 1, daily: true, minDollars: "100.45" });
    expect(guardFromQuote({ kind: "sellLong", gpu: "H100", month: "2026-11", gpuHours: "5.0000" }, q)).toEqual({ kind: "sellLong", gpu: "H100", month: "2026-11", gpuHours: "5.0000", minDollars: "100.45" });
    expect(guardFromQuote({ kind: "closeLongDaily", gpu: "H100", month: "2026-11", positionIds: ["7"] }, q)).toEqual({ kind: "closeLongDaily", gpu: "H100", month: "2026-11", positionIds: ["7"], minDollars: "100.45" });
    expect(guardFromQuote({ kind: "closeShort", gpu: "H100", month: "2026-11", positionIds: ["8"] }, q)).toEqual({ kind: "closeShort", gpu: "H100", month: "2026-11", positionIds: ["8"], maxDollars: "100.46" });
    const drip: Order = { kind: "drip" };
    expect(guardFromQuote(drip, q)).toBe(drip);
  });

  test("a buy-back's need follows its new most; a Short keeps its own", () => {
    const back: TradeAsk<string> = { n: "close", order: { kind: "closeShort", gpu: "H100", month: "2026-11", positionIds: ["8"], maxDollars: "50.00" }, need: 50 };
    const r = go({ step: "moved", ask: back, quote: { gpuHours: 10, dollars: 61.231, avgPrice: 6.12 } }, { type: "newPrice" });
    expect(r.step === "planning" && r.ask.need).toBe(61.24);
    const short: TradeAsk<string> = { n: "short", order: { kind: "openShort", gpu: "H100", month: "2026-11", gpuHours: "10.0000", parts: 1, daily: true }, need: 80 };
    const r2 = go({ step: "moved", ask: short, quote: { gpuHours: 10, dollars: 40, avgPrice: 4 } }, { type: "newPrice" });
    expect(r2.step === "planning" && r2.ask.need).toBe(80);
  });

  test("Placing's steps and its slow line", () => {
    expect(placingMarks(placingPlan)).toEqual(["current", "waiting", "waiting"]);
    expect(placingMarks(signing)).toEqual(["done", "current", "waiting"]);
    expect(placingMarks(sending)).toEqual(["done", "done", "current"]);
    expect(placingMarks(pending)).toEqual(["done", "done", "current"]);
    expect(placingMarks(review)).toBeNull();
    expect(placingMarks(planning)).toBeNull();
    expect(placingSlow(sending, T0 + PLACING_SLOW_MS)).toBe(false);
    expect(placingSlow(sending, T0 + PLACING_SLOW_MS + 1)).toBe(true);
    expect(placingSlow(signing, T0 + 99_999)).toBe(false);
  });
});

// ===================================================================================================================
describe("limit orders", () => {
  const go = limitReducer;
  const bid: LimitOrder = { kind: "placeLimit", gpu: "H100", month: "2026-11", side: "long", price: "3.90", gpuHours: "10.0000" };
  const cancel: LimitOrder = { kind: "cancelLimit", gpu: "H100", month: "2026-11", orderIds: ["41"] };
  const plan: LimitPlan = { account: "0xA", calls: [], summary: { action: "placeLimit", gpu: "H100", month: "2026-11", side: "long", price: 3.9, gpuHours: 10, deposited: 39, minted: 0 }, plannedAt: T0 };
  const result: LimitDone = { action: "placeLimit", txHash: "0xT", userOpHash: "0xU", orderId: "42" };
  const checking: LimitState = { step: "checking", order: bid };
  const signing: LimitState = { step: "signing", order: bid, plan };
  const sending: LimitState = { step: "sending", order: bid, plan, userOpHash: "0xU" };
  const done: LimitState = { step: "done", order: bid, result };
  const failed: LimitState = { step: "failed", order: bid, message: "m", sent: false };
  const all: LimitState[] = [LIMIT_IDLE, checking, signing, sending, done, failed];
  const others = (keep: LimitState[]) => all.filter((s) => !keep.includes(s));

  test("a placed order: checked, signed, sent, landed", () => {
    expect(go(LIMIT_IDLE, { type: "start", order: bid })).toEqual(checking);
    expect(go(checking, { type: "planned", plan })).toEqual(signing);
    expect(go(signing, { type: "step", step: "signing" })).toBe(signing);
    expect(go(signing, { type: "step", step: "sending", userOpHash: "0xU" })).toEqual(sending);
    expect(go(sending, { type: "landed", result })).toEqual(done);
    expect(go(signing, { type: "landed", result })).toEqual(done);
  });

  test("one run at a time: a start while one is on its way does nothing; a finished one starts again", () => {
    for (const s of [checking, signing, sending]) expect(go(s, { type: "start", order: cancel })).toBe(s);
    expect(go(done, { type: "start", order: cancel })).toEqual({ step: "checking", order: cancel });
    expect(go(failed, { type: "start", order: cancel })).toEqual({ step: "checking", order: cancel });
  });

  test("refused while checking: failed, nothing sent; a send that failed says whether it went out", () => {
    expect(go(checking, { type: "refused", message: COPY.postOnly })).toEqual({ step: "failed", order: bid, message: COPY.postOnly, sent: false });
    expect(go(signing, { type: "sendFailed", message: COPY.cantSign, nothingSent: true })).toEqual({ step: "failed", order: bid, message: COPY.cantSign, sent: false });
    expect(go(sending, { type: "sendFailed", message: COPY.pending, nothingSent: false })).toEqual({ step: "failed", order: bid, message: COPY.pending, sent: true });
  });

  test("a late answer from an earlier step changes nothing", () => {
    for (const s of others([checking])) {
      expect(go(s, { type: "planned", plan })).toBe(s);
      expect(go(s, { type: "refused", message: "m" })).toBe(s);
    }
    for (const s of others([signing, sending])) {
      expect(go(s, { type: "landed", result })).toBe(s);
      expect(go(s, { type: "sendFailed", message: "m", nothingSent: true })).toBe(s);
      expect(go(s, { type: "step", step: "sending" })).toBe(s);
    }
  });

  test("busy and the button's words", () => {
    expect(all.map(limitBusy)).toEqual([false, true, true, true, false, false]);
    expect(limitStepText(checking)).toBe("Checking the book");
    expect(limitStepText({ step: "checking", order: cancel })).toBe("Checking the order");
    expect(limitStepText(signing)).toBe("Your wallet is signing");
    expect(limitStepText(sending)).toBe("Sending to Monad");
    for (const s of [LIMIT_IDLE, done, failed]) expect(limitStepText(s)).toBeNull();
  });

  test("ordersAfter: a placed order first, a canceled one gone, before the next read", () => {
    const old: RestingOrder = { id: "H100-2026-11-7", orderId: "7", gpu: "H100", month: "2026-11", side: "short", price: 4.1, q: 10, placedAt: "2026-11-02T01:00:00Z", filled: 0 };
    const placed = ordersAfter([old], plan, result, T0);
    expect(placed).toEqual([{ id: "H100-2026-11-42", orderId: "42", gpu: "H100", month: "2026-11", side: "long", price: 3.9, q: 10, placedAt: new Date(T0).toISOString(), filled: 0 }, old]);
    // already read, or no id in the receipt: the list as it is
    expect(ordersAfter(placed, plan, result, T0)).toBe(placed);
    const noId = ordersAfter([old], plan, { ...result, orderId: "" }, T0);
    expect(noId).toEqual([old]);
    const cancelPlan: LimitPlan = { account: "0xA", calls: [], summary: { action: "cancelLimit", gpu: "H100", month: "2026-11", cancelled: ["7"], skipped: [], withdrawn: { dollars: 0, gpuHours: 10 } }, plannedAt: T0 };
    expect(ordersAfter(placed, cancelPlan, { action: "cancelLimit", txHash: "0xT", userOpHash: null, cancelled: ["7"] }, T0)).toEqual([placed[0]]);
    // the receipt's ids win; without them, the plan's
    expect(ordersAfter(placed, cancelPlan, { action: "cancelLimit", txHash: "0xT", userOpHash: null }, T0)).toEqual([placed[0]]);
    const withdrawPlan: LimitPlan = { account: "0xA", calls: [], summary: { action: "withdrawMargin", withdrawn: { dollars: 41, gpuHours: 0 } }, plannedAt: T0 };
    expect(ordersAfter(placed, withdrawPlan, { action: "withdrawMargin", txHash: "0xT", userOpHash: null }, T0)).toBe(placed);
  });

  test("withoutResting: a resting Short's unsold half is no position yet; only what sold is a Short", () => {
    const short = { id: "s", gpu: "H100", month: "2026-11", side: "short", q: 10, entry: 0, kind: "shortBalance" } as unknown as Position;
    const long = { id: "l", gpu: "H100", month: "2026-11", side: "long", q: 5, entry: 3.9, kind: "tokens" } as unknown as Position;
    const ask: RestingOrder = { id: restingKey("H100", "2026-11", "9"), orderId: "9", gpu: "H100", month: "2026-11", side: "short", price: 4.1, q: 10, placedAt: "", filled: 0 };
    // all of it still rests: flat, so no Short shows; the Long beside it is untouched
    expect(withoutResting([short, long], [ask])).toEqual([long]);
    // 4 of 10 sold: a Short of 4
    expect(withoutResting([short], [{ ...ask, q: 6, filled: 4 }]).map((p) => p.q)).toEqual([4]);
    // no resting asks, or another month's: as read
    const list = [short];
    expect(withoutResting(list, [])).toBe(list);
    expect(withoutResting(list, [{ ...ask, month: "2026-12" }])).toEqual(list);
  });

  test("ordersAfter: Kuru counts ids per book, so the same id in another market is another order", () => {
    const h100: RestingOrder = { id: restingKey("H100", "2026-11", "7"), orderId: "7", gpu: "H100", month: "2026-11", side: "long", price: 3.9, q: 10, placedAt: "", filled: 0 };
    const h200: RestingOrder = { ...h100, id: restingKey("H200", "2026-11", "7"), gpu: "H200", price: 5.1 };
    const cancelH200: LimitPlan = { account: "0xA", calls: [], summary: { action: "cancelLimit", gpu: "H200", month: "2026-11", cancelled: ["7"] }, plannedAt: T0 };
    expect(ordersAfter([h100, h200], cancelH200, { action: "cancelLimit", txHash: "0xT", userOpHash: null, cancelled: ["7"] }, T0)).toEqual([h100]);
    // a new H200 order with the id an H100 order already has still goes in
    const placeH200: LimitPlan = { ...plan, summary: { ...plan.summary, gpu: "H200" } };
    expect(ordersAfter([h100], placeH200, { ...result, orderId: "7" }, T0).map((o) => o.id)).toEqual([restingKey("H200", "2026-11", "7"), h100.id]);
  });
});

// ===================================================================================================================
describe("connect an AI", () => {
  const go = connectReducer;
  const terms = defaultTerms("Claude");
  const form = connectStart("oauth", "Claude");
  const inapp = connectStart("inapp", "Claude");
  const confirming: ConnectState = { step: "confirming", lane: "oauth", terms, withDrip: false };
  const checked = (over: Partial<{ delegated: boolean; hasAssistant: boolean; canDelegate: boolean }> = {}) => ({ type: "checked" as const, delegated: false, hasAssistant: false, canDelegate: true, pocketIndex: 2, routers: ["0xR"], at: T0, ...over });
  const run0: ConnectRun = { steps: [...CONNECT_STEPS], skipped: [], done: [], pocketIndex: 2, routers: ["0xR"], withDrip: false };
  const at = (step: ConnectState, ...events: Parameters<typeof connectReducer>[1][]) => events.reduce(go, step);
  const running = (a: ConnectStep, run: ConnectRun = run0): Extract<ConnectState, { step: "running" }> => ({ step: "running", lane: "oauth", terms, run, at: a, startedAt: T0 });
  type ConnectStep = (typeof CONNECT_STEPS)[number];

  test("the form: the defaults, edits, Allow only when the checks pass", () => {
    expect(form).toEqual({ step: "form", lane: "oauth", terms: { label: "Claude", budget: 1000, perTradeCap: 250, tradesPerDay: 5, days: 7 } });
    expect(ALLOW_DEFAULTS).toEqual({ budget: 1000, perTradeCap: 250, tradesPerDay: 5, days: 7 });
    const edited = go({ ...form, banner: "x" } as ConnectState, { type: "edit", patch: { budget: 2500 } });
    expect(edited).toEqual({ step: "form", lane: "oauth", terms: { ...terms, budget: 2500 } });
    expect(go(confirming, { type: "edit", patch: { budget: 1 } })).toBe(confirming);
    expect(go(form, { type: "allow", check: { ok: true, withDrip: true } })).toEqual({ step: "confirming", lane: "oauth", terms, withDrip: true });
    expect(go(form, { type: "allow", check: { ok: false, withDrip: false, budget: "over" } })).toBe(form);
    expect(go(confirming, { type: "allow", check: { ok: true, withDrip: false } })).toBe(confirming);
  });

  test("offline before anything moved: back to the form with the line", () => {
    expect(go(confirming, { type: "offline" })).toEqual({ step: "form", lane: "oauth", terms, banner: CONNECT_COPY.offline });
    expect(go({ step: "denying", lane: "oauth", terms }, { type: "offline" })).toEqual({ step: "form", lane: "oauth", terms, banner: CONNECT_COPY.offline });
    expect(go(form, { type: "offline" })).toBe(form);
  });

  test("checked: the key's steps only for the first AI; step-up only when it must be delegated again", () => {
    expect(go(confirming, checked())).toEqual(running("assistant"));
    expect(go(confirming, checked({ hasAssistant: true }))).toEqual(running("delegate", { ...run0, skipped: ["assistant"] }));
    expect(go(confirming, checked({ delegated: true, hasAssistant: true, canDelegate: false }))).toEqual(running("permission", { ...run0, skipped: ["assistant", "delegate"] }));
    expect(go(confirming, checked({ hasAssistant: true, canDelegate: false }))).toEqual({ step: "stepUp", lane: "oauth", terms, run: { ...run0, skipped: ["assistant"] }, code: "sending" });
    const inappRun = go({ ...confirming, lane: "inapp" } as ConnectState, checked({ delegated: true }));
    expect(inappRun.step === "running" && inappRun.run.steps).toEqual(["assistant", "delegate", "permission", "funding", "registering"]);
    expect(go(form, checked())).toBe(form);
  });

  test("step-up: a fresh code, then on to the key", () => {
    const up = go(confirming, checked({ canDelegate: false }));
    const sent = go(up, { type: "codeSent", at: T0 });
    expect(sent).toMatchObject({ step: "stepUp", code: "sent", sentAt: T0 });
    expect(go(sent, { type: "verify", code: "12" })).toMatchObject({ code: "sent", problem: "wrong" });
    const checking = go(sent, { type: "verify", code: "654321" });
    expect(checking).toMatchObject({ code: "verifying", problem: undefined });
    expect(go(checking, { type: "codeRejected", problem: "expired" })).toMatchObject({ code: "sent", problem: "expired" });
    expect(go(sent, { type: "codeRejected", problem: "expired" })).toBe(sent);
    expect(go(checking, { type: "codeOk", at: T0 + 1 })).toEqual({ ...running("assistant"), startedAt: T0 + 1 });
    expect(go(sent, { type: "codeOk", at: T0 })).toBe(sent);
    expect(go(sent, { type: "resend" })).toMatchObject({ code: "sending", problem: undefined });
    expect(go(up, { type: "resend" })).toBe(up);
    expect(go(up, { type: "codeSent", at: T0 }).step).toBe("stepUp");
    expect(go(sent, { type: "codeSent", at: T0 })).toBe(sent);
    expect(go(checking, { type: "verify", code: "654321" })).toBe(checking);
    expect(go(sent, { type: "cancel" })).toEqual({ step: "form", lane: "oauth", terms, banner: CONNECT_COPY.stepUpCancelled });
    expect(go(form, { type: "cancel" })).toBe(form);
    expect(go(running("delegate"), { type: "needStepUp" })).toEqual({ step: "stepUp", lane: "oauth", terms, run: run0, code: "sending" });
    expect(go(running("permission"), { type: "needStepUp" })).toEqual(running("permission"));
  });

  test("step-up with a passkey: no code, one tap, then on to the key", () => {
    const up = go(confirming, checked({ canDelegate: false }));
    const ask = go(up, { type: "passkeyAsk" });
    expect(ask).toMatchObject({ step: "stepUp", code: "sent", via: "passkey", problem: undefined });
    expect(go(ask, { type: "passkeyAsk" })).toBe(ask);
    const checking = go(ask, { type: "verify", code: "" });
    expect(checking).toMatchObject({ code: "verifying", via: "passkey" });
    expect(go(checking, { type: "passkeyRejected", message: "m" })).toMatchObject({ code: "sent", via: "passkey", passkeyMessage: "m" });
    expect(go(checking, { type: "codeRejected", problem: "wrong" })).toBe(checking);
    expect(go(go(go(checking, { type: "passkeyRejected", message: "m" }), { type: "verify", code: "" }), { type: "codeOk", at: T0 }).step).toBe("running");
    expect(go(checking, { type: "codeOk", at: T0 + 1 })).toEqual({ ...running("assistant"), startedAt: T0 + 1 });
    expect(go(ask, { type: "resend" })).toBe(ask);
    expect(go(ask, { type: "cancel" })).toEqual({ step: "form", lane: "oauth", terms, banner: CONNECT_COPY.stepUpCancelled });
  });

  test("the run, step by step, to the redirect (OAuth)", () => {
    const a = go(running("assistant"), { type: "assistantReady", address: "0xAs", at: T0 + 1 });
    expect(a).toMatchObject({ step: "running", at: "delegate", run: { assistant: "0xAs", done: ["assistant"] } });
    const d = go(a, { type: "delegated", at: T0 + 2 });
    expect(d).toMatchObject({ at: "permission", run: { done: ["assistant", "delegate"] } });
    const p = go(d, { type: "permissionSigned", pocket: "0xP", approval: "ap", pocketBalance: 0, at: T0 + 3 });
    expect(p).toMatchObject({ at: "funding", run: { pocket: "0xP", approval: "ap" } });
    const f = go(p, { type: "funded", at: T0 + 4 });
    expect(f).toMatchObject({ at: "registering" });
    const r = go(f, { type: "registered", grantId: "g1", at: T0 + 5 });
    expect(r).toMatchObject({ at: "approving", run: { grantId: "g1", done: ["assistant", "delegate", "permission", "funding", "registering"] } });
    const done = go(r, { type: "approved", redirect: "https://claude.ai/back" });
    expect(done).toMatchObject({ step: "done", grantId: "g1", redirect: "https://claude.ai/back" });
    expect(connectMarks(done).every((m) => m.mark === "done")).toBe(true);
    // each step's event is ignored at any other step
    expect(go(running("permission"), { type: "assistantReady", address: "x", at: T0 })).toEqual(running("permission"));
    expect(go(running("assistant"), { type: "delegated", at: T0 })).toEqual(running("assistant"));
    expect(go(running("funding"), { type: "permissionSigned", pocket: "p", approval: "a", pocketBalance: 0, at: T0 })).toEqual(running("funding"));
    expect(go(running("registering"), { type: "funded", at: T0 })).toEqual(running("registering"));
    expect(go(running("funding"), { type: "registered", grantId: "g", at: T0 })).toEqual(running("funding"));
    expect(go(running("registering"), { type: "approved", redirect: "r" })).toEqual(running("registering"));
    expect(go(running("approving"), { type: "approved", redirect: "r" })).toEqual(running("approving"));
  });

  test("a pocket that already holds the budget skips the funding step", () => {
    const p = go(running("permission"), { type: "permissionSigned", pocket: "0xP", approval: "ap", pocketBalance: 1000, at: T0 });
    expect(p).toMatchObject({ at: "registering", run: { skipped: ["funding"] } });
    expect(connectFunded(p)).toBe(true);
  });

  test("in-app: done with the connector link, shown once", () => {
    const run = { ...run0, steps: run0.steps.filter((s) => s !== "approving") };
    const reg: ConnectState = { step: "running", lane: "inapp", terms, run, at: "registering", startedAt: T0 };
    const link = { url: "https://agate.example/mcp/k", claudeCode: "claude mcp add" };
    const done = go(reg, { type: "registered", grantId: "g2", connector: link, at: T0 });
    expect(done).toEqual({ step: "done", lane: "inapp", terms, run: { ...run, grantId: "g2", done: ["registering"] }, grantId: "g2", connector: link });
    const hidden = go(done, { type: "hideLink" });
    expect(hidden).toEqual({ ...done, connector: undefined } as ConnectState);
    expect(go(hidden, { type: "hideLink" })).toBe(hidden);
    expect(go(inapp, { type: "hideLink" })).toBe(inapp);
  });

  test("in-app: the connection is kept once made, so a link that fails never makes a second one", () => {
    const run = { ...run0, steps: run0.steps.filter((s) => s !== "approving") };
    const reg: ConnectState = { step: "running", lane: "inapp", terms, run, at: "registering", startedAt: T0, waitingSince: T0 };
    const made = go(reg, { type: "created", grantId: "g3" });
    expect(made).toEqual({ step: "running", lane: "inapp", terms, run: { ...run, grantId: "g3" }, at: "registering", startedAt: T0 });
    expect(go(made, { type: "created", grantId: "g4" })).toBe(made);
    expect(go(running("funding"), { type: "created", grantId: "g" })).toEqual(running("funding"));
    const noLink = go(made, { type: "registered", grantId: "g3", linkFailed: true, at: T0 });
    expect(noLink).toMatchObject({ step: "done", grantId: "g3", linkFailed: true });
    expect((noLink as { connector?: unknown }).connector).toBeUndefined();
    const link = { url: "https://agate.example/mcp/k2" };
    expect(go(noLink, { type: "linkReady", connector: link })).toMatchObject({ step: "done", connector: link, linkFailed: undefined });
    const done = go(made, { type: "registered", grantId: "g3", connector: link, at: T0 });
    expect(go(done, { type: "linkReady", connector: { url: "x" } })).toBe(done);
  });

  test("the code could not be sent: back to the form with why", () => {
    const up: ConnectState = { step: "stepUp", lane: "oauth", terms, run: run0, code: "sending" };
    expect(go(up, { type: "cancel", banner: "Can't reach the sign-in service right now." })).toEqual({ step: "form", lane: "oauth", terms, banner: "Can't reach the sign-in service right now." });
  });

  test("409 not delegated yet: quiet retries for 30 s, then the line", () => {
    const w1 = go(running("registering"), { type: "notYet", at: T0 });
    expect(w1).toMatchObject({ at: "registering", waitingSince: T0 });
    const w2 = go(w1, { type: "notYet", at: T0 + NOT_YET_PATIENCE_MS - 1 });
    expect(w2).toMatchObject({ step: "running", waitingSince: T0 });
    expect(go(w2, { type: "notYet", at: T0 + NOT_YET_PATIENCE_MS })).toMatchObject({ step: "failed", at: "registering", problem: "notYet" });
    expect(go(running("funding"), { type: "notYet", at: T0 })).toEqual(running("funding"));
  });

  test("stepFailed: failed at that step; retry resumes there and never funds twice", () => {
    const f = go(running("funding"), { type: "stepFailed", problem: "funding" });
    expect(f).toEqual({ step: "failed", lane: "oauth", terms, run: run0, at: "funding", problem: "funding" });
    expect(go(f, { type: "retry", at: T0 + 9 })).toEqual({ ...running("funding"), startedAt: T0 + 9 });
    const afterFunding: ConnectRun = { ...run0, done: ["assistant", "delegate", "permission", "funding"] };
    const r = go(running("registering", afterFunding), { type: "stepFailed", problem: "offline" });
    expect(connectFunded(r)).toBe(true);
    expect(go(r, { type: "retry", at: T0 })).toEqual(running("registering", afterFunding));
    const up = go(confirming, checked({ canDelegate: false }));
    expect(go(up, { type: "stepFailed", problem: "key" })).toMatchObject({ step: "failed", at: "assistant", problem: "key" });
    expect(go(form, { type: "stepFailed", problem: "key" })).toBe(form);
    expect(go(form, { type: "retry", at: T0 })).toBe(form);
  });

  test("pocket in use: Try again reads the next pocket index", () => {
    const f = go(running("registering"), { type: "stepFailed", problem: "pocketInUse" });
    expect(go(f, { type: "retry", at: T0 })).toEqual({ step: "confirming", lane: "oauth", terms, withDrip: false });
  });

  test("the OAuth request ran out: ended before anything moved, failed with Take back after", () => {
    expect(go(form, { type: "requestExpired" })).toEqual({ step: "ended" });
    expect(go(confirming, { type: "requestExpired" })).toEqual({ step: "ended" });
    const f = go(running("registering"), { type: "requestExpired" });
    expect(f).toMatchObject({ step: "failed", at: "registering", problem: "expired" });
    expect(go(f, { type: "retry", at: T0 })).toBe(f);
    expect(go(go(confirming, checked({ canDelegate: false })), { type: "requestExpired" })).toMatchObject({ step: "failed", at: "assistant", problem: "expired" });
    expect(go({ step: "failed", lane: "oauth", terms, run: run0, at: "funding", problem: "funding" }, { type: "requestExpired" })).toMatchObject({ problem: "expired" });
    const done: ConnectState = { step: "done", lane: "oauth", terms, run: run0, grantId: "g", redirect: "r" };
    expect(go(done, { type: "requestExpired" })).toBe(done);
  });

  test("the money taken back from the failure panel: the run knows, never resumes past it, and starts again from the form", () => {
    const afterFunding: ConnectRun = { ...run0, pocket: "0xP", done: ["assistant", "delegate", "permission", "funding"] };
    const refused = go(running("registering", afterFunding), { type: "stepFailed", problem: "refused" });
    const took = go(refused, { type: "tookBack", moved: 1000 });
    expect(took).toEqual({ step: "failed", lane: "oauth", terms, run: { ...afterFunding, done: ["assistant", "delegate", "permission"], tookBack: 1000 }, at: "registering", problem: "refused" });
    expect(connectFunded(took)).toBe(false);
    // a bare Try again would connect the AI to an empty pocket
    expect(go(took, { type: "retry", at: T0 })).toBe(took);
    expect(go(took, { type: "startAgain" })).toEqual({ step: "form", lane: "oauth", terms });
    // a pocket the permission found already full is taken back the same way
    const full: ConnectRun = { ...run0, pocket: "0xP", done: ["assistant", "delegate", "permission"], skipped: ["funding"] };
    const t2 = go(go(running("registering", full), { type: "stepFailed", problem: "offline" }), { type: "tookBack", moved: 1000 });
    expect(t2.step === "failed" && t2.run.skipped).toEqual([]);
    // only a stopped run that holds the money
    const unsigned = go(running("permission"), { type: "stepFailed", problem: "sign" });
    expect(go(unsigned, { type: "tookBack", moved: 5 })).toBe(unsigned);
    expect(go(running("registering", afterFunding), { type: "tookBack", moved: 1000 })).toEqual(running("registering", afterFunding));
    // a request that ran out never starts again here: the AI app asks again
    const expired = go(go(running("registering", afterFunding), { type: "requestExpired" }), { type: "tookBack", moved: 1000 });
    expect(expired).toMatchObject({ step: "failed", problem: "expired", run: { tookBack: 1000 } });
    expect(go(expired, { type: "startAgain" })).toBe(expired);
    expect(go(form, { type: "startAgain" })).toBe(form);
  });

  test("Don't allow", () => {
    const d = go(form, { type: "deny" });
    expect(d).toEqual({ step: "denying", lane: "oauth", terms });
    expect(go(d, { type: "deniedDone", redirect: "https://claude.ai/no" })).toEqual({ step: "denied", redirect: "https://claude.ai/no" });
    expect(go(confirming, { type: "deny" })).toBe(confirming);
    expect(go(form, { type: "deniedDone" })).toBe(form);
  });

  test("checkTerms: every field's line (spec 9.5)", () => {
    const have = { balance: 9_478, canDrip: false };
    expect(checkTerms(terms, have)).toEqual({ ok: true, withDrip: false });
    expect(checkTerms({ ...terms, budget: 0 }, have)).toMatchObject({ ok: false, budget: "zero" });
    expect(checkTerms({ ...terms, budget: 1_200 }, { balance: 1_200, canDrip: false })).toEqual({ ok: true, withDrip: false });
    expect(checkTerms({ ...terms, budget: 1_201 }, { balance: 1_200, canDrip: false })).toMatchObject({ ok: false, budget: "over" });
    expect(checkTerms({ ...terms, budget: 2_500 }, { balance: 1_200, canDrip: true })).toEqual({ ok: true, withDrip: true });
    expect(checkTerms({ ...terms, budget: 11_201 }, { balance: 1_200, canDrip: true })).toMatchObject({ ok: false, budget: "over", withDrip: false });
    expect(checkTerms({ ...terms, perTradeCap: 0 }, have)).toMatchObject({ ok: false, perTradeCap: "zero" });
    expect(checkTerms({ ...terms, perTradeCap: 1_001 }, have)).toMatchObject({ ok: false, perTradeCap: "overBudget" });
    for (const n of [0, 51, 2.5]) expect(checkTerms({ ...terms, tradesPerDay: n }, have)).toMatchObject({ ok: false, tradesPerDay: "range" });
    expect(checkTerms({ ...terms, tradesPerDay: 50 }, have).ok).toBe(true);
    for (const d of [0, 91]) expect(checkTerms({ ...terms, days: d }, have)).toMatchObject({ ok: false, days: "range" });
    expect(checkTerms({ ...terms, days: 90 }, have).ok).toBe(true);
  });

  test("the server's numbers: u strings and an end in unix seconds", () => {
    expect(toU(1000)).toBe("1000000000");
    expect(toU(250)).toBe("250000000");
    expect(toU(0.01)).toBe("10000");
    expect(validUntilOf(T0, 7)).toBe(T0 / 1000 + 7 * 86_400);
    expect(termsWire(terms, T0)).toEqual({ label: "Claude", budget: "1000000000", perTradeCap: "250000000", tradesPerDay: 5, validUntil: T0 / 1000 + 604_800 });
  });

  test("marks, the next step, and when the page may be left", () => {
    const run: ConnectRun = { ...run0, skipped: ["assistant", "delegate"], done: ["permission"] };
    expect(connectMarks(running("funding", run))).toEqual([
      { step: "assistant", mark: "skipped" },
      { step: "delegate", mark: "skipped" },
      { step: "permission", mark: "done" },
      { step: "funding", mark: "current" },
      { step: "registering", mark: "waiting" },
      { step: "approving", mark: "waiting" },
    ]);
    expect(connectMarks({ step: "failed", lane: "oauth", terms, run, at: "funding", problem: "funding" })[3]).toEqual({ step: "funding", mark: "failed" });
    expect(connectMarks(go(confirming, checked({ canDelegate: false })))[0]).toEqual({ step: "assistant", mark: "current" });
    expect(connectMarks(form)).toEqual([]);
    expect(nextConnectStep(run, null)).toBe("funding");
    expect(nextConnectStep(run, "funding")).toBe("registering");
    expect(nextConnectStep({ ...run, done: [...run.done, "funding", "registering", "approving"] }, null)).toBeNull();
    expect(connectFunded(running("funding"))).toBe(false);
    expect(connectFunded(form)).toBe(false);
    const states: ConnectState[] = [form, confirming, go(confirming, checked({ canDelegate: false })), running("funding"), { step: "failed", lane: "oauth", terms, run, at: "funding", problem: "funding" }, { step: "done", lane: "oauth", terms, run, grantId: "g" }, { step: "ended" }, { step: "denying", lane: "oauth", terms }, { step: "denied" }];
    expect(states.map(connectDismissable)).toEqual([true, false, false, false, true, true, true, false, true]);
  });
});

// ===================================================================================================================
describe("disconnect", () => {
  const go = disconnectReducer;
  const c = { takeBack: true, lastActive: true, balance: 742 };
  const confirm = disconnectStart(true, 742);

  test("confirm: the take-back toggle is on by default", () => {
    expect(confirm).toEqual({ step: "confirm", ...c });
    expect(go(confirm, { type: "toggleTakeBack" })).toEqual({ step: "confirm", ...c, takeBack: false });
    expect(go(confirm, { type: "keep" })).toEqual({ step: "closed" });
    expect(go(confirm, { type: "confirm" })).toEqual({ step: "stopping", ...c });
    const stopping = go(confirm, { type: "confirm" });
    for (const e of [{ type: "toggleTakeBack" }, { type: "keep" }, { type: "confirm" }] as const) expect(go(stopping, e)).toBe(stopping);
  });

  test("stopped: the key goes off only for the last AI, then the money comes home", () => {
    expect(go({ step: "stopping", ...c }, { type: "stopped" })).toEqual({ step: "revoking", serverMissed: false, ...c });
    expect(go({ step: "stopping", ...c, lastActive: false }, { type: "stopped" })).toEqual({ step: "takingBack", serverMissed: false, ...c, lastActive: false });
    expect(go({ step: "stopping", ...c, lastActive: false, takeBack: false }, { type: "stopped" })).toEqual({ step: "done", tookBack: false, amount: 742, serverMissed: false });
    expect(go({ step: "stopping", ...c, lastActive: false, balance: 0 }, { type: "stopped" })).toEqual({ step: "done", tookBack: false, amount: 0, serverMissed: false });
    expect(go(confirm, { type: "stopped" })).toBe(confirm);
  });

  test("stopFailed: the last AI still gets its key switched off; with others active it is a failure", () => {
    expect(go({ step: "stopping", ...c }, { type: "stopFailed" })).toEqual({ step: "revoking", serverMissed: true, ...c });
    expect(go({ step: "stopping", ...c, lastActive: false }, { type: "stopFailed" })).toEqual({ step: "failed", at: "stopping", serverMissed: true, ...c, lastActive: false });
    expect(go(confirm, { type: "stopFailed" })).toBe(confirm);
  });

  test("revoked, revokeFailed, tookBack, takeBackFailed", () => {
    expect(go({ step: "revoking", serverMissed: true, ...c }, { type: "revoked" })).toEqual({ step: "takingBack", serverMissed: true, ...c });
    expect(go({ step: "revoking", serverMissed: false, ...c, takeBack: false }, { type: "revoked" })).toEqual({ step: "done", tookBack: false, amount: 742, serverMissed: false });
    expect(go({ step: "revoking", serverMissed: false, ...c }, { type: "revokeFailed" })).toEqual({ step: "failed", at: "revoking", serverMissed: false, ...c });
    expect(go({ step: "takingBack", serverMissed: false, ...c }, { type: "tookBack" })).toEqual({ step: "done", tookBack: true, amount: 742, serverMissed: false });
    expect(go({ step: "takingBack", serverMissed: true, ...c }, { type: "takeBackFailed" })).toEqual({ step: "failed", at: "takingBack", serverMissed: true, ...c });
    for (const e of [{ type: "revoked" }, { type: "revokeFailed" }, { type: "tookBack" }, { type: "takeBackFailed" }] as const) expect(go(confirm, e)).toBe(confirm);
  });

  test("retry reruns the failed step; close only when nothing runs", () => {
    expect(go({ step: "failed", at: "stopping", serverMissed: true, ...c }, { type: "retry" })).toEqual({ step: "stopping", ...c });
    expect(go({ step: "failed", at: "revoking", serverMissed: true, ...c }, { type: "retry" })).toEqual({ step: "revoking", serverMissed: true, ...c });
    expect(go({ step: "failed", at: "takingBack", serverMissed: false, ...c }, { type: "retry" })).toEqual({ step: "takingBack", serverMissed: false, ...c });
    expect(go(confirm, { type: "retry" })).toBe(confirm);
    const done: DisconnectState = { step: "done", tookBack: true, amount: 742, serverMissed: false };
    for (const s of [confirm, done, { step: "failed", at: "revoking", serverMissed: false, ...c } as DisconnectState]) expect(go(s, { type: "close" })).toEqual({ step: "closed" });
    const closed: DisconnectState = { step: "closed" };
    for (const s of [{ step: "stopping", ...c } as DisconnectState, { step: "revoking", serverMissed: false, ...c } as DisconnectState, { step: "takingBack", serverMissed: false, ...c } as DisconnectState, closed]) expect(go(s, { type: "close" })).toBe(s);
    expect(disconnectDismissable({ step: "stopping", ...c })).toBe(false);
    expect(disconnectDismissable(done)).toBe(true);
  });

  test("the steps shown", () => {
    expect(disconnectSteps(c)).toEqual(["stopping", "revoking", "takingBack"]);
    expect(disconnectSteps({ ...c, lastActive: false })).toEqual(["stopping", "takingBack"]);
    expect(disconnectSteps({ ...c, takeBack: false })).toEqual(["stopping", "revoking"]);
    expect(disconnectSteps({ ...c, lastActive: false, balance: 0 })).toEqual(["stopping"]);
  });
});

// ===================================================================================================================
describe("approval", () => {
  const go = approvalReducer;
  const EXP = T0 + 15 * 60_000;
  const long: ApprovalView = { id: "ap1", grantId: "g1", action: "open_long", params: { gpu: "H100", month: "2026-11", dollars: 600, pay_me_daily: false }, summary: { overCapBy: 350 }, note: null, status: "pending", expiresAt: EXP };
  const loading = approvalStart("ap1");
  const review: ApprovalState = { step: "review", approval: long };
  const sending: ApprovalState = { step: "sending", approval: long };

  test("loaded: review, later (close_short), expired, answered or not found", () => {
    expect(go(loading, { type: "loaded", approvals: [long], now: T0 })).toEqual(review);
    expect(go(loading, { type: "loaded", approvals: [{ ...long, action: "close_short" }], now: T0 })).toEqual({ step: "later", approval: { ...long, action: "close_short" } });
    expect(go(loading, { type: "loaded", approvals: [long], now: EXP })).toEqual({ step: "expired", approval: long });
    expect(go(loading, { type: "loaded", approvals: [{ ...long, status: "expired" }], now: T0 })).toEqual({ step: "expired", approval: { ...long, status: "expired" } });
    for (const status of ["done", "failed", "denied"] as const) expect(go(loading, { type: "loaded", approvals: [{ ...long, status }], now: T0 })).toEqual({ step: "answered", approval: { ...long, status } });
    expect(go(loading, { type: "loaded", approvals: [{ ...long, status: "approved" }], now: EXP + 1 })).toEqual({ step: "review", approval: { ...long, status: "approved" } });
    expect(go(loading, { type: "loaded", approvals: [{ ...long, id: "other" }], now: T0 })).toEqual({ step: "notFound", id: "ap1" });
    expect(go(review, { type: "loaded", approvals: [long], now: T0 })).toBe(review);
    expect(go(loading, { type: "loadFailed", message: "m" })).toEqual({ step: "loading", id: "ap1", message: "m" });
    expect(go(review, { type: "loadFailed", message: "m" })).toBe(review);
  });

  test("tick and approve: an expired card stops", () => {
    expect(go(review, { type: "tick", now: EXP - 1 })).toBe(review);
    expect(go(review, { type: "tick", now: EXP })).toEqual({ step: "expired", approval: long });
    expect(go({ step: "later", approval: long }, { type: "tick", now: EXP })).toEqual({ step: "expired", approval: long });
    expect(go(sending, { type: "tick", now: EXP + 1 })).toBe(sending);
    expect(go(review, { type: "approve", now: T0 })).toEqual(sending);
    expect(go(review, { type: "approve", now: EXP })).toEqual({ step: "expired", approval: long });
    expect(go({ step: "later", approval: long }, { type: "approve", now: T0 })).toEqual({ step: "later", approval: long });
  });

  test("its AI disconnected or ended: a waiting request ends, a running trade is left to finish", () => {
    expect(go(review, { type: "grantEnded" })).toEqual({ step: "expired", approval: long });
    expect(go({ step: "later", approval: long }, { type: "grantEnded" })).toEqual({ step: "expired", approval: long });
    expect(go(sending, { type: "grantEnded" })).toBe(sending);
    expect(go(loading, { type: "grantEnded" })).toBe(loading);
  });

  test("the trade from the main account: back, traded, failed, then reported", () => {
    expect(go(sending, { type: "back" })).toEqual(review);
    expect(go(review, { type: "back" })).toBe(review);
    const done = go(sending, { type: "traded", txHash: "0xT", userOpHash: "0xU" });
    expect(done).toEqual({ step: "done", approval: long, txHash: "0xT", userOpHash: "0xU", reported: false });
    const reported = go(done, { type: "reported" });
    expect(reported).toEqual({ ...done, reported: true } as ApprovalState);
    expect(go(reported, { type: "reported" })).toBe(reported);
    const failed = go(sending, { type: "tradeFailed", message: "This request can't be run from here." });
    expect(failed).toEqual({ step: "failed", approval: long, message: "This request can't be run from here.", reported: false, outcome: "retry" });
    expect(go(review, { type: "traded", txHash: "x", userOpHash: null })).toBe(review);
    expect(go(review, { type: "tradeFailed", message: "m" })).toBe(review);
    expect(go(review, { type: "reported" })).toBe(review);
    expect(go(failed, { type: "retry", now: T0 })).toEqual(review);
    expect(go(failed, { type: "retry", now: EXP })).toEqual({ step: "expired", approval: long });
    expect(go(review, { type: "retry", now: T0 })).toBe(review);
  });

  test("a refusal with nothing sent goes back to the card with why, and is never reported", () => {
    expect(go(sending, { type: "back", message: COPY.funds })).toEqual({ step: "review", approval: long, message: COPY.funds });
  });

  test("a landed revert is final: reported once, then Try again shows the server's answer, never runs it again", () => {
    const final = go(sending, { type: "tradeFailed", message: COPY.landedMoved, outcome: "final" });
    expect(final).toEqual({ step: "failed", approval: long, message: COPY.landedMoved, reported: false, outcome: "final" });
    expect(go(final, { type: "retry", now: T0 })).toBe(final);
    const told = go(final, { type: "reported", approval: { ...long, status: "failed" } });
    expect(told).toEqual({ ...final, reported: true, approval: { ...long, status: "failed" } } as ApprovalState);
    expect(go(told, { type: "retry", now: T0 })).toEqual({ step: "answered", approval: { ...long, status: "failed" } });
  });

  test("sent but not seen landing: no Try again, no report", () => {
    const unconfirmed = go(sending, { type: "tradeFailed", message: COPY.pending, outcome: "unconfirmed" });
    expect(go(unconfirmed, { type: "retry", now: T0 })).toBe(unconfirmed);
  });

  test("decline, from the card or a close_short", () => {
    const d = go(review, { type: "decline" });
    expect(d).toEqual({ step: "declining", approval: long, from: "review" });
    expect(go(d, { type: "declined" })).toEqual({ step: "declined", approval: long });
    expect(go(d, { type: "declineFailed", message: "m" })).toEqual({ step: "review", approval: long, message: "m" });
    const later: ApprovalState = { step: "later", approval: long };
    const dl = go(later, { type: "decline" });
    expect(go(dl, { type: "declineFailed", message: "m" })).toEqual({ step: "later", approval: long, message: "m" });
    expect(go(sending, { type: "decline" })).toBe(sending);
    expect(go(review, { type: "declined" })).toBe(review);
    expect(go(review, { type: "declineFailed", message: "m" })).toBe(review);
  });

  test("canReport: done and failed are taken 15 minutes past the end", () => {
    expect(canReport(long, T0)).toBe(true);
    expect(canReport(long, EXP + APPROVAL_REPORT_GRACE_MS - 1)).toBe(true);
    expect(canReport({ ...long, status: "expired" }, EXP + APPROVAL_REPORT_GRACE_MS - 1)).toBe(true);
    expect(canReport({ ...long, status: "expired" }, EXP + APPROVAL_REPORT_GRACE_MS)).toBe(false);
    expect(canReport({ ...long, status: "approved" }, EXP + APPROVAL_REPORT_GRACE_MS * 9)).toBe(true);
    expect(canReport({ ...long, status: "done" }, T0)).toBe(false);
    expect(approvalOpen(long, EXP - 1)).toBe(true);
    expect(approvalOpen({ ...long, status: "denied" }, T0)).toBe(false);
  });

  test("approvalOrder: the AI's arguments as the main account's order", () => {
    expect(approvalOrder(long)).toEqual({ kind: "buyLong", gpu: "H100", month: "2026-11", dollars: "600.00" });
    expect(approvalOrder({ ...long, params: { ...long.params, pay_me_daily: true, max_price: 4.2 } })).toEqual({ kind: "openLongDaily", gpu: "H100", month: "2026-11", dollars: "600.00", maxPrice: "4.2", parts: 1 });
    expect(approvalOrder({ ...long, action: "open_long_daily" })).toEqual({ kind: "openLongDaily", gpu: "H100", month: "2026-11", dollars: "600.00", parts: 1 });
    expect(approvalOrder({ ...long, action: "open_short", params: { gpu: "B200", month: "2026-11", gpu_hours: 100 } })).toEqual({ kind: "openShort", gpu: "B200", month: "2026-11", gpuHours: "100.0000", parts: 1, daily: true });
    expect(approvalOrder({ ...long, action: "open_short", params: { gpu: "B200", month: "2026-11", gpu_hours: 100.123456, pay_me_daily: false, min_price: 7.5 } })).toEqual({ kind: "openShort", gpu: "B200", month: "2026-11", gpuHours: "100.1234", parts: 1, daily: false, minPrice: "7.5" });
    expect(approvalOrder({ ...long, action: "close_short" })).toBeNull();
    expect(approvalOrder({ ...long, params: { ...long.params, month: "Nov" } })).toBeNull();
    expect(approvalOrder({ ...long, params: { gpu: "H100", month: "2026-11" } })).toBeNull();
    expect(approvalOrder({ ...long, action: "open_short", params: { gpu: "H100", month: "2026-11", gpu_hours: -1 } })).toBeNull();
  });
});

describe("passkey-first sign-in", () => {
  const choosing = signInReducer(SIGNED_OUT, { type: "open" });

  test("the dialog says which way it goes, and the step shows it", () => {
    const making = signInReducer(choosing, { type: "passkey", mode: "create" });
    expect(making).toEqual({ status: "verifying", email: "", via: "passkey", passkeyMode: "create" });
    expect(toAccountStep(making)).toEqual({ status: "verifying", email: "", via: "passkey", passkeyMode: "create" });
  });

  test("a failure keeps its reason and way for the choices that follow", () => {
    const signing = signInReducer(choosing, { type: "passkey", mode: "signin" });
    const failed = signInReducer(signing, { type: "passkeyFailed", message: "No passkey signed you in.", failure: { code: "cancelled", mode: "signin" } });
    expect(failed).toEqual({ status: "error", at: "passkey", message: "No passkey signed you in.", passkey: { code: "cancelled", mode: "signin" } });
    expect(toAccountStep(failed)).toMatchObject({ status: "error", passkey: { code: "cancelled", mode: "signin" } });
    // a choice after it starts a new attempt from the error step
    expect(signInReducer(failed, { type: "passkey", mode: "create" })).toMatchObject({ status: "verifying", passkeyMode: "create" });
  });

  test("the tap locks the sheet at once; the mode is set again once known, and a second tap starts nothing", () => {
    const tapped = signInReducer(choosing, { type: "passkey", mode: "create" });
    expect(signInReducer(tapped, { type: "passkey", mode: "signin" })).toMatchObject({ status: "verifying", passkeyMode: "signin" });
    expect(signInReducer(tapped, { type: "passkey", mode: "create" })).toBe(tapped);
    expect(signInReducer(tapped, { type: "google" })).toBe(tapped);
    expect(signInReducer(tapped, { type: "close" })).toBe(tapped);
  });

  test("a new account from a passkey goes on to the setup, with no email", () => {
    const making = signInReducer(choosing, { type: "passkey", mode: "create" });
    expect(signInReducer(making, { type: "verified", wallet: false, at: 5 })).toEqual({ status: "creating", email: "", part: "wallet", startedAt: 5 });
  });
});
