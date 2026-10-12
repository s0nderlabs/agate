// The account's state machines (wallet spec 3), as pure reducers: sign-in, a trade (closes use the same one),
// connecting an AI, disconnecting one, and an over-cap approval. No timers, no fetching, no React: the real account
// runs each step and dispatches what happened, the pretend account walks the same states with fake timings, and bun
// tests cover every transition. Times come in on the events, so the reducers stay pure. An event a state does not
// expect returns that same state object, so a late answer from an earlier step changes nothing.
import type { Position } from "@/lib/mock/types";
import { floorCents, floorHours } from "@/lib/size";
import { CONNECT_COPY, COPY, type ConnectProblem, type DisconnectAt, type FreshQuote, type Refusal, type RefusalAction } from "./errors";
import { type AccountPlan, type CodeProblem, type CreatingPart, DRIP, type DoneResult, type LimitDone, type LimitOrder, type LimitPlan, type Order, type RestingOrder, type SendStep, type PasskeyFailure, type PasskeyMode, type SignInErrorAt, type SignInStep, type SignInVia } from "./types";

const ceilCents = (d: number) => Math.ceil(Math.round(d * 1e6) / 1e4) / 100;

/** A step's look in the Steps list (spec 4.5); "failed" marks the step a run stopped at. */
export type StepMark = "done" | "current" | "waiting" | "skipped" | "failed";

// =====================================================================================================================
// SIGN-IN (spec 3.1, 2.5, 4): email code, Google or a passkey, then a new person's wallet and first test dollars
// =====================================================================================================================

/** "Send a new code" opens this long after a code went out. */
export const RESEND_AFTER_MS = 30_000;
/** A restore longer than this shows signed out (the hint is kept; a late answer with a user still signs in). */
export const RESTORE_PATIENCE_MS = 10_000;
/** The session (2 h) is refreshed on focus and this long before it ends. */
export const REFRESH_BEFORE_MS = 10 * 60_000;
/** Sending the first code also loads the sign-in SDK: past this the button reads "Getting ready". */
export const GETTING_READY_MS = 600;
/** Setting up takes about 10 s (the wallet) and 6 s (the first test dollars); past twice that it says so. */
export const CREATING_SLOW_MS: Record<CreatingPart, number> = { wallet: 20_000, dollars: 12_000 };

export type SignInState =
  /** nothing open; email is kept for the field */
  | { status: "signedOut"; email?: string }
  /** the sheet's first step: an email for a code, or Google */
  | { status: "choosing"; email?: string; problem?: "badEmail" }
  /** a restore hint was found on load: the nav shows a skeleton, never a "Sign in" flash */
  | { status: "restoring"; since: number }
  | { status: "sendingCode"; email: string; resend: boolean; gettingReady?: boolean }
  /** resent: a new code went out, so the one before no longer works */
  | { status: "codeSent"; email: string; sentAt: number; resent: boolean; problem?: CodeProblem }
  /** sentAt and resent keep the code step to return to when the code is refused; via passkey: the browser's dialog */
  | { status: "verifying"; email: string; via: SignInVia; sentAt?: number; resent?: boolean; passkeyMode?: PasskeyMode }
  /** left for Google; signing in with Google while signed in links instead, so it never starts from ready */
  | { status: "googleRedirect" }
  /** once per new person: the wallet, then the first 10,000 test dollars */
  | { status: "creating"; email: string; part: CreatingPart; startedAt: number }
  /** writes are allowed only here; firstDripFailed: set up, but the first test dollars did not arrive */
  | { status: "ready"; email?: string; firstDripFailed?: boolean }
  | { status: "signingOut" }
  | { status: "error"; at: SignInErrorAt; message: string; email?: string; passkey?: PasskeyFailure }
  /** the session ended by itself (expired, or signed out elsewhere): the Notice says so */
  | { status: "sessionEnded"; email?: string };

export type SignInEvent =
  /** on load: a restore hint in storage or not */
  | { type: "mount"; hint: boolean; at: number }
  /** RESTORE_PATIENCE_MS passed without an answer */
  | { type: "restoreSlow" }
  /** the SDK is up: a user or not, a main wallet or not (also a late answer after restoreSlow) */
  | { type: "restored"; user: boolean; wallet: boolean; email?: string; at: number }
  | { type: "open" }
  | { type: "close" }
  | { type: "start"; email: string }
  | { type: "gettingReady" }
  | { type: "codeSent"; at: number }
  | { type: "sendFailed"; at: "init" | "sendCode"; message: string }
  | { type: "verify"; code: string }
  | { type: "codeRejected"; problem: CodeProblem }
  /** the code (or Google, or a session already present while sending) signed in */
  | { type: "verified"; wallet: boolean; email?: string; at: number }
  | { type: "resend"; at: number }
  | { type: "otherEmail" }
  | { type: "google" }
  /** on load, the URL is Google's way back */
  | { type: "googleReturned" }
  | { type: "googleFailed"; message: string }
  /** a passkey instead of a code: the browser's dialog is up (mode: saving a new one, or picking one) */
  | { type: "passkey"; mode?: PasskeyMode }
  /** the dialog was closed, or no passkey signed in; failure: a passkey-first attempt's reason and way */
  | { type: "passkeyFailed"; message: string; failure?: PasskeyFailure }
  | { type: "walletMade"; at: number }
  | { type: "walletFailed"; message: string }
  | { type: "dripped" }
  | { type: "dripFailed" }
  | { type: "retry"; at: number }
  | { type: "signOut" }
  /** logout finished (or threw: sign out still completes) */
  | { type: "signedOut" }
  /** the SDK's logout event, any reason (token-expired included) */
  | { type: "loggedOut"; reason?: string };

export const SIGNED_OUT: SignInState = { status: "signedOut" };

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
/** A pasted code may carry spaces or a dash ("123 456"). */
export const cleanCode = (s: string) => s.replace(/[\s-]/g, "");
export const isCode = (s: string) => /^\d{6}$/.test(cleanCode(s));

/** The sheet may take an email (or Google, or a passkey) now. */
export const canStart = (s: SignInState) => s.status === "signedOut" || s.status === "sessionEnded" || s.status === "choosing" || (s.status === "error" && s.at !== "wallet");

export function canResend(s: SignInState, now: number) {
  return s.status === "codeSent" && (s.problem === "expired" || s.problem === "tooMany" || now - s.sentAt >= RESEND_AFTER_MS);
}

/** Whole seconds until "Send a new code" opens ("Send a new code in 0:30"); 0 once it is open. */
export function resendWait(s: SignInState, now: number) {
  if (s.status !== "codeSent" || canResend(s, now)) return 0;
  return Math.ceil((RESEND_AFTER_MS - (now - s.sentAt)) / 1000);
}

/** Whether the sign-in sheet may close now. Verifying, Google, setting up and a wallet error hold it. */
export function signInClosable(s: SignInState) {
  return s.status === "choosing" || s.status === "sendingCode" || s.status === "codeSent" || (s.status === "error" && s.at !== "wallet");
}

/** "Taking longer than usual" while setting up. */
export function creatingSlow(s: SignInState, now: number) {
  return s.status === "creating" && now - s.startedAt > CREATING_SLOW_MS[s.part];
}

/** Writes (trades, drips, connecting an AI) are allowed only when ready. */
export const writesAllowed = (s: SignInState) => s.status === "ready";

/** When the 2-hour session should be refreshed: REFRESH_BEFORE_MS before it ends (and on focus, by the caller). */
export function refreshDue(expiresAt: number | null, now: number) {
  return expiresAt !== null && now >= expiresAt - REFRESH_BEFORE_MS;
}

