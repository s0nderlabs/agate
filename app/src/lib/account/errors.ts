// Every refusal the account can meet, as the sheet to show and its plain copy (wallet spec 6.9, 5.4, 4, 9.6, 10.4,
// 10.5 and the server contract). Errors are matched by name, reason, stage, code, status and message, never by
// instanceof: @agate/client, viem and Dynamic's SDK may each load their own copy of a class. Pure: nothing here
// throws, fetches or touches React. Every line says whether anything moved.
import { monthLong, whenText } from "@/lib/data/derive";
import { usd, usd0 } from "@/lib/format";
import { showHours } from "@/lib/size";
import { type CodeProblem, DRIP, type LimitOrder, type Order } from "./types";

/** A trade's quote now, as a refused plan found it (@agate/client's WriteError.quote, FreshQuote). */
export interface FreshQuote {
  gpuHours: number;
  dollars: number;
  avgPrice: number;
}

/** Which trade a refusal is about: the copy differs for a buy, a Short, a sale and the two closes. */
export type TradeKind = "buy" | "short" | "sale" | "closeDaily" | "closeShort" | "drip";

export function tradeKindOf(order: Order): TradeKind {
  switch (order.kind) {
    case "buyLong":
    case "openLongDaily":
      return "buy";
    case "openShort":
      return "short";
    case "sellLong":
      return "sale";
    case "closeLongDaily":
      return "closeDaily";
    case "closeShort":
      return "closeShort";
    case "drip":
      return "drip";
  }
}

/** Where a refusal sends the person (the trade machine reads this). */
export type RefusalSheet =
  /** back to the ticket, with the message under it */
  | "ticket"
  /** the Get test dollars sheet */
  | "funds"
  /** "Only part of this fills right now", with the quote */
  | "thin"
  /** "The price moved", with the quote */
  | "moved"
  /** one message and one action */
  | "failed"
  /** the sign-in sheet, the trade kept */
  | "signin"
  /** back to Review, with the message */
  | "review"
  /** plan again once, quietly (the bundler's simulation reverted) */
  | "replan"
  /** send again once after a second, inside the lock (AA25, a nonce race) */
  | "resend"
  /** sent, waiting for Monad: never offer a resend */
  | "pending"
  /** the next-drip line (DripTooSoon) */
  | "drip";

export type RefusalAction = "retry" | "back" | "funds" | "recheck" | "signin" | "none";

export interface Refusal {
  sheet: RefusalSheet;
  message: string;
  action: RefusalAction;
  /** true when we know nothing left the account (the copy says so too) */
  nothingSent: boolean;
  quote?: FreshQuote;
  /** DripTooSoon: when the next drip opens (ISO) */
  nextAt?: string;
  /** read the wallet again before showing the message (InsufficientTokens) */
  refresh?: boolean;
  /** a short name of what was matched, for logs and tests (a WriteError reason, "paymaster", "network", ...) */
  reason: string;
}

/** Every WriteError reason @agate/client throws (writes.ts and plan.ts). Stages simulate, estimate and send carry a
 *  revert name instead, and some check-stage refusals carry none: those are matched by stage and message. */
export const WRITE_REASONS = [
  "ThinBook",
  "PriceMoved",
  "InsufficientBalance",
  "InsufficientTokens",
  "AboveBand",
  "BelowBand",
  "EmptyBook",
  "Depth",
  "DripTooSoon",
  "MonthNotFinal",
  "PostOnlyError",
  "NoReceipt",
  "reverted",
] as const;
export type WriteReason = (typeof WRITE_REASONS)[number];

// ===== the copy =====