export function signInReducer(s: SignInState, e: SignInEvent): SignInState {
  switch (e.type) {
    case "mount":
      return s.status === "signedOut" && e.hint ? { status: "restoring", since: e.at } : s;
    case "restoreSlow":
      return s.status === "restoring" ? SIGNED_OUT : s;
    case "restored": {
      if (s.status !== "restoring" && s.status !== "signedOut" && s.status !== "choosing") return s;
      if (!e.user) return s.status === "restoring" ? SIGNED_OUT : s;
      return e.wallet ? { status: "ready", email: e.email } : { status: "creating", email: e.email ?? "", part: "wallet", startedAt: e.at };
    }
    case "open":
      return s.status === "signedOut" || s.status === "sessionEnded" ? { status: "choosing", email: s.email } : s;
    case "close":
      return signInClosable(s) ? { status: "signedOut", email: "email" in s ? s.email : undefined } : s;
    case "start": {
      if (!canStart(s)) return s;
      const email = e.email.trim();
      return isEmail(email) ? { status: "sendingCode", email, resend: false } : { status: "choosing", email, problem: "badEmail" };
    }
    case "gettingReady":
      return s.status === "sendingCode" && !s.gettingReady ? { ...s, gettingReady: true } : s;
    case "codeSent":
      return s.status === "sendingCode" ? { status: "codeSent", email: s.email, sentAt: e.at, resent: s.resend } : s;
    case "sendFailed":
      return s.status === "sendingCode" ? { status: "error", at: e.at, message: e.message, email: s.email } : s;
    case "verify":
      if (s.status !== "codeSent") return s;
      return isCode(e.code) ? { status: "verifying", email: s.email, via: "code", sentAt: s.sentAt, resent: s.resent } : { ...s, problem: "wrong" };
    case "codeRejected":
      return s.status === "verifying" && s.via === "code" ? { status: "codeSent", email: s.email, sentAt: s.sentAt ?? 0, resent: s.resent ?? false, problem: e.problem } : s;
    case "verified": {
      if (s.status !== "verifying" && s.status !== "sendingCode") return s;
      const email = e.email ?? s.email;
      return e.wallet ? { status: "ready", email } : { status: "creating", email, part: "wallet", startedAt: e.at };
    }
    case "resend":
      return canResend(s, e.at) && s.status === "codeSent" ? { status: "sendingCode", email: s.email, resend: true } : s;
    case "otherEmail":
      return s.status === "codeSent" || (s.status === "error" && s.at !== "wallet") ? { status: "choosing", email: s.email } : s;
    case "google":
      return canStart(s) ? { status: "googleRedirect" } : s;
    case "googleReturned":
      return s.status === "signedOut" || s.status === "restoring" || s.status === "choosing" || s.status === "googleRedirect" || s.status === "sessionEnded" ? { status: "verifying", email: "", via: "google" } : s;
    case "googleFailed":
      return s.status === "googleRedirect" || (s.status === "verifying" && s.via === "google") ? { status: "error", at: "google", message: e.message } : s;
    case "passkey":
      if (s.status === "verifying" && s.via === "passkey") return e.mode && e.mode !== s.passkeyMode ? { ...s, passkeyMode: e.mode } : s;
      return canStart(s) ? { status: "verifying", email: "", via: "passkey", passkeyMode: e.mode } : s;
    case "passkeyFailed":
      return s.status === "verifying" && s.via === "passkey" ? { status: "error", at: "passkey", message: e.message, passkey: e.failure } : s;
    case "walletMade":
      return s.status === "creating" && s.part === "wallet" ? { ...s, part: "dollars", startedAt: e.at } : s;
    case "walletFailed":
      return s.status === "creating" && s.part === "wallet" ? { status: "error", at: "wallet", message: e.message, email: s.email } : s;
    case "dripped":
      if (s.status === "creating" && s.part === "dollars") return { status: "ready", email: s.email };
      return s.status === "ready" && s.firstDripFailed ? { status: "ready", email: s.email } : s;
    case "dripFailed":
      return s.status === "creating" && s.part === "dollars" ? { status: "ready", email: s.email, firstDripFailed: true } : s;
    case "retry":
      if (s.status !== "error") return s;
      // the wallet step is idempotent; a failed init cleared its memo, so sending again starts a fresh one
      if (s.at === "wallet") return { status: "creating", email: s.email ?? "", part: "wallet", startedAt: e.at };
      if ((s.at === "init" || s.at === "sendCode") && s.email) return { status: "sendingCode", email: s.email, resend: false };
      return { status: "choosing", email: s.email };
    case "signOut":
      return s.status === "ready" || (s.status === "error" && s.at === "wallet") ? { status: "signingOut" } : s;
    case "signedOut":
      return s.status === "signingOut" ? SIGNED_OUT : s;
    case "loggedOut":
      if (s.status === "signingOut" || s.status === "restoring") return SIGNED_OUT;
      if (s.status === "ready" || s.status === "creating" || (s.status === "error" && s.at === "wallet")) return { status: "sessionEnded", email: s.email };
      return s;
  }
}

/** The machine's state as the Account's sign-in step (types.ts): choosing and a session that ended are signed out
 *  there, and the way to Google reads as verifying with Google. */
export function toAccountStep(s: SignInState): SignInStep {
  switch (s.status) {
    case "signedOut":
    case "choosing":
    case "sessionEnded":
      return { status: "signedOut", email: s.email };
    case "restoring":
      return { status: "restoring" };
    case "sendingCode":
      return { status: "sendingCode", email: s.email, resend: s.resend };
    case "codeSent":
      return { status: "codeSent", email: s.email, sentAt: s.sentAt, resent: s.resent, problem: s.problem };
    case "verifying":
      return { status: "verifying", email: s.email, via: s.via, passkeyMode: s.passkeyMode };
    case "googleRedirect":
      return { status: "verifying", email: "", via: "google" };
    case "creating":
      return { status: "creating", email: s.email, part: s.part, startedAt: s.startedAt };
    case "ready":
      return { status: "ready", firstDripFailed: s.firstDripFailed };
    case "signingOut":
      return { status: "signingOut" };
    case "error":
      return { status: "error", at: s.at, message: s.message, email: s.email, passkey: s.passkey };
  }
}

// =====================================================================================================================
// TRADE (spec 3.2, 6): the ticket's order, planned, reviewed, signed, sent, landed. Closes walk the same machine.
// =====================================================================================================================

/** Confirm plans again when the plan is older than this. */
export const REPLAN_AFTER_MS = 15_000;
/** Placing says "Monad is slower than usual" past this. */
export const PLACING_SLOW_MS = 15_000;

/** What a trade asks for: the screen's own numbers (n, opaque here), the order, and the dollars it needs in the
 *  account (a Long's dollars, a Short's GPU-hours x the cap, a buy-back's most). */
export interface TradeAsk<N = unknown> {
  n: N;
  order: Order;
  need: number;
}

/** What Failed offers: plan again, back to the ticket, the Funds sheet, or "Check the new price" (plans again). */
export type FailedAction = "retry" | "back" | "funds" | "recheck";

export type TradeState<N = unknown> =
  /** no sheet; inline: the ticket's own line (an amount it cannot take) */
  | { step: "idle"; inline?: string }
  /** the sign-in sheet, the trade kept */
  | { step: "signin"; ask: TradeAsk<N>; message?: string }
  | { step: "funds"; ask: TradeAsk<N>; message?: string }
  | { step: "dripping"; ask: TradeAsk<N> }
  /** andSend: Confirm already happened (a stale plan, or the one quiet re-plan), so a good plan goes straight to signing */
  | { step: "planning"; ask: TradeAsk<N>; andSend: boolean; replanned: boolean }
  | { step: "review"; ask: TradeAsk<N>; plan: AccountPlan; message?: string }
  /** there is no wallet popup: the Confirm tap is the consent */
  | { step: "signing"; ask: TradeAsk<N>; plan: AccountPlan; replanned: boolean; resent: boolean }
  | { step: "sending"; ask: TradeAsk<N>; plan: AccountPlan; userOpHash: string; sentAt: number; replanned: boolean }
  /** sent, no receipt in 120 s: polling continues, a resend is never offered */
  | { step: "pending"; ask: TradeAsk<N>; plan: AccountPlan; userOpHash: string }
  | { step: "moved"; ask: TradeAsk<N>; quote: FreshQuote }
  | { step: "thin"; ask: TradeAsk<N>; quote: FreshQuote }
  | { step: "failed"; ask: TradeAsk<N>; message: string; action: FailedAction }
  | { step: "done"; ask: TradeAsk<N>; result: DoneResult };

export type TradeEvent<N = unknown> =
  | { type: "submit"; ask: TradeAsk<N>; ready: boolean; balance: number }
  | { type: "signedIn"; balance: number }
  | { type: "planned"; plan: AccountPlan }
  /** planning refused: errors.ts refusalOf */
  | { type: "refused"; refusal: Refusal }
  | { type: "confirm"; at: number }
  | { type: "back" }
  | { type: "close" }
  | { type: "signed"; userOpHash: string; at: number }
  /** signing or sending failed: errors.ts sendRefusal */
  | { type: "sendFailed"; refusal: Refusal }
  | { type: "landed"; result: DoneResult }
  /** the receipt said success false: the onchain bound was hit */
  | { type: "reverted" }
  | { type: "timedOut" }
  /** Moved: "Trade at the new price" */
  | { type: "newPrice" }
  /** Thin: "Buy $X instead" */
  | { type: "buyInstead" }
  /** Failed: its one action */
  | { type: "retry" }
  | { type: "drip" }
  | { type: "dripLanded"; balance: number }
  | { type: "dripFailed"; message: string }
  /** the logout event while a trade waits */
  | { type: "sessionEnded" };

export const TRADE_IDLE: TradeState<never> = { step: "idle" };

/** The retry guard from a fresh quote (spec 2.8 guardFromQuote). Moved: the quote becomes the new least (or most)
 *  and a price guard is dropped. Thin (buys only): buy the dollars the book holds at prices the month can pay. */
export function guardFromQuote(order: Order, quote: FreshQuote, how: "moved" | "thin" = "moved"): Order {
  switch (order.kind) {
    case "buyLong":
    case "openLongDaily": {
      const next = { ...order, minGpuHours: floorHours(quote.gpuHours).toFixed(4) };
      delete next.maxPrice;
      if (how === "thin") next.dollars = floorCents(quote.dollars).toFixed(2);
      return next;
    }
    case "openShort": {
      const next = { ...order, minDollars: floorCents(quote.dollars).toFixed(2) };
      delete next.minPrice;
      return next;
    }
    case "sellLong":
    case "closeLongDaily":
      return { ...order, minDollars: floorCents(quote.dollars).toFixed(2) };
    case "closeShort":
      return { ...order, maxDollars: ceilCents(quote.dollars).toFixed(2) };
    case "drip":
      return order;
  }
}

/** The dollars a re-guarded order needs: a buy its dollars, a buy-back its most; others keep what they needed. */
function needAfter(order: Order, before: number) {
  if (order.kind === "buyLong" || order.kind === "openLongDaily") return Number(order.dollars);
  if (order.kind === "closeShort" && order.maxDollars !== undefined) return Number(order.maxDollars);
  return before;
}

const reguard = <N>(ask: TradeAsk<N>, quote: FreshQuote, how: "moved" | "thin"): TradeAsk<N> => {
  const order = guardFromQuote(ask.order, quote, how);
  return { ...ask, order, need: needAfter(order, ask.need) };
};

const failedAction = (a: RefusalAction): FailedAction => (a === "retry" || a === "recheck" || a === "funds" ? a : "back");
const failedOf = <N>(ask: TradeAsk<N>, message: string, action: FailedAction): TradeState<N> => ({ step: "failed", ask, message, action });
const plan0 = <N>(ask: TradeAsk<N>, andSend = false, replanned = false): TradeState<N> => ({ step: "planning", ask, andSend, replanned });

/** Where a refused plan goes (spec 6.9 "Planning"). */
function afterPlanRefusal<N>(ask: TradeAsk<N>, r: Refusal): TradeState<N> {
  switch (r.sheet) {
    case "ticket":
      return { step: "idle", inline: r.message };
    case "funds":
      return { step: "funds", ask };
    case "drip":
      return { step: "funds", ask, message: r.message };
    case "thin":
      return r.quote ? { step: "thin", ask, quote: r.quote } : failedOf(ask, r.message, "retry");
    case "moved":
      return r.quote ? { step: "moved", ask, quote: r.quote } : failedOf(ask, r.message, "retry");
    case "signin":
      return { step: "signin", ask, message: r.message };
    default:
      return failedOf(ask, r.message, failedAction(r.action));
  }
}

/** Whether the trade's sheet may close (backdrop, Escape). Placing cannot: signing, sending, or planning after Confirm. */
export function tradeDismissable(s: TradeState<unknown>) {
  return !(s.step === "signing" || s.step === "sending" || (s.step === "planning" && s.andSend));
}

/** The Placing sheet's three steps ("Checking the price", "Signing with your wallet", "Waiting for Monad"), or null
 *  when Placing is not showing. */
export function placingMarks(s: TradeState<unknown>): [StepMark, StepMark, StepMark] | null {
  if (s.step === "planning" && s.andSend) return ["current", "waiting", "waiting"];
  if (s.step === "signing") return ["done", "current", "waiting"];
  if (s.step === "sending" || s.step === "pending") return ["done", "done", "current"];
  return null;
}

export const placingSlow = (s: TradeState<unknown>, now: number) => s.step === "sending" && now - s.sentAt > PLACING_SLOW_MS;