const M = (month: string | undefined) => (month && monthLong(month)) || "this month";
/** A month at the start of a sentence. */
const Cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const COPY = {
  // planning: the ticket's inline lines
  amountZero: "Enter an amount above 0.",
  amountStep: "Use a size in steps of 0.0001 GPU-hours.",
  amountCheck: "Check the amount and try again.",
  partsTooSmall: "This amount is too small for daily payouts. Try a larger amount.",
  tooSmallToBuy: "This amount is too small to buy any GPU-hours. Try a larger amount.",
  limitSize: "A limit order is 1 to 1,000,000 GPU-hours.",
  priceStep: "Use a price in whole cents, like $3.95.",
  outsideBand: (month: string) => `That price is outside what ${month} can still pay.`,
  postOnly: "This price would fill right away. Set it past the best price, or use Market.",
  // limit orders (Pro, the real account): the line under the button
  limitFunds: "This order needs more test dollars than your account holds. Nothing was sent.",
  orderGone: "This order already filled or was canceled. Nothing was sent.",
  nothingAtKuru: "Nothing is waiting at Kuru to move. Nothing was sent.",
  limitLanded: "The book moved before your order landed, so it wasn't placed. Nothing changed.",
  cancelLanded: "This order changed before the cancel landed. Nothing changed.",
  withdrawLanded: "It didn't go through on Monad. Nothing moved. Try again.",
  limitBusy: "Another order is on its way. Try this again once it lands.",
  redeemLater: "They stay as a Long and a Short until the month ends, which pays both back in full.",
  otherMonth: "Pick a different month to move into.",
  // planning: sheets
  funds: "This trade needs more test dollars than your account holds. Nothing was sent.",
  tokensShort: "You hold fewer GPU-hours than this. Your positions were refreshed.",
  aboveBandBuy: (month: string) => `At these prices this trade can only lose: the asks are above what ${month} can pay. Nothing was sent.`,
  aboveBandCloseShort: (month: string) => `Buying back costs more than ${month} can pay, so holding the Short pays more. Nothing was sent.`,
  belowBand: (month: string) => `At these prices this trade can only lose: the bids are below the least ${month} will pay. Nothing was sent.`,
  emptyBook: (month: string) => `No one is selling ${month} right now. Nothing was sent.`,
  depthShort: "The book can't take this size right now. Try a smaller amount.",
  depthCloseLong: "The book can't take all of it right now. Try a smaller part later, or hold to the month's end.",
  depthCloseShort: "Not enough sellers to buy this back right now.",
  monthNotOpen: (month: string) => `${Cap(month)} isn't open for trading yet.`,
  monthNotFinal: (month: string) => `${Cap(month)} settles once every day is final. Nothing was sent.`,
  notHere: "This position can't be closed here.",
  pickPosition: "Pick a position to close.",
  nothingToClaim: "Nothing to claim yet. Agate pays each day by itself, about 07:00 UTC.",
  nothingToSettle: "Nothing to settle yet.",
  salePaysNothing: "At today's bids this sale would pay nothing. Nothing was sent.",
  bookMoved: "The book moved while we checked. Try again.",
  network: "Can't reach Monad's test network right now. Nothing was sent.",
  unchecked: "This trade couldn't be checked. Nothing was sent.",
  // sending
  sessionTrade: "Your sign-in has expired. Sign in again to finish this trade.",
  cantSign: "Your wallet couldn't sign. Nothing was sent. Try again.",
  signingOffline: " Agate's signing check is offline.",
  fee: "Agate couldn't pay the network fee this time. Nothing was sent. Try again in a minute.",
  turnedDown: "Monad turned this trade down before it was sent. Nothing changed.",
  sendNetwork: "Can't reach the network right now. Nothing was sent.",
  sendGeneric: "Your trade didn't go out. Nothing was sent. Try again.",
  // the receipt
  landedMoved: "The price moved before your trade landed. Nothing changed.",
  pending: "Your order was sent but Monad hasn't confirmed it yet. Check your positions before trying again.",
  // test dollars (DripButton, Funds)
  dripNext: (iso: string) => `Next ${DRIP.toLocaleString("en-US")} on ${whenText(iso)}`,
  dripArrive: (iso: string) => `Your next ${DRIP.toLocaleString("en-US")} test dollars arrive ${whenText(iso)}.`,
  dripFee: "Agate couldn't pay the network fee right now. Nothing was sent. Try again in a minute.",
  dripNoPayout: "The faucet didn't pay out. Nothing moved. Try again.",
  dripPending: "Sent, waiting for Monad. Your test dollars show up once it lands.",
  dripNetwork: "Can't reach Monad's test network right now. Nothing was sent.",
} as const;

/** Sign-in lines (spec 4): the email step, the code step and setting up. */
export const SIGNIN_COPY = {
  badEmail: "Enter an email like you@example.com.",
  rateLimited: "Too many codes asked for in a short time. Wait a minute, then try again.",
  service: "Can't reach the sign-in service right now. Check your connection and try again.",
  init: "Sign in could not start. Check your connection and try again.",
  notSetUp: "Sign in is not set up on this build.",
  google: "Google sign-in didn't finish. Try again, or use your email.",
  passkey: "Passkey sign-in didn't finish. Try again, or use your email.",
  passkeyStopped: "No passkey signed you in. New here? Start once with Google or an email code; right after, you can add a passkey and use only that from then on.",
  passkeyUnknown: "That passkey isn't on an Agate account anymore. Sign in with your email or Google.",
  passkeyUnsupported: "This browser can't use passkeys. Sign in with your email.",
  addPasskey: "Couldn't add a passkey. Try again.",
  addPasskeyStopped: "No passkey was added.",
  addPasskeyExists: "This device already has a passkey for your account.",
  wrong: "That code doesn't match. Check the newest email from Agate and try again.",
  expired: "That code has expired.",
  tooMany: "Too many tries with this code. Send a new one.",
  network: "Can't check the code right now. Try again.",
  resent: "We sent a new code. The one before no longer works.",
  slow: "Taking longer than usual. Still working, keep this open.",
  walletFailed: "We couldn't finish making your wallet. Nothing was charged.",
  dripFailed: "Your test dollars didn't arrive yet.",
  sessionEnded: "Your session ended. Sign in again.",
} as const;

export const thinText = (month: string | undefined, q: FreshQuote) =>
  `At prices ${M(month)} can still pay, the book holds ${usd(q.dollars)} (${showHours(q.gpuHours)} GPU-hours). The rest would buy above that.`;

export function movedText(kind: TradeKind, q: FreshQuote) {
  if (kind === "buy") return `It now fills ${showHours(q.gpuHours)} GPU-hours at ${usd(q.avgPrice)} on average for ${usd(q.dollars)}.`;
  if (kind === "closeShort") return `Buying back now costs ${usd(q.dollars)}.`;
  return `It now sells for ${usd(q.dollars)}, ${usd(q.avgPrice)} each.`;
}

// ===== matching =====