export function tradeReducer<N>(s: TradeState<N>, e: TradeEvent<N>): TradeState<N> {
  switch (e.type) {
    case "submit":
      if (s.step !== "idle") return s;
      if (!e.ready) return { step: "signin", ask: e.ask };
      return e.balance < e.ask.need ? { step: "funds", ask: e.ask } : plan0(e.ask);
    case "signedIn":
      if (s.step !== "signin") return s;
      return e.balance < s.ask.need ? { step: "funds", ask: s.ask } : plan0(s.ask);
    case "planned":
      if (s.step !== "planning") return s;
      return s.andSend ? { step: "signing", ask: s.ask, plan: e.plan, replanned: s.replanned, resent: false } : { step: "review", ask: s.ask, plan: e.plan };
    case "refused":
      return s.step === "planning" ? afterPlanRefusal(s.ask, e.refusal) : s;
    case "confirm":
      if (s.step !== "review") return s;
      return e.at - s.plan.plannedAt > REPLAN_AFTER_MS ? plan0(s.ask, true) : { step: "signing", ask: s.ask, plan: s.plan, replanned: false, resent: false };
    case "back":
      if (s.step === "review" || s.step === "moved" || s.step === "thin" || s.step === "funds" || s.step === "failed" || s.step === "signin" || (s.step === "planning" && !s.andSend)) return { step: "idle" };
      return s;
    case "close":
      return s.step !== "idle" && tradeDismissable(s) ? { step: "idle" } : s;
    case "signed":
      return s.step === "signing" ? { step: "sending", ask: s.ask, plan: s.plan, userOpHash: e.userOpHash, sentAt: e.at, replanned: s.replanned } : s;
    case "sendFailed": {
      if (s.step !== "signing" && s.step !== "sending") return s;
      const r = e.refusal;
      switch (r.sheet) {
        case "review":
          return { step: "review", ask: s.ask, plan: s.plan, message: r.message };
        case "signin":
          return { step: "signin", ask: s.ask, message: r.message };
        case "replan":
          // the bundler's simulation reverted: plan again once, then say Monad turned it down
          return s.replanned ? failedOf(s.ask, COPY.turnedDown, "back") : plan0(s.ask, true, true);
        case "resend":
          // AA25: send again once inside the lock, then the generic line
          return s.step === "signing" && !s.resent ? { ...s, resent: true } : failedOf(s.ask, COPY.sendGeneric, "retry");
        case "pending":
          return s.step === "sending" ? { step: "pending", ask: s.ask, plan: s.plan, userOpHash: s.userOpHash } : failedOf(s.ask, COPY.sendGeneric, "retry");
        case "funds":
          return { step: "funds", ask: s.ask };
        default:
          return failedOf(s.ask, r.message, failedAction(r.action));
      }
    }
    case "landed":
      return s.step === "sending" || s.step === "pending" ? { step: "done", ask: s.ask, result: e.result } : s;
    case "reverted":
      return s.step === "sending" || s.step === "pending" ? failedOf(s.ask, COPY.landedMoved, "recheck") : s;
    case "timedOut":
      return s.step === "sending" ? { step: "pending", ask: s.ask, plan: s.plan, userOpHash: s.userOpHash } : s;
    case "newPrice":
      return s.step === "moved" ? plan0(reguard(s.ask, s.quote, "moved")) : s;
    case "buyInstead":
      return s.step === "thin" ? plan0(reguard(s.ask, s.quote, "thin")) : s;
    case "retry":
      if (s.step !== "failed") return s;
      if (s.action === "funds") return { step: "funds", ask: s.ask };
      if (s.action === "back") return { step: "idle" };
      return plan0(s.ask);
    case "drip":
      return s.step === "funds" ? { step: "dripping", ask: s.ask } : s;
    case "dripLanded":
      if (s.step !== "dripping") return s;
      return e.balance < s.ask.need ? { step: "funds", ask: s.ask } : plan0(s.ask);
    case "dripFailed":
      return s.step === "dripping" ? { step: "funds", ask: s.ask, message: e.message } : s;
    case "sessionEnded":
      if (s.step === "review" || s.step === "funds" || s.step === "moved" || s.step === "thin" || s.step === "failed" || (s.step === "planning" && !s.andSend)) {
        return { step: "signin", ask: s.ask, message: COPY.sessionTrade };
      }
      return s;
  }
}

// =====================================================================================================================
// LIMIT ORDERS (Pro, the real account): a resting order placed, cancelled, or what Kuru holds moved back, each planned
// and sent as one operation. No Review sheet: the button names the act, so its tap is the consent, as Confirm's is.
// =====================================================================================================================

export type LimitState =
  | { step: "idle" }
  | { step: "checking"; order: LimitOrder }
  | { step: "signing"; order: LimitOrder; plan: LimitPlan }
  | { step: "sending"; order: LimitOrder; plan: LimitPlan; userOpHash?: string }
  | { step: "done"; order: LimitOrder; result: LimitDone }
  /** sent: it went to Monad (not seen landing, or it landed and reverted), so it is never sent again from here */
  | { step: "failed"; order: LimitOrder; message: string; sent: boolean };

export type LimitEvent =
  | { type: "start"; order: LimitOrder }
  | { type: "planned"; plan: LimitPlan }
  /** planning refused: errors.ts limitRefusal */
  | { type: "refused"; message: string }
  /** the send's own steps (the wallet signing, then waiting for Monad) */
  | { type: "step"; step: SendStep; userOpHash?: string }
  | { type: "landed"; result: LimitDone }
  /** signing or sending failed: errors.ts limitSendRefusal */
  | { type: "sendFailed"; message: string; nothingSent: boolean };

export const LIMIT_IDLE: LimitState = { step: "idle" };

/** This button's run is on its way: its words, and no second start from it (useLimitRun keeps one run at a time
 *  across the whole account). */
export const limitBusy = (s: LimitState) => s.step === "checking" || s.step === "signing" || s.step === "sending";

export function limitReducer(s: LimitState, e: LimitEvent): LimitState {
  switch (e.type) {
    case "start":
      return limitBusy(s) ? s : { step: "checking", order: e.order };
    case "planned":
      return s.step === "checking" ? { step: "signing", order: s.order, plan: e.plan } : s;
    case "refused":
      return s.step === "checking" ? { step: "failed", order: s.order, message: e.message, sent: false } : s;
    case "step":
      if (s.step !== "signing" && s.step !== "sending") return s;
      return e.step === "sending" ? { step: "sending", order: s.order, plan: s.plan, userOpHash: e.userOpHash } : s;
    case "landed":
      return s.step === "signing" || s.step === "sending" ? { step: "done", order: s.order, result: e.result } : s;
    case "sendFailed":
      return s.step === "signing" || s.step === "sending" ? { step: "failed", order: s.order, message: e.message, sent: !e.nothingSent } : s;
  }
}

/** The run's words while it is on its way, for the button it was started from. */
export function limitStepText(s: LimitState): string | null {
  if (s.step === "checking") return s.order.kind === "placeLimit" ? "Checking the book" : s.order.kind === "redeem" ? "Turning them back into dollars" : "Checking the order";
  if (s.step === "signing") return "Your wallet is signing";
  if (s.step === "sending") return "Sending to Monad";
  return null;
}

/** What the real account holds, less what still rests: an ask mints its pairs and keeps the short half in the wallet
 *  (a "shortBalance" at entry $0) before anything sells. On the part still resting the person holds both halves, so is
 *  flat; only the part that sold is a Short (agate, Oct 8: resting = min(short balance, the month's resting asks)). */
export function withoutResting(positions: Position[], orders: RestingOrder[]): Position[] {
  const left = new Map<string, number>();
  for (const o of orders) if (o.side === "short") left.set(`${o.gpu}-${o.month}`, (left.get(`${o.gpu}-${o.month}`) ?? 0) + o.q);
  if (left.size === 0) return positions;
  return positions.flatMap((p) => {
    const k = `${p.gpu}-${p.month}`;
    const r = p.kind === "shortBalance" ? Math.min(p.q, left.get(k) ?? 0) : 0;
    if (r <= 0) return [p];
    left.set(k, (left.get(k) ?? 0) - r);
    const q = p.q - r;
    return q > 1e-6 ? [{ ...p, q }] : [];
  });
}

/** A resting order's key in the app: Kuru counts order ids per book, so its id is only unique with the market. */
export const restingKey = (gpu: string, month: string, orderId: string) => `${gpu}-${month}-${orderId}`;

/** The resting orders as they stand once a batch landed, before the next read: a placed order first (when the receipt
 *  named its id), cancelled ones gone. A read this early can still be a block behind, so the list is told instead. */
export function ordersAfter(list: RestingOrder[], plan: LimitPlan, done: LimitDone, now: number): RestingOrder[] {
  const s = plan.summary;
  if (!s.gpu || !s.month) return list;
  if (done.action === "cancelLimit") {
    const gone = new Set((done.cancelled ?? s.cancelled ?? []).map((id) => restingKey(s.gpu!, s.month!, id)));
    return list.filter((o) => !gone.has(o.id));
  }
  if (done.action !== "placeLimit" || !done.orderId) return list;
  const id = restingKey(s.gpu, s.month, done.orderId);
  if (list.some((o) => o.id === id) || !s.side || s.price === undefined || s.gpuHours === undefined) return list;
  return [{ id, orderId: done.orderId, gpu: s.gpu, month: s.month, side: s.side, price: s.price, q: s.gpuHours, placedAt: new Date(now).toISOString(), filled: 0 }, ...list];
}

// =====================================================================================================================
// CONNECT AN AI (spec 3.3, 9): the form, Allow, then the key (first AI only), the pocket's limits, its money and
// the connection, with step-up only when the trading key must be delegated again
// =====================================================================================================================