interface ErrLike {
  name?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  reason?: unknown;
  stage?: unknown;
  quote?: unknown;
  code?: unknown;
  status?: unknown;
  cause?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The error and its causes, outermost first. */
function chain(e: unknown): ErrLike[] {
  const out: ErrLike[] = [];
  let x: unknown = e;
  for (let i = 0; i < 12 && x !== null && typeof x === "object" && !out.includes(x as ErrLike); i++) {
    out.push(x as ErrLike);
    x = (x as ErrLike).cause;
  }
  if (out.length === 0 && typeof e === "string") out.push({ message: e });
  return out;
}

/** A message without viem's "Request Arguments:" block and what follows it: a sponsored user operation prints
 *  `paymaster: 0x...` there, which would read as a fee failure for every error it carries. */
const ownWords = (v: unknown) => str(v).replace(/Request Arguments:[\s\S]*/, "").trim();

/** Every name, code and message along the chain, for pattern checks. */
function haystack(e: unknown) {
  return chain(e)
    .flatMap((x) => [str(x.name), str(x.code), ownWords(x.message), ownWords(x.shortMessage), str(x.details)])
    .filter(Boolean)
    .join(" | ");
}

const hasName = (e: unknown, re: RegExp) => chain(e).some((x) => re.test(str(x.name)));
const statusOf = (e: unknown) => chain(e).map((x) => x.status).find((s): s is number => typeof s === "number");
/** Dynamic's API refused the session (its APIError with 401); a bundler's 401 is not a session that ended. */
const sessionRefused = (e: unknown) => chain(e).some((x) => x.status === 401 && str(x.name) === "APIError");

function quoteOf(v: unknown): FreshQuote | undefined {
  const q = v as Partial<FreshQuote> | null | undefined;
  if (!q || typeof q !== "object") return undefined;
  const ok = [q.gpuHours, q.dollars, q.avgPrice].every((n) => typeof n === "number" && Number.isFinite(n));
  return ok ? { gpuHours: q.gpuHours!, dollars: q.dollars!, avgPrice: q.avgPrice! } : undefined;
}

const NETWORK = /failed to fetch|fetch failed|networkerror|network error|network request failed|load failed|econn(refused|reset)|enotfound|socket hang up|offline/i;

/** A transport failure: the request never got an answer. */
export function isNetworkError(e: unknown) {
  return hasName(e, /^(HttpRequestError|TimeoutError|FetchError|WebSocketRequestError|SocketClosedError)$/) || NETWORK.test(haystack(e));
}

const fail = (reason: string, message: string, action: RefusalAction, extra: Partial<Refusal> = {}): Refusal => ({ sheet: "failed", message, action, nothingSent: true, reason, ...extra });
const ticket = (reason: string, message: string): Refusal => ({ sheet: "ticket", message, action: "back", nothingSent: true, reason });

// ===== planning (spec 6.9 "Planning") =====

/** A refused plan: what the client's plan builders threw. Nothing was sent in any of these. */
export function refusalOf(e: unknown, ctx: { kind: TradeKind; month?: string }): Refusal {
  const x = chain(e)[0] ?? {};
  const name = str(x.name);
  const reason = str(x.reason);
  const stage = str(x.stage);
  const msg = str(x.message);
  const month = M(ctx.month);
  const quote = quoteOf(x.quote);

  if (name === "AmountError") {
    if (/must be above 0/i.test(msg)) return ticket("AmountError", COPY.amountZero);
    if (/0\.0001|equal parts/i.test(msg)) return ticket("AmountError", COPY.amountStep);
    if (/must lie in the band/i.test(msg)) return ticket("AmountError", COPY.outsideBand(month));
    if (/limit order is 1 to/i.test(msg)) return ticket("AmountError", COPY.limitSize);
    if (/different month/i.test(msg)) return ticket("AmountError", COPY.otherMonth);
    return ticket("AmountError", COPY.amountCheck);
  }
  if (name === "ReadError" || name === "IndexerError") return fail(name, COPY.network, "retry");
  if (name !== "WriteError") return isNetworkError(e) ? fail("network", COPY.network, "retry") : fail("unknown", COPY.unchecked, "retry");

  switch (reason) {
    case "ThinBook":
      return quote ? { sheet: "thin", message: thinText(ctx.month, quote), action: "back", nothingSent: true, quote, reason } : fail(reason, COPY.unchecked, "retry");
    case "PriceMoved":
      return quote ? { sheet: "moved", message: movedText(ctx.kind, quote), action: "back", nothingSent: true, quote, reason } : fail(reason, COPY.bookMoved, "retry");
    case "InsufficientBalance":
      return { sheet: "funds", message: COPY.funds, action: "funds", nothingSent: true, reason };
    case "InsufficientTokens":
      return fail(reason, COPY.tokensShort, "back", { refresh: true });
    case "AboveBand":
      return fail(reason, ctx.kind === "closeShort" ? COPY.aboveBandCloseShort(month) : COPY.aboveBandBuy(month), "back", { quote });
    case "BelowBand":
      return fail(reason, COPY.belowBand(month), "back", { quote });
    case "EmptyBook":
      return fail(reason, COPY.emptyBook(month), "back");
    case "Depth":
      return fail(reason, ctx.kind === "short" ? COPY.depthShort : ctx.kind === "closeShort" ? COPY.depthCloseShort : COPY.depthCloseLong, "back");
    case "DripTooSoon": {
      const nextAt = msg.match(/opens at (\S+)/)?.[1];
      return { sheet: "drip", message: nextAt ? COPY.dripArrive(nextAt) : "Your next test dollars aren't ready yet.", action: "none", nothingSent: true, nextAt, reason };
    }
    case "MonthNotFinal":
      return fail(reason, COPY.monthNotFinal(month), "back");
    case "PostOnlyError":
      return ticket(reason, COPY.postOnly);
    case "NoReceipt":
      return { sheet: "pending", message: COPY.pending, action: "none", nothingSent: false, reason };
    case "reverted":
      return { sheet: "failed", message: COPY.landedMoved, action: "recheck", nothingSent: false, reason };
  }

  // the write path's later stages (a viem WalletClient, never the live account): a revert name, or nothing
  if (stage === "simulate" || stage === "estimate") return fail(stage, COPY.turnedDown, "back");
  if (stage === "send") return fail(stage, COPY.sendGeneric, "retry");
  if (stage === "receipt") return { sheet: "failed", message: COPY.landedMoved, action: "recheck", nothingSent: false, reason: stage };

  // check-stage refusals without a reason, by what they say
  if (/too small for that many parts/i.test(msg)) return ticket("parts", COPY.partsTooSmall);
  if (/less than 0\.0001 GPU-hour/i.test(msg)) return ticket("dust", COPY.tooSmallToBuy);
  if (/^(you|the account) holds? /i.test(msg)) return fail("InsufficientTokens", COPY.tokensShort, "back", { refresh: true });
  if (/no Kuru market yet/i.test(msg)) return fail("noMarket", COPY.monthNotOpen(month), "back");
  if (/is not yours|not opened through the router|position \S+ is a (long|short)/i.test(msg)) return fail("notHere", COPY.notHere, "back");
  if (/no positions given/i.test(msg)) return fail("noPositions", COPY.pickPosition, "back");
  if (/could not be read/i.test(msg)) return fail("unread", COPY.network, "retry");
  if (/nothing to claim/i.test(msg)) return fail("nothingToClaim", COPY.nothingToClaim, "back");
  if (/nothing to settle/i.test(msg)) return fail("nothingToSettle", COPY.nothingToSettle, "back");
  if (/would pay nothing/i.test(msg)) return fail("paysNothing", COPY.salePaysNothing, "back");
  if (/book moved|book is moving/i.test(msg)) return fail("bookMoved", COPY.bookMoved, "retry");
  return fail("unknown", COPY.unchecked, "retry");
}

/** refusalOf for an order, its kind and month read from it. */
export const refusalOfOrder = (e: unknown, order: Order) => refusalOf(e, { kind: tradeKindOf(order), month: "month" in order ? order.month : undefined });

// ===== sending (spec 6.9 "Sending" and "Receipt") =====

const RECEIPT_TIMEOUT = /WaitForUserOperationReceiptTimeoutError|timed out while waiting for user ?operation/i;
const SESSION_ENDED = /UserNotAuthenticatedError|UnauthorizedError|unauthorized_error|not authenticated|session (has )?expired|token[- ]expired|no active session|sign in again/i;
const NONCE = /AA25|invalid (account )?nonce/i;
const FEE = /paymaster|sponsor|gas ?policy|AA3\d|AA21|didn'?t pay prefund|insufficient funds for gas/i;
const SIGNING = /Signing|Mfa|UserRejected|WaasLoadFailed|KeyNotFound|CorruptedKeyShare|AA24|transaction review|failed to sign|could ?n[o']t sign|signature (failed|denied|error)|user rejected|rejected the request|mpc|key ?share/i;
const SIMULATION = /UserOperationExecutionError|EstimateUserOperationGasError|UserOperationReverted|AA23|execution reverted|simulat(e|ion)/i;
/** viem's own names for the bundler refusing a simulated operation, and for the paymaster refusing it */
const SIMULATION_NAME = /^(UserOperationExecutionError|EstimateUserOperationGasError|UserOperationReverted(Error)?)$/;
const PAYMASTER_NAME = /^(Paymaster\w*Error|UserOperationPaymaster\w*Error|UserOperationRejectedByPaymasterError|InsufficientPrefundError)$/;

/** A send that failed after planning: the wallet signing, the paymaster, the bundler, the network.
 *  `resent` and `replanned` say whether the one quiet retry already ran; `serverDown` adds the signing-check line. */
export function sendRefusal(e: unknown, ctx: { resent?: boolean; replanned?: boolean; serverDown?: boolean } = {}): Refusal {
  const h = haystack(e);
  const x = chain(e)[0] ?? {};
  if (RECEIPT_TIMEOUT.test(h) || (str(x.name) === "WriteError" && str(x.reason) === "NoReceipt")) return { sheet: "pending", message: COPY.pending, action: "none", nothingSent: false, reason: "noReceipt" };
  // it landed and reverted: the onchain bound held, nothing changed
  if (str(x.name) === "WriteError" && (str(x.reason) === "reverted" || str(x.stage) === "receipt")) return revertedRefusal();
  if (SESSION_ENDED.test(h) || sessionRefused(e)) return { sheet: "signin", message: COPY.sessionTrade, action: "signin", nothingSent: true, reason: "session" };
  if (NONCE.test(h)) return ctx.resent ? fail("nonce", COPY.sendGeneric, "retry") : { sheet: "resend", message: COPY.sendGeneric, action: "retry", nothingSent: true, reason: "nonce" };
  if (hasName(e, PAYMASTER_NAME)) return fail("paymaster", COPY.fee, "retry");
  const simulated = (): Refusal => (ctx.replanned ? fail("simulation", COPY.turnedDown, "back") : { sheet: "replan", message: COPY.turnedDown, action: "retry", nothingSent: true, reason: "simulation" });
  // the bundler's simulation, by name, before the fee words: its details may still mention the sponsor
  if (hasName(e, SIMULATION_NAME) && !SIGNING.test(h)) return simulated();
  if (FEE.test(h)) return fail("paymaster", COPY.fee, "retry");
  if (SIGNING.test(h)) return { sheet: "review", message: COPY.cantSign + (ctx.serverDown ? COPY.signingOffline : ""), action: "retry", nothingSent: true, reason: "signing" };
  if (SIMULATION.test(h)) return simulated();
  if (isNetworkError(e)) return fail("network", COPY.sendNetwork, "retry");
  return fail("unknown", COPY.sendGeneric, "retry");
}

/** The operation landed but reverted: the onchain bound was hit, so nothing changed. "Check the new price" re-plans. */
export const revertedRefusal = (): Refusal => ({ sheet: "failed", message: COPY.landedMoved, action: "recheck", nothingSent: false, reason: "reverted" });

// ===== limit orders (Pro, the real account): one line under the button that started it =====

/** A limit batch that could not be planned. Nothing was sent in any of these. */
export function limitRefusal(e: unknown, order: LimitOrder): Refusal {
  const x = chain(e)[0] ?? {};
  const msg = str(x.message);
  if (str(x.name) === "WriteError") {
    // a redeem after a cancel that finds fewer pairs than the order left: they stay as they are until the month ends
    if (order.kind === "redeem" && str(x.reason) === "InsufficientBalance") return fail("noPairs", COPY.redeemLater, "back", { refresh: true });
    if (str(x.reason) === "InsufficientBalance") return { sheet: "funds", message: COPY.limitFunds, action: "funds", nothingSent: true, reason: "InsufficientBalance" };
    if (/none of these orders is resting/i.test(msg)) return fail("orderGone", COPY.orderGone, "back", { refresh: true });
    if (/margin account holds/i.test(msg)) return fail("nothingAtKuru", COPY.nothingAtKuru, "back", { refresh: true });
  }
  // the band, Kuru's sizes, post-only and the reads read as they do for a trade (the cent is caught by the ticket)
  const kind: TradeKind = order.kind === "placeLimit" && order.side === "long" ? "buy" : order.kind === "placeLimit" ? "short" : "sale";
  return refusalOf(e, { kind, month: "month" in order ? order.month : order.asset !== "dollar" ? order.asset.month : undefined });
}

/** A limit batch whose send failed, or that landed and reverted (a placed order crossed the book on its way, a cancel
 *  met an order that filled first): sendRefusal, with the order's own words for a revert. */
export function limitSendRefusal(e: unknown, order: LimitOrder): Refusal {
  const r = sendRefusal(e);
  // a redeem only follows a cancel that landed, whose order is gone: nothing is left to try again, and the pairs stay
  // as a Long and a Short that the month's end pays back in full
  if (order.kind === "redeem" && r.reason !== "session") return { ...r, message: COPY.redeemLater, action: "back" };
  if (r.reason !== "reverted") return r;
  return { ...r, message: order.kind === "placeLimit" ? COPY.limitLanded : order.kind === "cancelLimit" ? COPY.cancelLanded : COPY.withdrawLanded };
}

// ===== test dollars (spec 5.4) =====

/** A drip that did not land: its plan (DripTooSoon) or its send. */
export function dripRefusal(e: unknown): Refusal {
  const x = chain(e)[0] ?? {};
  if (str(x.name) === "WriteError" && str(x.reason) === "DripTooSoon") return refusalOf(e, { kind: "drip" });
  const h = haystack(e);
  if (RECEIPT_TIMEOUT.test(h) || (str(x.name) === "WriteError" && str(x.reason) === "NoReceipt")) return { sheet: "pending", message: COPY.dripPending, action: "none", nothingSent: false, reason: "noReceipt" };
  if (SESSION_ENDED.test(h) || sessionRefused(e)) return { sheet: "signin", message: SIGNIN_COPY.sessionEnded, action: "signin", nothingSent: true, reason: "session" };
  if (FEE.test(h)) return fail("paymaster", COPY.dripFee, "retry");
  if (isNetworkError(e) || str(x.name) === "ReadError") return fail("network", COPY.dripNetwork, "retry");
  return fail("unknown", COPY.dripFee, "retry");
}

/** The drip landed with success false. */
export const dripRevertedRefusal = (): Refusal => ({ sheet: "failed", message: COPY.dripNoPayout, action: "retry", nothingSent: true, reason: "reverted" });

// ===== sign-in (spec 4) =====

/** What went wrong on the email step: before the SDK was up (init) or while asking for a code. */
export type SendCodeProblem = "badEmail" | "rateLimited" | "service" | "init";

export function sendCodeProblemOf(e: unknown, stage: "init" | "send"): SendCodeProblem {
  if (stage === "init") return "init";
  const h = haystack(e);
  if (/too_many_requests|rate.?limit|too many/i.test(h) || statusOf(e) === 429) return "rateLimited";
  if (/invalid[_ ]email/i.test(h)) return "badEmail";
  return "service";
}

/** Why a code did not sign in, from Dynamic's error codes (wrong_email_verification_token and friends). */
export function codeProblemOf(e: unknown): CodeProblem {
  const h = haystack(e);
  if (/too[_ ]many|lock_too_many_attempts/i.test(h)) return "tooMany";
  if (/wrong[_ ](email[_ ])?verification[_ ]token|wrong[_ ]token|mfa_invalid_otp|invalid (otp|code)|does ?n[o']t match|incorrect/i.test(h)) return "wrong";
  if (/expired|invalid[_ ](email[_ ])?verification/i.test(h)) return "expired";
  return "network";
}

export const codeProblemText = (p: CodeProblem) => SIGNIN_COPY[p];

/** The browser's dialog closed, timed out or found no passkey: WebAuthn's own error names and simplewebauthn's codes
 *  only, so a request that timed out is not read as the person closing the dialog. */
const DIALOG_STOPPED = /NotAllowedError|AbortError|ERROR_CEREMONY_ABORTED/;

/** Why "Sign in with a passkey" did not sign in. */
export function passkeyProblemOf(e: unknown): "passkey" | "passkeyStopped" | "passkeyUnknown" | "passkeyUnsupported" | "service" {
  const h = haystack(e);
  if (hasName(e, /NoWebAuthNSupport/i)) return "passkeyUnsupported";
  if (isNetworkError(e)) return "service";
  if (DIALOG_STOPPED.test(h)) return "passkeyStopped";
  if (/passkey.*not[_ ]found|credential.*not[_ ]found|not[_ ]found.*(passkey|credential)|unknown[_ ]credential/i.test(h) || statusOf(e) === 404) return "passkeyUnknown";
  return "passkey";
}

/** "Confirm it's you" with a passkey (Connect's step-up) did not confirm: why, in the sheet's words. */
export function passkeyConfirmText(e: unknown): string {
  const p = passkeyProblemOf(e);
  if (p === "passkeyUnsupported") return "This browser can't use passkeys. Open Agate in a browser that can, then connect your AI.";
  if (p === "service") return SIGNIN_COPY.service;
  return "Your passkey didn't confirm it. Try again, or Cancel.";
}

/** Why "Add a passkey" did not add one. */
export function addPasskeyProblemOf(e: unknown): "addPasskey" | "addPasskeyStopped" | "addPasskeyExists" {
  const h = haystack(e);
  if (/InvalidStateError|PREVIOUSLY_REGISTERED|already registered/i.test(h)) return "addPasskeyExists";
  if (DIALOG_STOPPED.test(h)) return "addPasskeyStopped";
  return "addPasskey";
}

// ===== Agate's server (server/API.md: errors are { error: "<sentence>" } with a 4xx status) =====

export type ServerProblemKind =
  /** no answer at all, or a 5xx other than 502 */
  | "offline"
  /** 401 while the Dynamic client still holds a token: do not sign out */
  | "session"
  /** 401 without a token: handle like the logout event */
  | "signedOut"
  /** 409: the trading key's delegation has not reached the server yet; retry every 2 s, up to 30 s */
  | "notYet"
  /** 409 pocket_in_use: another live AI uses that pocket */
  | "pocketInUse"
  /** 409: the approval was answered or ended */
  | "approvalEnded"
  /** 409: approving a request for an AI that is not connected */
  | "notConnected"
  | "notFound"
  /** 400, 403 or 422: refused, with the server's sentence */
  | "refused"
  /** 502: the server could not check the permission */
  | "unchecked";

export interface ServerProblem {
  kind: ServerProblemKind;
  message: string;
  /** the server's own sentence, for logs */
  serverSays?: string;
}

/** What a reply was about, for the not-found line. */
export type ServerSubject = "grant" | "request" | "approval" | "order" | "other";

export const SERVER_COPY = {
  offline: "Agate's AI service is offline right now.",
  session: "Agate's server didn't accept your session. Try again.",
  signedOut: SIGNIN_COPY.sessionEnded,
  notYet: "Agate hasn't heard from Dynamic yet. Try again in a few seconds.",
  pocketInUse: "That pocket already serves another AI.",
  approvalEnded: "This request has ended. Nothing was traded.",
  approvalAnswered: "This request was already answered.",
  notConnected: "This AI isn't connected, so Agate can't let it in. Try again.",
  notFound: {
    grant: "We can't find this AI. It may belong to another account.",
    request: "This request has ended. Start again from your AI app. Nothing was set up.",
    approval: "We can't find this request. Nothing was traded.",
    order: "We can't find this standing order.",
    other: "We can't find that.",
  },
  refused: "Agate didn't accept this. Nothing moved.",
  unchecked: "Agate couldn't check the permission. Try again.",
} as const;

/** Words that never reach the person (spec 0.2), plus the server's own jargon. */
const NOT_FOR_PEOPLE = /sub-?account|vault|kernel|smart account|assistant|session key|user ?operation|\bmpc\b|paymaster|\bgrant\b|\bu\b|1e6/i;

/** The server's sentence as shown text: capital first letter, "Agate", a full stop. Null when it uses words the
 *  person never sees, so the caller falls back to its own line. */
export function plainServerSentence(s: string | undefined | null): string | null {
  const t = (s ?? "").trim();
  if (!t || NOT_FOR_PEOPLE.test(t)) return null;
  const capped = t.replace(/\bagate\b/g, "Agate");
  const first = capped.charAt(0).toUpperCase() + capped.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/** A reply from Agate's server. `status` null means the request never got an answer (offline). */
export function serverProblemOf(status: number | null, body: unknown, ctx: { hasToken: boolean; subject?: ServerSubject }): ServerProblem {
  const serverSays = str((body as { error?: unknown } | null | undefined)?.error) || undefined;
  const at = (kind: ServerProblemKind, message: string): ServerProblem => ({ kind, message, ...(serverSays ? { serverSays } : {}) });
  if (status === null) return at("offline", SERVER_COPY.offline);
  if (status === 401) return ctx.hasToken ? at("session", SERVER_COPY.session) : at("signedOut", SERVER_COPY.signedOut);
  if (status === 409) {
    if (/^pocket_in_use/i.test(serverSays ?? "")) return at("pocketInUse", SERVER_COPY.pocketInUse);
    if (/not delegated|try again in a few seconds/i.test(serverSays ?? "")) return at("notYet", SERVER_COPY.notYet);
    const ended = serverSays?.match(/this approval is (\w+)/i)?.[1];
    if (ended) return at("approvalEnded", ended.toLowerCase() === "expired" ? SERVER_COPY.approvalEnded : SERVER_COPY.approvalAnswered);
    if (/connect the AI first/i.test(serverSays ?? "")) return at("notConnected", SERVER_COPY.notConnected);
    return at("refused", plainServerSentence(serverSays) ?? SERVER_COPY.refused);
  }
  if (status === 404) return at("notFound", SERVER_COPY.notFound[ctx.subject ?? "other"]);
  if (status === 502) return at("unchecked", SERVER_COPY.unchecked);
  if (status >= 500) return at("offline", SERVER_COPY.offline);
  if (status >= 400) return at("refused", plainServerSentence(serverSays) ?? SERVER_COPY.refused);
  return at("refused", SERVER_COPY.refused);
}

// ===== connecting an AI (spec 9.6) =====

/** Why a connect step stopped. */
export type ConnectProblem =
  /** making or delegating the trading key failed */
  | "key"
  /** the main wallet could not sign the pocket's limits */
  | "sign"
  /** the funding operation did not land */
  | "funding"
  /** still 409 "not delegated yet" after 30 s */
  | "notYet"
  /** 400 or 403: the server would not take the connection */
  | "refused"
  /** 502 */
  | "unchecked"
  /** 409 pocket_in_use */
  | "pocketInUse"
  /** no answer from Agate's server */
  | "offline"
  /** the OAuth request ran out mid-way */
  | "expired"
  /** the OAuth approve call failed */
  | "approve";

/** startAgain: back to the form with the same terms (after the money was taken back, nothing is left to resume). */
export type ConnectAction = "retry" | "takeBack" | "back" | "startAgain";

/** The server's reply to POST /api/grants (or the approve call) as a connect problem. */
export function connectProblemOf(p: ServerProblem): ConnectProblem {
  switch (p.kind) {
    case "notYet":
      return "notYet";
    case "pocketInUse":
      return "pocketInUse";
    case "unchecked":
      return "unchecked";
    case "offline":
      return "offline";
    case "notFound":
      return "expired";
    default:
      return "refused";
  }
}

/** One message and what to offer, for a connect run that stopped. `funded`: the budget is already in the pocket.
 *  `tookBack`: the person then took the pocket's money back from the failure panel (the dollars that came back), so
 *  the run has nothing to resume: it offers Start again (or, for a request that ran out, the way back). */
export function connectFailure(problem: ConnectProblem, ctx: { ai: string; budget: number; funded: boolean; tookBack?: number }): { message: string; actions: ConnectAction[] } {
  const f = connectFailureOf(problem, ctx);
  if (ctx.tookBack === undefined) return f;
  const kept = f.actions.filter((x) => x !== "retry" && x !== "takeBack");
  return { message: f.message, actions: kept.length ? kept : ["startAgain"] };
}

function connectFailureOf(problem: ConnectProblem, ctx: { ai: string; budget: number; funded: boolean; tookBack?: number }): { message: string; actions: ConnectAction[] } {
  const amount = usd0(ctx.budget);
  const back = ctx.tookBack !== undefined ? ` ${usd0(ctx.tookBack)} is back in your account.` : null;
  const where = back ?? (ctx.funded ? ` Your ${amount} is in the pocket.` : " Nothing moved.");
  switch (problem) {
    case "key":
      return { message: "We couldn't set up the key. Nothing was moved.", actions: ["retry"] };
    case "sign":
      return { message: "Your wallet couldn't sign the limits. Nothing moved.", actions: ["retry"] };
    case "funding":
      return { message: `The limits are set, but the ${amount} didn't move. Nothing was spent.`, actions: ["retry"] };
    case "notYet":
      // it can take a while (Dynamic's message to Agate is late): the pocket's money is never stuck waiting for it
      return { message: `${SERVER_COPY.notYet}${ctx.funded ? where : ""}`, actions: ctx.funded ? ["retry", "takeBack"] : ["retry"] };
    case "refused":
      return { message: `Agate didn't accept this connection, so ${ctx.ai} isn't connected.${where}`, actions: ctx.funded ? ["retry", "takeBack"] : ["retry"] };
    case "unchecked":
      return { message: SERVER_COPY.unchecked, actions: ["retry"] };
    case "pocketInUse":
      return { message: `That pocket already serves another AI, so ${ctx.ai} isn't connected yet. Try again to use a new pocket.`, actions: ["retry"] };
    case "offline":
      return { message: `${SERVER_COPY.offline}${where}`, actions: ctx.funded ? ["retry", "takeBack"] : ["retry"] };
    case "expired":
      // choosing a pocket that is already set up is not built yet: the money comes back first, then a fresh connect
      if (back) return { message: `The request ran out of time, so ${ctx.ai} isn't connected.${back} Ask ${ctx.ai} to connect again.`, actions: ["back"] };
      return ctx.funded
        ? { message: `The request ran out of time, so ${ctx.ai} isn't connected. Your ${amount} is in the pocket: take it back, then ask ${ctx.ai} to connect again.`, actions: ["takeBack"] }
        : { message: `The request ran out of time, so ${ctx.ai} isn't connected. Nothing was set up.`, actions: ["back"] };
    case "approve":
      return { message: `${ctx.ai} is connected, but we couldn't tell it yet. Try again.`, actions: ["retry"] };
  }
}

export const CONNECT_COPY = {
  stepUpCancelled: "Nothing was set up.",
  slow: "Taking longer than usual. Still working.",
  requestEnded: "This request has ended",
  requestEndedBody: (ai: string) => `Ask ${ai} to connect to Agate again. Nothing was set up.`,
  offline: `${SERVER_COPY.offline} Nothing moved.`,
} as const;

// ===== disconnecting an AI (spec 10.5) and its pocket (10.4) =====

export type DisconnectAt = "stopping" | "revoking" | "takingBack";

export function disconnectFailure(at: DisconnectAt, ctx: { ai: string; amount: number }): { message: string; actions: ConnectAction[] } {
  switch (at) {
    case "stopping":
      return { message: `Couldn't reach Agate's server, so ${ctx.ai} may still trade. Try again.`, actions: ["retry"] };
    case "revoking":
      return { message: "Disconnect didn't finish. Try again.", actions: ["retry"] };
    case "takingBack":
      return { message: `${ctx.ai} is disconnected. The ${usd0(ctx.amount)} didn't move yet.`, actions: ["takeBack"] };
  }
}

/** Done: the money line, plus the note when the server missed the stop but the key is off. */
export function disconnectDoneText(ctx: { ai: string; amount: number; tookBack: boolean; serverMissed: boolean }) {
  const money = ctx.amount > 0 ? (ctx.tookBack ? `${usd0(ctx.amount)} is back in your account.` : `Its ${usd0(ctx.amount)} stays in the pocket. Take it back any time.`) : "";
  const note = ctx.serverMissed ? `Agate's server didn't answer, but ${ctx.ai}'s trading key is off, so it can't trade.` : "";
  return [money, note].filter(Boolean).join(" ");
}

export const POCKET_COPY = {
  over: (balance: number) => `More than your ${usd0(balance)}.`,
  didntMove: "The test dollars didn't move. Nothing changed.",
  pending: "Sent, waiting for Monad. Check the pocket in a minute.",
} as const;

// ===== what an AI tried: refusal rules, MCP statuses, the autopilot (activity: pocket.refused {rule, message}) =====

/** Every rule a pocket trade can be refused by: the onchain limits (wallet allowed.ts), the server's checks, and
 *  the client's reasons in the AI's words (mcp/server.ts RULES and their lower-case fallbacks). */
export const REFUSAL_RULES = {
  over_per_trade_cap: "it would have spent more than its limit on one trade",
  budget_left: "its pocket didn't hold enough test dollars",
  daily_limit: "it had used all of its trades for the day",
  grant_expired: "its permission had ended",
  grant_revoked: "it was disconnected",
  price_moved: "the price moved before it could trade",
  thin_book: "the book couldn't fill that size",
  above_band: "at those prices the trade could only lose",
  below_band: "at those prices the trade could only lose",
  empty_book: "no one was selling that month",
  drip_too_soon: "its free test dollars for the day were already taken",
  not_enough_tokens: "it held fewer GPU-hours than it tried to sell",
  payee_must_be_you: "it tried to send payouts somewhere other than your account",
  not_allowed_contract: "it tried something outside its pocket's limits",
  not_allowed_function: "it tried something outside its pocket's limits",
  approve_router_only: "it tried something outside its pocket's limits",
  no_native_value: "it tried something outside its pocket's limits",
  no_market: "that month isn't open for trading yet",
  bad_input: "it asked with numbers Agate couldn't read",
  not_found: "it asked about something that isn't there",
  monthnotfinal: "that month hasn't settled yet",
  postonlyerror: "its price would have filled right away",
  noreceipt: "Monad hadn't confirmed it yet",
  reverted: "Monad turned it down, so nothing changed",
} as const satisfies Record<string, string>;

export type RefusalRule = keyof typeof REFUSAL_RULES;

const knownRule = (rule: string | null | undefined): string | null => (REFUSAL_RULES as Record<string, string>)[(rule ?? "").split(":")[0]!.trim().toLowerCase()] ?? null;

/** A rule as a clause ("it had used all of its trades for the day"); unknown rules read as Agate stopping it. */
export const ruleText = (rule: string | null | undefined): string => knownRule(rule) ?? "Agate's checks stopped it";

/** The activity line for pocket.refused. */
export const refusedText = (rule: string | null | undefined, ai: string) => `${ai} tried a trade that didn't go through: ${ruleText(rule)}.`;

/** An MCP trade tool's status, as the activity reads it. */
export type McpTradeStatus = "done" | "sent" | "reverted" | "refused" | "needs_approval";

export function mcpStatusText(status: McpTradeStatus, ai: string, rule?: string): string {
  switch (status) {
    case "done":
      return "A trade went through on Monad.";
    case "sent":
      return "A trade was sent and hasn't landed yet.";
    case "reverted":
      return "A trade didn't go through on Monad. Nothing changed.";
    case "refused":
      return refusedText(rule, ai);
    case "needs_approval":
      return `${ai} asked to go over its limit.`;
  }
}

/** A standing order's last result (GET /api/standing-orders lastResult). */
export type AutopilotResult =
  | { skip: string }
  | { rolled: { from: string; to: string; gpuHours: number }; txHash?: string }
  | { refused: string; detail?: string }
  | { error: string };

export function autopilotText(r: AutopilotResult | null | undefined): string {
  if (!r) return "Not run yet.";
  if ("rolled" in r) return `Moved ${showHours(r.rolled.gpuHours)} GPU-hours from ${M(r.rolled.from)} into ${M(r.rolled.to)}.`;
  if ("refused" in r) return `Didn't roll: ${ruleText(r.refused)}.`;
  if ("skip" in r) {
    const why = knownRule(r.skip);
    return why ? `Waiting: ${why}.` : "Waiting: nothing needs to move yet.";
  }
  return "Something went wrong. Agate tries again at the next check.";
}