/** The defaults (Oct 5): a $1,000 pocket, $250 a trade, 5 trades a day, 7 days. */
export const ALLOW_DEFAULTS = { budget: 1000, perTradeCap: 250, tradesPerDay: 5, days: 7 } as const;
export const BUDGET_CHIPS = [500, 1000, 2500] as const;
export const PER_TRADE_CHIPS = [100, 250, 500] as const;
export const DAYS_CHIPS = [1, 7, 30] as const;
export const TRADES_PER_DAY = { min: 1, max: 50 } as const;
export const MAX_DAYS = 90;
/** POST /api/grants answers 409 until the key's delegation reaches the server: retry every 2 s for up to 30 s. */
export const NOT_YET_EVERY_MS = 2_000;
export const NOT_YET_PATIENCE_MS = 30_000;

export interface ConnectTerms {
  /** the AI's name as the person sees it ("Claude", or the OAuth client's name) */
  label: string;
  /** dollars moved into the pocket now */
  budget: number;
  perTradeCap: number;
  tradesPerDay: number;
  days: number;
}

export const defaultTerms = (label: string): ConnectTerms => ({ label, ...ALLOW_DEFAULTS });

/** The form's checks (spec 9.5). withDrip: the balance is short but today's free test dollars cover it, so funding
 *  becomes one operation [drip, transfer]. */
export interface TermsCheck {
  ok: boolean;
  withDrip: boolean;
  budget?: "zero" | "over";
  perTradeCap?: "zero" | "overBudget";
  tradesPerDay?: "range";
  days?: "range";
}

export function checkTerms(t: ConnectTerms, have: { balance: number; canDrip: boolean }): TermsCheck {
  const c: TermsCheck = { ok: true, withDrip: false };
  if (!(t.budget > 0)) c.budget = "zero";
  else if (t.budget > have.balance) {
    if (have.canDrip && t.budget <= have.balance + DRIP) c.withDrip = true;
    else c.budget = "over";
  }
  if (!(t.perTradeCap > 0)) c.perTradeCap = "zero";
  else if (t.budget > 0 && t.perTradeCap > t.budget) c.perTradeCap = "overBudget";
  if (!Number.isInteger(t.tradesPerDay) || t.tradesPerDay < TRADES_PER_DAY.min || t.tradesPerDay > TRADES_PER_DAY.max) c.tradesPerDay = "range";
  if (!(t.days > 0) || t.days > MAX_DAYS) c.days = "range";
  c.ok = !c.budget && !c.perTradeCap && !c.tradesPerDay && !c.days;
  return c;
}

/** Dollars as the server's u string (1e6 = $1), whole cents. */
export const toU = (dollars: number) => (BigInt(Math.round(dollars * 100)) * 10_000n).toString();
/** validUntil in unix seconds: now + days. */
export const validUntilOf = (now: number, days: number) => Math.floor(now / 1000) + Math.round(days * 86_400);

/** POST /api/grants's numbers from the terms (the addresses, index and signature come from the run). */
export const termsWire = (t: ConnectTerms, now: number) => ({ label: t.label, budget: toU(t.budget), perTradeCap: toU(t.perTradeCap), tradesPerDay: t.tradesPerDay, validUntil: validUntilOf(now, t.days) });

/** OAuth: the AI app asked through /authorize and gets a redirect back. In-app: Agate shows a connector link once. */
export type ConnectLane = "oauth" | "inapp";

export type ConnectStep = "assistant" | "delegate" | "permission" | "funding" | "registering" | "approving";
export const CONNECT_STEPS: readonly ConnectStep[] = ["assistant", "delegate", "permission", "funding", "registering", "approving"];

/** POST /api/grants/:id/connector: shown once, and asking again replaces it. */
export interface ConnectorLink {
  url: string;
  claudeCode?: string;
  note?: string;
}

/** One run of Allow: which steps it shows, which were already set up, which finished, and what each one made. */
export interface ConnectRun {
  steps: ConnectStep[];
  /** set up before (the key exists or is delegated; the pocket already holds the budget): "Already set up" */
  skipped: ConnectStep[];
  done: ConnectStep[];
  /** /api/me nextPocketIndex: each AI gets its own pocket, never reused */
  pocketIndex: number;
  /** /api/config routers, in signing order */
  routers: string[];
  withDrip: boolean;
  assistant?: string;
  pocket?: string;
  approval?: string;
  /** unix seconds the permission was signed to end at: the grant is registered with the same one */
  validUntil?: number;
  grantId?: string;
  /** a stopped run's money was taken back from the failure panel: these dollars are back in the account */
  tookBack?: number;
}

export type ConnectState =
  | { step: "form"; lane: ConnectLane; terms: ConnectTerms; banner?: string }
  /** Allow was tapped: the server's health, /api/me and /api/config are read before anything moves */
  | { step: "confirming"; lane: ConnectLane; terms: ConnectTerms; withDrip: boolean }
  /** "Confirm it's you": a fresh code, needed when the key must be delegated and no confirm this session holds the
   *  scope (a sign-in never grants it, so the first Connect always asks). via
   *  passkey: the account has one, so Dynamic wants it instead of a code ("sent": waiting for the person's tap; a
   *  passkey that did not confirm says why in passkeyMessage) */
  | { step: "stepUp"; lane: ConnectLane; terms: ConnectTerms; run: ConnectRun; code: "sending" | "sent" | "verifying"; via?: "passkey"; sentAt?: number; problem?: CodeProblem; passkeyMessage?: string }
  /** waitingSince: the first 409 "not delegated yet" of this registering */
  | { step: "running"; lane: ConnectLane; terms: ConnectTerms; run: ConnectRun; at: ConnectStep; startedAt: number; waitingSince?: number }
  | { step: "failed"; lane: ConnectLane; terms: ConnectTerms; run: ConnectRun; at: ConnectStep; problem: ConnectProblem }
  /** linkFailed: connected, but its in-app link did not come (the done screen asks for it again) */
  | { step: "done"; lane: ConnectLane; terms: ConnectTerms; run: ConnectRun; grantId: string; connector?: ConnectorLink; redirect?: string; linkFailed?: boolean }
  /** the OAuth request ended before anything moved */
  | { step: "ended" }
  | { step: "denying"; lane: ConnectLane; terms: ConnectTerms }
  | { step: "denied"; redirect?: string };

export type ConnectEvent =
  | { type: "edit"; patch: Partial<ConnectTerms> }
  | { type: "allow"; check: TermsCheck }
  /** GET {server}/health failed before anything moved */
  | { type: "offline" }
  | { type: "checked"; delegated: boolean; hasAssistant: boolean; canDelegate: boolean; pocketIndex: number; routers: string[]; at: number }
  | { type: "codeSent"; at: number }
  /** the account has a passkey: no code went out, the person confirms with the passkey */
  | { type: "passkeyAsk" }
  /** a code, or "" for the passkey */
  | { type: "verify"; code: string }
  | { type: "codeRejected"; problem: CodeProblem }
  /** the passkey's dialog closed or failed: why, in the sheet's words */
  | { type: "passkeyRejected"; message: string }
  | { type: "codeOk"; at: number }
  | { type: "resend" }
  /** the person left the code step, or the code could not be sent (banner: why) */
  | { type: "cancel"; banner?: string }
  /** delegating found no scope held (a sign-in never grants it, a "Confirm it's you" does) */
  | { type: "needStepUp" }
  | { type: "assistantReady"; address: string; at: number }
  | { type: "delegated"; at: number }
  | { type: "permissionSigned"; pocket: string; approval: string; pocketBalance: number; at: number; validUntil?: number }
  | { type: "funded"; at: number }
  | { type: "notYet"; at: number }
  /** in-app: the connection exists (POST /api/grants answered); the same step then asks only for its link, so a
   *  retry never makes a second connection */
  | { type: "created"; grantId: string }
  | { type: "registered"; grantId: string; connector?: ConnectorLink; linkFailed?: boolean; at: number }
  /** the done screen asked for the link again and got it */
  | { type: "linkReady"; connector: ConnectorLink }
  | { type: "approved"; redirect: string }
  | { type: "stepFailed"; problem: ConnectProblem }
  | { type: "requestExpired" }
  | { type: "retry"; at: number }
  /** a stopped run: the person took the pocket's money back from the failure panel (moved: what came back) */
  | { type: "tookBack"; moved: number }
  /** a stopped run: back to the form with the same terms, so Allow runs every step again (a new permission, then
   *  the money moved in again) */
  | { type: "startAgain" }
  /** the connector link was shown; it never shows again */
  | { type: "hideLink" }
  | { type: "deny" }
  | { type: "deniedDone"; redirect?: string };

export const connectStart = (lane: ConnectLane, label: string): ConnectState => ({ step: "form", lane, terms: defaultTerms(label) });

/** The run's next step after `after` (or its first) that is neither skipped nor done. */
export function nextConnectStep(run: ConnectRun, after: ConnectStep | null): ConnectStep | null {
  const from = after === null ? 0 : run.steps.indexOf(after) + 1;
  return run.steps.slice(from).find((x) => !run.skipped.includes(x) && !run.done.includes(x)) ?? null;
}

type Running = Extract<ConnectState, { step: "running" }>;

/** Finish the running step and move to the next one. */
function advance(s: Running, run: ConnectRun, at: number): ConnectState {
  const finished: ConnectRun = { ...run, done: [...run.done, s.at] };
  // registering is never skipped, and the last step (registering in-app, approving for OAuth) ends the run on its
  // own event, so a next step always exists here
  const next = nextConnectStep(finished, s.at) ?? s.at;
  return { step: "running", lane: s.lane, terms: s.terms, run: finished, at: next, startedAt: at };
}

/** Whether the connect page may be left or its sheet closed: not while a step runs (a beforeunload guard holds it). */
export function connectDismissable(s: ConnectState) {
  return s.step === "form" || s.step === "failed" || s.step === "done" || s.step === "ended" || s.step === "denied";
}

/** Each shown step's mark, for the Steps list. Registering and approving share the last row on screen. */
export function connectMarks(s: ConnectState): { step: ConnectStep; mark: StepMark }[] {
  if (!("run" in s)) return [];
  const { run } = s;
  const now = s.step === "running" || s.step === "failed" ? s.at : s.step === "stepUp" ? nextConnectStep(run, null) : null;
  return run.steps.map((step) => {
    if (run.skipped.includes(step)) return { step, mark: "skipped" };
    if (run.done.includes(step) || s.step === "done") return { step, mark: "done" };
    if (step === now) return { step, mark: s.step === "failed" ? "failed" : "current" };
    return { step, mark: "waiting" };
  });
}

/** Whether a stopped run already moved the budget into the pocket (the copy offers Take back then). */
export const connectFunded = (s: ConnectState) => "run" in s && (s.run.done.includes("funding") || s.run.skipped.includes("funding"));

export function connectReducer(s: ConnectState, e: ConnectEvent): ConnectState {
  switch (e.type) {
    case "edit":
      return s.step === "form" ? { step: "form", lane: s.lane, terms: { ...s.terms, ...e.patch } } : s;
    case "allow":
      return s.step === "form" && e.check.ok ? { step: "confirming", lane: s.lane, terms: s.terms, withDrip: e.check.withDrip } : s;
    case "offline":
      if (s.step === "confirming" || s.step === "denying") return { step: "form", lane: s.lane, terms: s.terms, banner: CONNECT_COPY.offline };
      return s;
    case "checked": {
      if (s.step !== "confirming") return s;
      const skipped: ConnectStep[] = e.delegated ? ["assistant", "delegate"] : e.hasAssistant ? ["assistant"] : [];
      const steps = s.lane === "oauth" ? [...CONNECT_STEPS] : CONNECT_STEPS.filter((x) => x !== "approving");
      const run: ConnectRun = { steps, skipped, done: [], pocketIndex: e.pocketIndex, routers: e.routers, withDrip: s.withDrip };
      if (!e.delegated && !e.canDelegate) return { step: "stepUp", lane: s.lane, terms: s.terms, run, code: "sending" };
      return { step: "running", lane: s.lane, terms: s.terms, run, at: nextConnectStep(run, null)!, startedAt: e.at };
    }
    case "needStepUp":
      return s.step === "running" && s.at === "delegate" ? { step: "stepUp", lane: s.lane, terms: s.terms, run: s.run, code: "sending" } : s;
    case "codeSent":
      return s.step === "stepUp" && s.code === "sending" ? { ...s, code: "sent", sentAt: e.at, problem: undefined } : s;
    case "passkeyAsk":
      return s.step === "stepUp" && s.code === "sending" ? { ...s, code: "sent", via: "passkey", problem: undefined } : s;
    case "verify":
      if (s.step !== "stepUp" || s.code !== "sent") return s;
      return s.via === "passkey" || isCode(e.code) ? { ...s, code: "verifying", problem: undefined, passkeyMessage: undefined } : { ...s, problem: "wrong" };
    case "codeRejected":
      return s.step === "stepUp" && s.code === "verifying" && s.via !== "passkey" ? { ...s, code: "sent", problem: e.problem } : s;
    case "passkeyRejected":
      return s.step === "stepUp" && s.code === "verifying" && s.via === "passkey" ? { ...s, code: "sent", passkeyMessage: e.message } : s;
    case "codeOk":
      return s.step === "stepUp" && s.code === "verifying" ? { step: "running", lane: s.lane, terms: s.terms, run: s.run, at: nextConnectStep(s.run, null)!, startedAt: e.at } : s;
    case "resend":
      return s.step === "stepUp" && s.code === "sent" && s.via !== "passkey" ? { ...s, code: "sending", problem: undefined } : s;
    case "cancel":
      return s.step === "stepUp" ? { step: "form", lane: s.lane, terms: s.terms, banner: e.banner ?? CONNECT_COPY.stepUpCancelled } : s;
    case "assistantReady":
      return s.step === "running" && s.at === "assistant" ? advance(s, { ...s.run, assistant: e.address }, e.at) : s;
    case "delegated":
      return s.step === "running" && s.at === "delegate" ? advance(s, s.run, e.at) : s;
    case "permissionSigned": {
      if (s.step !== "running" || s.at !== "permission") return s;
      const full = e.pocketBalance >= s.terms.budget;
      return advance(s, { ...s.run, pocket: e.pocket, approval: e.approval, validUntil: e.validUntil ?? s.run.validUntil, skipped: full ? [...s.run.skipped, "funding"] : s.run.skipped }, e.at);
    }
    case "funded":
      return s.step === "running" && s.at === "funding" ? advance(s, s.run, e.at) : s;
    case "notYet": {
      if (s.step !== "running" || s.at !== "registering") return s;
      const since = s.waitingSince ?? e.at;
      if (e.at - since >= NOT_YET_PATIENCE_MS) return { step: "failed", lane: s.lane, terms: s.terms, run: s.run, at: s.at, problem: "notYet" };
      return { ...s, waitingSince: since };
    }
    case "created":
      if (s.step !== "running" || s.at !== "registering" || s.run.grantId) return s;
      return { step: "running", lane: s.lane, terms: s.terms, run: { ...s.run, grantId: e.grantId }, at: s.at, startedAt: s.startedAt };
    case "registered": {
      if (s.step !== "running" || s.at !== "registering") return s;
      const run: ConnectRun = { ...s.run, grantId: e.grantId };
      if (s.lane === "oauth") return advance(s, run, e.at);
      const done: ConnectState = { step: "done", lane: s.lane, terms: s.terms, run: { ...run, done: [...run.done, "registering"] }, grantId: e.grantId, connector: e.connector };
      return e.linkFailed && !e.connector ? { ...done, linkFailed: true } : done;
    }
    case "linkReady":
      return s.step === "done" && s.linkFailed ? { ...s, connector: e.connector, linkFailed: undefined } : s;
    case "approved":
      if (s.step !== "running" || s.at !== "approving" || !s.run.grantId) return s;
      return { step: "done", lane: s.lane, terms: s.terms, run: { ...s.run, done: [...s.run.done, "approving"] }, grantId: s.run.grantId, redirect: e.redirect };
    case "stepFailed":
      if (s.step === "running") return { step: "failed", lane: s.lane, terms: s.terms, run: s.run, at: s.at, problem: e.problem };
      if (s.step === "stepUp") return { step: "failed", lane: s.lane, terms: s.terms, run: s.run, at: nextConnectStep(s.run, null) ?? "delegate", problem: e.problem };
      return s;
    case "requestExpired":
      if (s.step === "form" || s.step === "confirming") return { step: "ended" };
      if (s.step === "running" || s.step === "stepUp") return { step: "failed", lane: s.lane, terms: s.terms, run: s.run, at: s.step === "running" ? s.at : (nextConnectStep(s.run, null) ?? "delegate"), problem: "expired" };
      if (s.step === "failed") return { ...s, problem: "expired" };
      return s;
    case "retry":
      if (s.step !== "failed" || s.problem === "expired") return s;
      // a pocket another AI uses: read /api/me again for the next index
      if (s.problem === "pocketInUse") return { step: "confirming", lane: s.lane, terms: s.terms, withDrip: s.run.withDrip };
      // the money was taken back: never resume past funding with an empty pocket (Start again runs it all again)
      if (s.run.tookBack !== undefined) return s;
      // resumes at the step that stopped; funding already done is never run again
      return { step: "running", lane: s.lane, terms: s.terms, run: s.run, at: s.at, startedAt: e.at };
    case "tookBack": {
      if (s.step !== "failed" || !connectFunded(s)) return s;
      const drop = (list: ConnectStep[]) => list.filter((x) => x !== "funding");
      return { ...s, run: { ...s.run, done: drop(s.run.done), skipped: drop(s.run.skipped), tookBack: e.moved } };
    }
    case "startAgain":
      return s.step === "failed" && s.problem !== "expired" ? { step: "form", lane: s.lane, terms: s.terms } : s;
    case "hideLink":
      return s.step === "done" && s.connector ? { ...s, connector: undefined } : s;
    case "deny":
      return s.step === "form" ? { step: "denying", lane: s.lane, terms: s.terms } : s;
    case "deniedDone":
      return s.step === "denying" ? { step: "denied", redirect: e.redirect } : s;
  }
}

// =====================================================================================================================
// DISCONNECT (spec 3.4, 10.5): stop the AI, switch the key off only when it was the last active AI, and by default
// take the pocket's dollars home (its positions stay in the pocket)
// =====================================================================================================================

/** What the sheet knows going in: the toggle, whether no other AI is active, and the pocket's dollars. */
export interface DisconnectCtx {
  takeBack: boolean;
  lastActive: boolean;
  balance: number;
}

export type DisconnectState =
  | ({ step: "confirm" } & DisconnectCtx)
  | ({ step: "stopping" } & DisconnectCtx)
  /** serverMissed: the stop did not reach the server, but this was the last AI, so switching the key off still stops it */
  | ({ step: "revoking"; serverMissed: boolean } & DisconnectCtx)
  | ({ step: "takingBack"; serverMissed: boolean } & DisconnectCtx)
  | { step: "done"; tookBack: boolean; amount: number; serverMissed: boolean }
  | ({ step: "failed"; at: DisconnectAt; serverMissed: boolean } & DisconnectCtx)
  | { step: "closed" };

export type DisconnectEvent =
  | { type: "toggleTakeBack" }
  | { type: "confirm" }
  | { type: "keep" }
  | { type: "stopped" }
  | { type: "stopFailed" }
  | { type: "revoked" }
  | { type: "revokeFailed" }
  | { type: "tookBack" }
  | { type: "takeBackFailed" }
  | { type: "retry" }
  | { type: "close" };

/** Disconnect sweeps the pocket home by default. */
export const disconnectStart = (lastActive: boolean, balance: number): DisconnectState => ({ step: "confirm", takeBack: true, lastActive, balance });

const ctxOf = (s: DisconnectCtx): DisconnectCtx => ({ takeBack: s.takeBack, lastActive: s.lastActive, balance: s.balance });
const sweeps = (c: DisconnectCtx) => c.takeBack && c.balance > 0;

/** After the stop (or the key switched off): take the money back, or finish. */
function afterKeyOff(c: DisconnectCtx, serverMissed: boolean): DisconnectState {
  return sweeps(c) ? { step: "takingBack", serverMissed, ...ctxOf(c) } : { step: "done", tookBack: false, amount: c.balance, serverMissed };
}

export function disconnectDismissable(s: DisconnectState) {
  return s.step === "confirm" || s.step === "done" || s.step === "failed" || s.step === "closed";
}

/** The steps this disconnect shows: the key row only for the last active AI, the money row only when it moves. */
export function disconnectSteps(c: DisconnectCtx): DisconnectAt[] {
  return ["stopping", ...(c.lastActive ? (["revoking"] as const) : []), ...(sweeps(c) ? (["takingBack"] as const) : [])];
}

export function disconnectReducer(s: DisconnectState, e: DisconnectEvent): DisconnectState {
  switch (e.type) {
    case "toggleTakeBack":
      return s.step === "confirm" ? { ...s, takeBack: !s.takeBack } : s;
    case "confirm":
      return s.step === "confirm" ? { step: "stopping", ...ctxOf(s) } : s;
    case "keep":
      return s.step === "confirm" ? { step: "closed" } : s;
    case "stopped":
      if (s.step !== "stopping") return s;
      return s.lastActive ? { step: "revoking", serverMissed: false, ...ctxOf(s) } : afterKeyOff(s, false);
    case "stopFailed":
      if (s.step !== "stopping") return s;
      // the last AI: switch the key off anyway, the safety step is Dynamic's; with others active the key must stay on
      return s.lastActive ? { step: "revoking", serverMissed: true, ...ctxOf(s) } : { step: "failed", at: "stopping", serverMissed: true, ...ctxOf(s) };
    case "revoked":
      return s.step === "revoking" ? afterKeyOff(s, s.serverMissed) : s;
    case "revokeFailed":
      return s.step === "revoking" ? { step: "failed", at: "revoking", serverMissed: s.serverMissed, ...ctxOf(s) } : s;
    case "tookBack":
      return s.step === "takingBack" ? { step: "done", tookBack: true, amount: s.balance, serverMissed: s.serverMissed } : s;
    case "takeBackFailed":
      return s.step === "takingBack" ? { step: "failed", at: "takingBack", serverMissed: s.serverMissed, ...ctxOf(s) } : s;
    case "retry":
      if (s.step !== "failed") return s;
      if (s.at === "stopping") return { step: "stopping", ...ctxOf(s) };
      if (s.at === "revoking") return { step: "revoking", serverMissed: s.serverMissed, ...ctxOf(s) };
      return { step: "takingBack", serverMissed: s.serverMissed, ...ctxOf(s) };
    case "close":
      return s.step !== "closed" && disconnectDismissable(s) ? { step: "closed" } : s;
  }
}

// =====================================================================================================================
// APPROVAL (spec 10.6): an AI asked to go over its limit; the person reviews it and it runs from the main account
// =====================================================================================================================

export type ApprovalStatus = "pending" | "approved" | "denied" | "done" | "failed" | "expired";

/** GET /api/approvals, one row. params are the MCP tool's arguments; expiresAt in ms. */
export interface ApprovalView {
  id: string;
  grantId: string;
  action: string;
  params: Record<string, unknown>;
  summary: Record<string, unknown>;
  note: string | null;
  status: ApprovalStatus;
  expiresAt: number;
  /** an approval its AI ended before it was answered says why (server/API.md): "the AI was disconnected" or "the AI's
   *  permission ended"; a plain 15-minute expiry has none. One that ran keeps its trade (txHash, userOpHash). */
  result?: { reason?: string; txHash?: string; userOpHash?: string } | null;
}

export const APPROVAL_ENDED_BY = { disconnected: "the AI was disconnected", ended: "the AI's permission ended" } as const;

/** Done and failed are still accepted this long after the approval expired, for a trade started just before. */
export const APPROVAL_REPORT_GRACE_MS = 15 * 60_000;

export type ApprovalState =
  | { step: "loading"; id: string; message?: string }
  | { step: "notFound"; id: string }
  | { step: "review"; approval: ApprovalView; message?: string }
  /** a close_short: decline only, until the pocket-side close is settled */
  | { step: "later"; approval: ApprovalView; message?: string }
  /** the trade machine runs from the main account */
  | { step: "sending"; approval: ApprovalView }
  /** reported: POST /done went through */
  | { step: "done"; approval: ApprovalView; txHash: string; userOpHash: string | null; reported: boolean }
  /** reported: POST /failed went through (only for a final outcome, so the server's answer stands) */
  | { step: "failed"; approval: ApprovalView; message: string; reported: boolean; outcome: ApprovalFailure }
  | { step: "declining"; approval: ApprovalView; from: "review" | "later" }
  | { step: "declined"; approval: ApprovalView }
  | { step: "expired"; approval: ApprovalView | null }
  /** done, failed or declined before this page opened */
  | { step: "answered"; approval: ApprovalView };

/** How a failed approval ended: "retry" (nothing sent, it can be approved again), "final" (it landed and reverted:
 *  Agate is told it failed), "unconfirmed" (sent, not seen landing: never sent twice, never reported as failed). */
export type ApprovalFailure = "retry" | "final" | "unconfirmed";

export type ApprovalEvent =
  | { type: "loaded"; approvals: ApprovalView[]; now: number }
  | { type: "loadFailed"; message: string }
  | { type: "tick"; now: number }
  | { type: "approve"; now: number }
  /** the trade machine went back to the card, with why when nothing was sent (funds, a moved price, the network...) */
  | { type: "back"; message?: string }
  | { type: "traded"; txHash: string; userOpHash: string | null }
  | { type: "tradeFailed"; message: string; outcome?: ApprovalFailure }
  /** the server took /done or /failed; its answer, when there is one */
  | { type: "reported"; approval?: ApprovalView }
  | { type: "decline" }
  | { type: "declined" }
  | { type: "declineFailed"; message: string }
  | { type: "retry"; now: number }
  /** the AI was disconnected or its permission ended: a request still waiting ends with it */
  | { type: "grantEnded" };

export const approvalStart = (id: string): ApprovalState => ({ step: "loading", id });

/** Whether the server still takes /done or /failed for it. */
export function canReport(a: ApprovalView, now: number) {
  if (a.status === "approved") return true;
  return (a.status === "pending" || a.status === "expired") && now < a.expiresAt + APPROVAL_REPORT_GRACE_MS;
}

/** Whether it can still be approved or declined. */
export const approvalOpen = (a: ApprovalView, now: number) => a.status === "approved" || (a.status === "pending" && now < a.expiresAt);

/** The approval's trade as an Order for the main account, from the MCP tool's arguments; null for what the app does
 *  not run (close_short waits for the pocket-side answer). Shorts default to pay me daily, as the tool does. */
export function approvalOrder(a: ApprovalView): Order | null {
  const p = a.params;
  const gpu = p.gpu as Extract<Order, { gpu: unknown }>["gpu"];
  const month = typeof p.month === "string" ? p.month : "";
  if (typeof gpu !== "string" || !/^\d{4}-\d{2}$/.test(month)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  if (a.action === "open_long" || a.action === "open_long_daily") {
    const dollars = num(p.dollars);
    if (dollars === null) return null;
    const maxPrice = num(p.max_price);
    const base = { gpu, month, dollars: floorCents(dollars).toFixed(2), ...(maxPrice !== null ? { maxPrice: String(maxPrice) } : {}) };
    return a.action === "open_long_daily" || p.pay_me_daily === true ? { kind: "openLongDaily", ...base, parts: 1 } : { kind: "buyLong", ...base };
  }
  if (a.action === "open_short") {
    const hours = num(p.gpu_hours);
    if (hours === null) return null;
    const minPrice = num(p.min_price);
    return { kind: "openShort", gpu, month, gpuHours: floorHours(hours).toFixed(4), parts: 1, daily: p.pay_me_daily !== false, ...(minPrice !== null ? { minPrice: String(minPrice) } : {}) };
  }
  return null;
}

function opened(a: ApprovalView, now: number): ApprovalState {
  if (a.status === "done" || a.status === "failed" || a.status === "denied") return { step: "answered", approval: a };
  if (!approvalOpen(a, now)) return { step: "expired", approval: a };
  return a.action === "close_short" ? { step: "later", approval: a } : { step: "review", approval: a };
}

export function approvalReducer(s: ApprovalState, e: ApprovalEvent): ApprovalState {
  switch (e.type) {
    case "loaded": {
      if (s.step !== "loading") return s;
      const a = e.approvals.find((x) => x.id === s.id);
      return a ? opened(a, e.now) : { step: "notFound", id: s.id };
    }
    case "loadFailed":
      return s.step === "loading" ? { ...s, message: e.message } : s;
    case "tick":
      return (s.step === "review" || s.step === "later") && !approvalOpen(s.approval, e.now) ? { step: "expired", approval: s.approval } : s;
    case "grantEnded":
      return s.step === "review" || s.step === "later" ? { step: "expired", approval: s.approval } : s;
    case "approve":
      if (s.step !== "review") return s;
      return approvalOpen(s.approval, e.now) ? { step: "sending", approval: s.approval } : { step: "expired", approval: s.approval };
    case "back":
      if (s.step !== "sending") return s;
      return e.message ? { step: "review", approval: s.approval, message: e.message } : { step: "review", approval: s.approval };
    case "traded":
      return s.step === "sending" ? { step: "done", approval: s.approval, txHash: e.txHash, userOpHash: e.userOpHash, reported: false } : s;
    case "tradeFailed":
      return s.step === "sending" ? { step: "failed", approval: s.approval, message: e.message, reported: false, outcome: e.outcome ?? "retry" } : s;
    case "reported":
      return (s.step === "done" || s.step === "failed") && !s.reported ? { ...s, reported: true, approval: e.approval ?? s.approval } : s;
    case "decline":
      return s.step === "review" || s.step === "later" ? { step: "declining", approval: s.approval, from: s.step } : s;
    case "declined":
      return s.step === "declining" ? { step: "declined", approval: s.approval } : s;
    case "declineFailed":
      return s.step === "declining" ? { step: s.from, approval: s.approval, message: e.message } : s;
    case "retry":
      if (s.step !== "failed") return s;
      // Agate already holds it as failed: it can't run again from this request
      if (s.reported) return { step: "answered", approval: { ...s.approval, status: "failed" } };
      if (s.outcome !== "retry") return s;
      return approvalOpen(s.approval, e.now) ? { step: "review", approval: s.approval } : { step: "expired", approval: s.approval };
  }
}
