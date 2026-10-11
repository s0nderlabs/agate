// Every refusal the account can meet, mapped to its sheet and plain copy: each WriteError reason and stage of
// @agate/client, the send path (signing, paymaster, bundler, network), drips, sign-in codes, Agate's server replies,
// connect and disconnect failures, and every pocket refusal rule.
import { describe, expect, test } from "bun:test";
import { BaseError } from "viem";
import { UserOperationExecutionError } from "viem/account-abstraction";
import {
  autopilotText,
  codeProblemOf,
  codeProblemText,
  CONNECT_COPY,
  type ConnectProblem,
  connectFailure,
  connectProblemOf,
  COPY,
  disconnectDoneText,
  disconnectFailure,
  dripRefusal,
  dripRevertedRefusal,
  type FreshQuote,
  isNetworkError,
  limitRefusal,
  limitSendRefusal,
  mcpStatusText,
  movedText,
  plainServerSentence,
  POCKET_COPY,
  REFUSAL_RULES,
  refusalOf,
  refusalOfOrder,
  refusedText,
  revertedRefusal,
  ruleText,
  sendCodeProblemOf,
  sendRefusal,
  SERVER_COPY,
  type ServerProblemKind,
  serverProblemOf,
  SIGNIN_COPY,
  thinText,
  tradeKindOf,
  type TradeKind,
  WRITE_REASONS,
} from "./errors";
import type { LimitOrder, Order } from "./types";

/** @agate/client's WriteError, duck-typed the way the app sees it (its class may be another copy). */
const writeError = (message: string, stage = "check", reason?: string, quote?: FreshQuote) => Object.assign(new Error(message), { name: "WriteError", stage, reason, quote, txs: [] });
const named = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });
const quote: FreshQuote = { gpuHours: 1180.5, dollars: 4812.33, avgPrice: 4.0765 };
const buy = { kind: "buy" as const, month: "2026-11" };
const FALLBACK = "Agate's checks stopped it";

describe("tradeKindOf", () => {
  test("every order kind", () => {
    const on = { gpu: "H100" as const, month: "2026-11" };
    const cases: [Order, TradeKind][] = [
      [{ kind: "buyLong", ...on, dollars: "1" }, "buy"],
      [{ kind: "openLongDaily", ...on, dollars: "1", parts: 1 }, "buy"],
      [{ kind: "openShort", ...on, gpuHours: "1", parts: 1, daily: true }, "short"],
      [{ kind: "sellLong", ...on, gpuHours: "1" }, "sale"],
      [{ kind: "closeLongDaily", ...on, positionIds: ["1"] }, "closeDaily"],
      [{ kind: "closeShort", ...on, positionIds: ["1"] }, "closeShort"],
      [{ kind: "drip" }, "drip"],
    ];
    for (const [o, k] of cases) expect(tradeKindOf(o)).toBe(k);
  });
});

describe("refusalOf: planning (spec 6.9)", () => {
  test("every WriteError reason is recognized, never the generic line", () => {
    for (const reason of WRITE_REASONS) {
      const r = refusalOf(writeError(`refused: ${reason}; the next drip opens at 2026-10-05T14:02:00Z`, reason === "NoReceipt" || reason === "reverted" ? "receipt" : "check", reason, quote), buy);
      expect(r.reason).toBe(reason);
      expect(r.message).not.toBe(COPY.unchecked);
    }
  });

  test("ThinBook: the thin sheet with the quote", () => {
    const r = refusalOf(writeError("thin", "check", "ThinBook", quote), buy);
    expect(r).toEqual({ sheet: "thin", message: "At prices November can still pay, the book holds $4,812.33 (1,180.5 GPU-hours). The rest would buy above that.", action: "back", nothingSent: true, quote, reason: "ThinBook" });
    expect(refusalOf(writeError("thin", "check", "ThinBook"), buy)).toMatchObject({ sheet: "failed", message: COPY.unchecked, action: "retry" });
  });

  test("PriceMoved: the moved sheet, worded by trade", () => {
    expect(refusalOf(writeError("moved", "check", "PriceMoved", quote), buy)).toMatchObject({ sheet: "moved", quote, message: "It now fills 1,180.5 GPU-hours at $4.08 on average for $4,812.33." });
    for (const kind of ["short", "sale", "closeDaily"] as const) expect(refusalOf(writeError("moved", "check", "PriceMoved", quote), { kind }).message).toBe("It now sells for $4,812.33, $4.08 each.");
    expect(refusalOf(writeError("moved", "check", "PriceMoved", quote), { kind: "closeShort" }).message).toBe("Buying back now costs $4,812.33.");
    expect(refusalOf(writeError("moved", "check", "PriceMoved"), buy)).toMatchObject({ sheet: "failed", message: COPY.bookMoved, action: "retry" });
  });

  test("InsufficientBalance and InsufficientTokens", () => {
    expect(refusalOf(writeError("needs $4900", "check", "InsufficientBalance"), buy)).toEqual({ sheet: "funds", message: COPY.funds, action: "funds", nothingSent: true, reason: "InsufficientBalance" });
    expect(refusalOf(writeError("the account holds 3 GPU-hours of H100-NOV26", "check", "InsufficientTokens"), { kind: "sale" })).toMatchObject({ sheet: "failed", message: COPY.tokensShort, action: "back", refresh: true });
  });

  test("the band: a sure loss is refused, with the month's name", () => {
    expect(refusalOf(writeError("asks above", "check", "AboveBand", quote), buy)).toMatchObject({ sheet: "failed", action: "back", message: "At these prices this trade can only lose: the asks are above what November can pay. Nothing was sent." });
    expect(refusalOf(writeError("buy back above", "check", "AboveBand", quote), { kind: "closeShort", month: "2026-11" }).message).toBe("Buying back costs more than November can pay, so holding the Short pays more. Nothing was sent.");
    expect(refusalOf(writeError("bids below", "check", "BelowBand", quote), { kind: "short", month: "2026-12" }).message).toBe("At these prices this trade can only lose: the bids are below the least December will pay. Nothing was sent.");
  });

  test("EmptyBook, Depth by trade, MonthNotFinal, PostOnlyError", () => {
    expect(refusalOf(writeError("empty", "check", "EmptyBook"), buy).message).toBe("No one is selling November right now. Nothing was sent.");
    expect(refusalOf(writeError("depth", "check", "Depth"), { kind: "short" }).message).toBe(COPY.depthShort);
    expect(refusalOf(writeError("depth", "check", "Depth"), { kind: "sale" }).message).toBe(COPY.depthCloseLong);
    expect(refusalOf(writeError("depth", "check", "Depth"), { kind: "closeDaily" }).message).toBe(COPY.depthCloseLong);
    expect(refusalOf(writeError("depth", "check", "Depth"), { kind: "closeShort" }).message).toBe(COPY.depthCloseShort);
    expect(refusalOf(writeError("k of n", "check", "MonthNotFinal"), buy).message).toBe("November settles once every day is final. Nothing was sent.");
    expect(refusalOf(writeError("post-only", "check", "PostOnlyError"), buy)).toMatchObject({ sheet: "ticket", message: COPY.postOnly });
  });

  test("DripTooSoon: the next-drip line, in UTC", () => {
    const r = refusalOf(writeError("the next drip opens at 2026-10-05T14:02:00Z", "check", "DripTooSoon"), { kind: "drip" });
    expect(r).toEqual({ sheet: "drip", message: "Your next 10,000 test dollars arrive Oct 5, 14:02 UTC.", action: "none", nothingSent: true, nextAt: "2026-10-05T14:02:00Z", reason: "DripTooSoon" });
    expect(COPY.dripNext("2026-10-05T14:02:00Z")).toBe("Next 10,000 on Oct 5, 14:02 UTC");
    expect(refusalOf(writeError("too soon", "check", "DripTooSoon"), { kind: "drip" }).nextAt).toBeUndefined();
  });

  test("the receipt: NoReceipt is pending, reverted re-checks the price", () => {
    expect(refusalOf(writeError("sent as 0x1, but no receipt", "receipt", "NoReceipt"), buy)).toMatchObject({ sheet: "pending", nothingSent: false, message: COPY.pending });
    expect(refusalOf(writeError("reverted onchain", "receipt", "reverted"), buy)).toMatchObject({ sheet: "failed", action: "recheck", nothingSent: false, message: COPY.landedMoved });
    expect(refusalOf(writeError("the router emitted no Routed event", "receipt"), buy)).toMatchObject({ action: "recheck", reason: "receipt" });
  });

  test("the later stages of the write path", () => {
    expect(refusalOf(writeError("openLong: the simulation reverted (SlippageExceeded)", "simulate", "SlippageExceeded"), buy)).toMatchObject({ sheet: "failed", message: COPY.turnedDown, action: "back" });
    expect(refusalOf(writeError("estimate failed", "estimate", "NotReady"), buy)).toMatchObject({ message: COPY.turnedDown });
    expect(refusalOf(writeError("the wallet did not send", "send", "UserRejectedRequestError"), buy)).toMatchObject({ message: COPY.sendGeneric, action: "retry" });
  });

  test("check-stage refusals without a reason, by what they say", () => {
    const at = (m: string, kind: TradeKind = "buy") => refusalOf(writeError(m), { kind, month: "2026-11" });
    expect(at("the size is too small for that many parts")).toMatchObject({ sheet: "ticket", message: COPY.partsTooSmall });
    expect(at("$0.0001 buys less than 0.0001 GPU-hour (one Kuru size unit): the size is too small to buy; nothing was sent")).toMatchObject({ sheet: "ticket", message: COPY.tooSmallToBuy });
    expect(at("you hold 3 GPU-hours of H100-NOV26 in the wallet", "sale")).toMatchObject({ message: COPY.tokensShort, refresh: true });
    expect(at("the account holds no H100-NOV26 to roll", "sale")).toMatchObject({ message: COPY.tokensShort });
    expect(at("H100 2026-12 has no Kuru market yet")).toMatchObject({ message: "November isn't open for trading yet." });
    expect(at("position 7 is not yours", "closeDaily").message).toBe(COPY.notHere);
    expect(at("position 7 was not opened through the router: close it with the series directly", "closeShort").message).toBe(COPY.notHere);
    expect(at("position 7 is a long", "closeShort").message).toBe(COPY.notHere);
    expect(at("no positions given", "closeShort").message).toBe(COPY.pickPosition);
    expect(at("the book could not be read")).toMatchObject({ message: COPY.network, action: "retry" });
    expect(at("position 7 could not be read", "closeDaily")).toMatchObject({ message: COPY.network, action: "retry" });
    expect(at("nothing to claim yet").message).toBe(COPY.nothingToClaim);
    expect(at("nothing to settle in the account").message).toBe(COPY.nothingToSettle);
    expect(at("the sale would pay nothing", "sale").message).toBe(COPY.salePaysNothing);
    expect(at("could not find a quote that buys the size: the book moved")).toMatchObject({ message: COPY.bookMoved, action: "retry" });
    expect(at("the wallet client has no account")).toMatchObject({ message: COPY.unchecked, reason: "unknown" });
  });

  test("AmountError: back to the ticket with its line", () => {
    const at = (m: string) => refusalOf(named("AmountError", m), buy);
    expect(at("dollars must be above 0")).toEqual({ sheet: "ticket", message: COPY.amountZero, action: "back", nothingSent: true, reason: "AmountError" });
    expect(at("GPU-hours must be above 0").message).toBe(COPY.amountZero);
    expect(at("GPU-hours must split into equal parts of whole 0.0001 GPU-hours").message).toBe(COPY.amountStep);
    expect(at("price must lie in the band 2.5 to 6 (what a H100-NOV26 token can still pay at the month's end)").message).toBe("That price is outside what November can still pay.");
    expect(at("a limit order is 1 to 1,000,000 GPU-hours (Kuru's sizes), not 0.5").message).toBe(COPY.limitSize);
    expect(at("roll to a different month").message).toBe(COPY.otherMonth);
    expect(at("parts must be at least 1").message).toBe(COPY.amountCheck);
  });

  test("reads and the network", () => {
    expect(refusalOf(named("ReadError", "rpc down"), buy)).toMatchObject({ sheet: "failed", message: COPY.network, action: "retry", reason: "ReadError" });
    expect(refusalOf(named("IndexerError", "indexer down"), buy)).toMatchObject({ message: COPY.network });
    expect(refusalOf(new TypeError("Failed to fetch"), buy)).toMatchObject({ message: COPY.network, reason: "network" });
    expect(refusalOf(new Error("something odd"), buy)).toMatchObject({ message: COPY.unchecked, reason: "unknown" });
    expect(refusalOf("a string", buy)).toMatchObject({ reason: "unknown" });
    expect(refusalOf(null, buy)).toMatchObject({ reason: "unknown" });
  });

  test("the month: from the order, or a plain stand-in", () => {
    expect(refusalOf(writeError("empty", "check", "EmptyBook"), { kind: "buy" }).message).toBe("No one is selling this month right now. Nothing was sent.");
    expect(refusalOf(writeError("H100 2026-12 has no Kuru market yet"), { kind: "buy" }).message).toBe("This month isn't open for trading yet.");
    const order: Order = { kind: "openShort", gpu: "H100", month: "2027-01", gpuHours: "1.0000", parts: 1, daily: true };
    expect(refusalOfOrder(writeError("bids below", "check", "BelowBand"), order).message).toContain("January");
    expect(refusalOfOrder(writeError("too soon", "check", "DripTooSoon"), { kind: "drip" }).sheet).toBe("drip");
    expect(thinText(undefined, quote)).toContain("At prices this month can still pay");
    expect(movedText("buy", quote)).toContain("on average");
  });
});

describe("sendRefusal: sending (spec 6.9)", () => {
  test("no receipt in 120 s is pending, never a resend", () => {
    expect(sendRefusal(named("WaitForUserOperationReceiptTimeoutError", "Timed out while waiting for User Operation with hash 0x1 to be confirmed."))).toMatchObject({ sheet: "pending", message: COPY.pending, nothingSent: false });
    expect(sendRefusal(writeError("no receipt", "receipt", "NoReceipt")).sheet).toBe("pending");
  });

  test("a session that ended goes to sign-in with the trade kept", () => {
    for (const e of [named("UserNotAuthenticatedError", "User is not authenticated"), named("UnauthorizedError", "unauthorized"), new Error("token expired"), named("Error", "outer", { cause: named("APIError", "nope", { status: 401 }) })]) {
      expect(sendRefusal(e)).toMatchObject({ sheet: "signin", message: COPY.sessionTrade, action: "signin" });
    }
    // a bundler's 401 is not a session that ended
    expect(sendRefusal(named("HttpRequestError", "HTTP request failed. Status: 401", { status: 401 })).sheet).not.toBe("signin");
  });

  test("AA25: one quiet resend, then the generic line", () => {
    const e = named("UserOperationExecutionError", "Execution reverted", { cause: new Error("AA25 invalid account nonce") });
    expect(sendRefusal(e)).toMatchObject({ sheet: "resend", reason: "nonce" });
    expect(sendRefusal(e, { resent: true })).toMatchObject({ sheet: "failed", message: COPY.sendGeneric, action: "retry" });
  });

  test("the paymaster refusing", () => {
    for (const m of ["paymaster rejected the operation", "AA33 reverted", "gas policy not met", "AA21 didn't pay prefund", "zd_sponsorUserOperation failed"]) expect(sendRefusal(new Error(m))).toMatchObject({ sheet: "failed", message: COPY.fee, reason: "paymaster" });
  });

  test("signing failed or denied: back to Review, with the offline line when the server is down", () => {
    for (const e of [named("SigningProposalSignatureMismatchError", "x"), new Error("Transaction Review denied this"), named("UserRejectedError", "user rejected"), new Error("AA24 signature error"), named("WaasLoadFailedError", "mpc failed")]) {
      expect(sendRefusal(e)).toMatchObject({ sheet: "review", message: COPY.cantSign, reason: "signing" });
    }
    expect(sendRefusal(new Error("failed to sign"), { serverDown: true }).message).toBe("Your wallet couldn't sign. Nothing was sent. Try again. Agate's signing check is offline.");
  });

  test("the bundler's simulation reverting: plan again once, then Monad turned it down", () => {
    const e = named("UserOperationExecutionError", "Execution reverted with reason: SlippageExceeded");
    expect(sendRefusal(e)).toMatchObject({ sheet: "replan", reason: "simulation" });
    expect(sendRefusal(named("EstimateUserOperationGasError", "AA23 reverted"))).toMatchObject({ sheet: "replan" });
    expect(sendRefusal(e, { replanned: true })).toMatchObject({ sheet: "failed", message: COPY.turnedDown, action: "back" });
  });

  test("a sponsored operation's simulation revert is still a simulation, not the fee (viem prints the paymaster)", () => {
    const cause = new BaseError("Execution reverted with reason: SlippageExceeded.");
    const args = { sender: "0x1111111111111111111111111111111111111111", nonce: 3n, callData: "0x", signature: "0xabcd" } as const;
    const sponsored = new UserOperationExecutionError(cause, { ...args, paymaster: "0x2222222222222222222222222222222222222222", paymasterData: "0x1234" } as never);
    expect(sponsored.message).toContain("paymaster:");
    expect(sendRefusal(sponsored)).toMatchObject({ sheet: "replan", reason: "simulation" });
    expect(sendRefusal(new UserOperationExecutionError(cause, args as never))).toMatchObject({ sheet: "replan", reason: "simulation" });
    // a paymaster refusal by viem's own name stays the fee
    expect(sendRefusal(new UserOperationExecutionError(named("PaymasterFunctionRevertedError", "AA33 reverted") as never, args as never))).toMatchObject({ reason: "paymaster" });
  });

  test("a landed revert from the client's WriteError is the final \"price moved\" line", () => {
    expect(sendRefusal(writeError("the operation reverted", "receipt", "reverted"))).toEqual(revertedRefusal());
  });

  test("the network, and anything else", () => {
    expect(sendRefusal(named("HttpRequestError", "HTTP request failed."))).toMatchObject({ message: COPY.sendNetwork, reason: "network" });
    expect(sendRefusal(new TypeError("fetch failed"))).toMatchObject({ message: COPY.sendNetwork });
    expect(sendRefusal(new Error("???"))).toMatchObject({ message: COPY.sendGeneric, reason: "unknown" });
    expect(revertedRefusal()).toEqual({ sheet: "failed", message: COPY.landedMoved, action: "recheck", nothingSent: false, reason: "reverted" });
  });

  test("isNetworkError", () => {
    expect(isNetworkError(named("TimeoutError", "took too long"))).toBe(true);
    expect(isNetworkError(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(isNetworkError(new Error("execution reverted"))).toBe(false);
  });
});

describe("limit orders (Pro, the real account)", () => {
  const bid: LimitOrder = { kind: "placeLimit", gpu: "H100", month: "2026-11", side: "long", price: "3.90", gpuHours: "10.0000" };
  const ask: LimitOrder = { ...bid, side: "short", price: "4.10" };
  const cancel: LimitOrder = { kind: "cancelLimit", gpu: "H100", month: "2026-11", orderIds: ["41"] };
  const withdraw: LimitOrder = { kind: "withdrawMargin", asset: "dollar" };

  test("planning: each builder's refusal in the order's words, nothing sent", () => {
    expect(limitRefusal(writeError("needs $39", "check", "InsufficientBalance"), bid)).toMatchObject({ message: COPY.limitFunds, nothingSent: true, reason: "InsufficientBalance" });
    expect(limitRefusal(writeError("an ask that mints 10 pairs: needs $80", "check", "InsufficientBalance"), ask).message).toBe(COPY.limitFunds);
    expect(limitRefusal(writeError("none of these orders is resting and yours"), cancel)).toMatchObject({ message: COPY.orderGone, refresh: true, nothingSent: true });
    expect(limitRefusal(writeError("the margin account holds 0"), withdraw)).toMatchObject({ message: COPY.nothingAtKuru, refresh: true });
    // a redeem after a cancel that finds no pair to turn back: they stay until the month ends (never "needs dollars")
    const redeem: LimitOrder = { kind: "redeem", gpu: "H100", month: "2026-11", gpuHours: "10.0000" };
    expect(limitRefusal(writeError("the wallet holds no H100-NOV26 pair (a token and a short unit)", "check", "InsufficientBalance"), redeem)).toMatchObject({ message: COPY.redeemLater, refresh: true, nothingSent: true });
    expect(limitRefusal(writeError("a post-only bid at 4.03 would cross the best ask 4.03", "check", "PostOnlyError"), bid)).toMatchObject({ sheet: "ticket", message: COPY.postOnly });
    expect(limitRefusal(writeError("the book could not be read, so a post-only order cannot be checked; nothing was sent"), bid)).toMatchObject({ message: COPY.network, action: "retry" });
  });

  test("planning: the price and the size, with the order's month", () => {
    expect(limitRefusal(named("AmountError", "price must lie in the band 1.95 to 8 (what a H100-NOV26 token can still pay at the month's end)"), ask).message).toBe("That price is outside what November can still pay.");
    expect(limitRefusal(named("AmountError", "a limit order is 1 to 1,000,000 GPU-hours (Kuru's sizes), not 0.5"), bid).message).toBe(COPY.limitSize);
    expect(limitRefusal(writeError("H100 2027-01 has no Kuru market yet"), { kind: "withdrawMargin", asset: { gpu: "H100", month: "2027-01" } }).message).toBe("January isn't open for trading yet.");
  });

  test("sending: a landed revert in the order's own words; anything else as a trade's send", () => {
    const rev = writeError("the operation landed and reverted", "receipt", "reverted");
    expect(limitSendRefusal(rev, bid)).toMatchObject({ message: COPY.limitLanded, nothingSent: false });
    expect(limitSendRefusal(rev, cancel).message).toBe(COPY.cancelLanded);
    expect(limitSendRefusal(rev, withdraw).message).toBe(COPY.withdrawLanded);
    expect(limitSendRefusal(named("UserNotAuthenticatedError", "sign in again"), bid)).toMatchObject({ message: COPY.sessionTrade, nothingSent: true });
    expect(limitSendRefusal(new TypeError("Failed to fetch"), cancel)).toMatchObject({ message: COPY.sendNetwork, nothingSent: true });
    expect(limitSendRefusal(named("WaitForUserOperationReceiptTimeoutError", "timed out"), ask)).toMatchObject({ message: COPY.pending, nothingSent: false });
  });

  test("sending the redeem after a cancel: its order is gone, so never 'try again', only what the month's end does", () => {
    const redeem: LimitOrder = { kind: "redeem", gpu: "H100", month: "2026-11", gpuHours: "6.0000" };
    expect(limitSendRefusal(writeError("the operation landed and reverted", "receipt", "reverted"), redeem)).toMatchObject({ message: COPY.redeemLater, action: "back" });
    expect(limitSendRefusal(new TypeError("Failed to fetch"), redeem)).toMatchObject({ message: COPY.redeemLater, action: "back" });
    expect(limitSendRefusal(named("UserNotAuthenticatedError", "sign in again"), redeem)).toMatchObject({ message: COPY.sessionTrade, action: "signin" });
  });
});

describe("dripRefusal (spec 5.4)", () => {
  test("every drip outcome", () => {
    expect(dripRefusal(writeError("the next drip opens at 2026-10-05T14:02:00Z", "check", "DripTooSoon"))).toMatchObject({ sheet: "drip", nextAt: "2026-10-05T14:02:00Z" });
    expect(dripRefusal(named("WaitForUserOperationReceiptTimeoutError", "timed out"))).toMatchObject({ sheet: "pending", message: COPY.dripPending });
    expect(dripRefusal(writeError("x", "receipt", "NoReceipt")).sheet).toBe("pending");
    expect(dripRefusal(new Error("token expired"))).toMatchObject({ sheet: "signin", message: SIGNIN_COPY.sessionEnded });
    expect(dripRefusal(new Error("paymaster said no"))).toMatchObject({ message: COPY.dripFee, reason: "paymaster" });
    expect(dripRefusal(new TypeError("Failed to fetch"))).toMatchObject({ message: COPY.dripNetwork });
    expect(dripRefusal(named("ReadError", "x"))).toMatchObject({ message: COPY.dripNetwork });
    expect(dripRefusal(new Error("???"))).toMatchObject({ message: COPY.dripFee, reason: "unknown" });
    expect(dripRevertedRefusal()).toMatchObject({ message: COPY.dripNoPayout, nothingSent: true });
  });
});

describe("sign-in (spec 4)", () => {
  test("the email step's problems", () => {
    expect(sendCodeProblemOf(new Error("anything"), "init")).toBe("init");
    expect(sendCodeProblemOf(named("APIError", "Too many requests", { code: "too_many_requests" }), "send")).toBe("rateLimited");
    expect(sendCodeProblemOf(named("APIError", "slow down", { status: 429 }), "send")).toBe("rateLimited");
    expect(sendCodeProblemOf(named("APIError", "bad", { code: "invalid_email" }), "send")).toBe("badEmail");
    expect(sendCodeProblemOf(new TypeError("Failed to fetch"), "send")).toBe("service");
    for (const p of ["badEmail", "rateLimited", "service", "init"] as const) expect(SIGNIN_COPY[p].length).toBeGreaterThan(10);
  });

  test("the code step's problems, from Dynamic's codes and messages", () => {
    expect(codeProblemOf(named("APIError", "x", { code: "wrong_email_verification_token" }))).toBe("wrong");
    expect(codeProblemOf(new Error("Wrong email verification token"))).toBe("wrong");
    expect(codeProblemOf(named("MfaInvalidOtpError", "x", { code: "mfa_invalid_otp_error" }))).toBe("wrong");
    expect(codeProblemOf(named("APIError", "x", { code: "too_many_email_verification_attempts" }))).toBe("tooMany");
    expect(codeProblemOf(named("APIError", "x", { code: "lock_too_many_attempts" }))).toBe("tooMany");
    expect(codeProblemOf(named("APIError", "x", { code: "invalid_email_verification" }))).toBe("expired");
    expect(codeProblemOf(new Error("This code has expired"))).toBe("expired");
    expect(codeProblemOf(new TypeError("Failed to fetch"))).toBe("network");
    expect(codeProblemText("wrong")).toBe(SIGNIN_COPY.wrong);
    expect(codeProblemText("expired")).toBe("That code has expired.");
    expect(codeProblemText("tooMany")).toBe("Too many tries with this code. Send a new one.");
    expect(codeProblemText("network")).toBe("Can't check the code right now. Try again.");
  });
});

describe("Agate's server replies", () => {
  const p = (status: number | null, error?: string, ctx: Partial<{ hasToken: boolean; subject: "grant" | "request" | "approval" | "order" | "other" }> = {}) => serverProblemOf(status, error === undefined ? null : { error }, { hasToken: true, ...ctx });

  test("every shape", () => {
    const cases: [ReturnType<typeof p>, ServerProblemKind, string][] = [
      [p(null), "offline", SERVER_COPY.offline],
      [p(401, "session not valid: sign in again"), "session", SERVER_COPY.session],
      [p(401, "sign in first", { hasToken: false }), "signedOut", SIGNIN_COPY.sessionEnded],
      [p(409, 'pocket_in_use: this pocket already serves "Claude"; use the next pocket index or disconnect it first'), "pocketInUse", SERVER_COPY.pocketInUse],
      [p(409, "the Assistant is not delegated to agate yet (try again in a few seconds)"), "notYet", SERVER_COPY.notYet],
      [p(409, "this approval is expired"), "approvalEnded", SERVER_COPY.approvalEnded],
      [p(409, "this approval is done"), "approvalEnded", SERVER_COPY.approvalAnswered],
      [p(409, "connect the AI first (no live connection with that id)"), "notConnected", SERVER_COPY.notConnected],
      [p(409, "something else entirely"), "refused", "Something else entirely."],
      [p(404, "no such AI connection", { subject: "grant" }), "notFound", SERVER_COPY.notFound.grant],
      [p(404, "this request expired or belongs to someone else", { subject: "request" }), "notFound", SERVER_COPY.notFound.request],
      [p(404, "no such approval", { subject: "approval" }), "notFound", SERVER_COPY.notFound.approval],
      [p(404, "no such autopilot order", { subject: "order" }), "notFound", SERVER_COPY.notFound.order],
      [p(404), "notFound", SERVER_COPY.notFound.other],
      [p(502, "could not check the permission, try again"), "unchecked", SERVER_COPY.unchecked],
      [p(500), "offline", SERVER_COPY.offline],
      [p(503), "offline", SERVER_COPY.offline],
      [p(400, "the per-trade cap must be above 0 and at most the budget"), "refused", "The per-trade cap must be above 0 and at most the budget."],
      [p(403, "these wallets are not yours"), "refused", "These wallets are not yours."],
      [p(400, "no grant"), "refused", SERVER_COPY.refused],
      [p(400, "budget and per-trade cap are whole numbers of u (1e6 = $1)"), "refused", SERVER_COPY.refused],
      [p(422, "the main wallet is never delegated: use the Assistant"), "refused", SERVER_COPY.refused],
      [p(400), "refused", SERVER_COPY.refused],
      [p(302), "refused", SERVER_COPY.refused],
    ];
    for (const [got, kind, message] of cases) expect([got.kind, got.message]).toEqual([kind, message]);
    expect(p(409, "pocket_in_use: x").serverSays).toBe("pocket_in_use: x");
    expect(p(null).serverSays).toBeUndefined();
  });

  test("plainServerSentence: shown text or nothing", () => {
    expect(plainServerSentence("trades per day: 1 to 50")).toBe("Trades per day: 1 to 50.");
    expect(plainServerSentence("is agate up?")).toBe("Is Agate up?");
    expect(plainServerSentence("the Assistant is not delegated")).toBeNull();
    expect(plainServerSentence("a Kernel thing")).toBeNull();
    expect(plainServerSentence("")).toBeNull();
    expect(plainServerSentence(undefined)).toBeNull();
  });

  test("connectProblemOf: a server reply as a connect problem", () => {
    const of = (kind: ServerProblemKind) => connectProblemOf({ kind, message: "" });
    expect(of("notYet")).toBe("notYet");
    expect(of("pocketInUse")).toBe("pocketInUse");
    expect(of("unchecked")).toBe("unchecked");
    expect(of("offline")).toBe("offline");
    expect(of("notFound")).toBe("expired");
    for (const k of ["refused", "session", "signedOut", "approvalEnded", "notConnected"] as const) expect(of(k)).toBe("refused");
  });
});

describe("connect and disconnect copy (spec 9.6, 10.5)", () => {
  const ctx = { ai: "Claude", budget: 1000, funded: false };

  test("every connect problem, with and without the money in the pocket", () => {
    const all: ConnectProblem[] = ["key", "sign", "funding", "notYet", "refused", "unchecked", "pocketInUse", "offline", "expired", "approve"];
    for (const problem of all) {
      for (const funded of [false, true]) {
        const f = connectFailure(problem, { ...ctx, funded });
        expect(f.message.length).toBeGreaterThan(10);
        expect(f.actions.length).toBeGreaterThan(0);
      }
    }
    expect(connectFailure("key", ctx)).toEqual({ message: "We couldn't set up the key. Nothing was moved.", actions: ["retry"] });
    expect(connectFailure("sign", ctx)).toEqual({ message: "Your wallet couldn't sign the limits. Nothing moved.", actions: ["retry"] });
    expect(connectFailure("funding", ctx)).toEqual({ message: "The limits are set, but the $1,000 didn't move. Nothing was spent.", actions: ["retry"] });
    expect(connectFailure("notYet", ctx).message).toBe("Agate hasn't heard from Dynamic yet. Try again in a few seconds.");
    // a late message from Dynamic never leaves the pocket's money waiting with it
    expect(connectFailure("notYet", { ...ctx, funded: true })).toEqual({ message: "Agate hasn't heard from Dynamic yet. Try again in a few seconds. Your $1,000 is in the pocket.", actions: ["retry", "takeBack"] });
    expect(connectFailure("refused", { ...ctx, funded: true })).toEqual({ message: "Agate didn't accept this connection, so Claude isn't connected. Your $1,000 is in the pocket.", actions: ["retry", "takeBack"] });
    expect(connectFailure("refused", ctx)).toEqual({ message: "Agate didn't accept this connection, so Claude isn't connected. Nothing moved.", actions: ["retry"] });
    expect(connectFailure("unchecked", ctx).message).toBe("Agate couldn't check the permission. Try again.");
    expect(connectFailure("offline", { ...ctx, funded: true }).actions).toEqual(["retry", "takeBack"]);
    expect(connectFailure("expired", { ...ctx, funded: true })).toEqual({ message: "The request ran out of time, so Claude isn't connected. Your $1,000 is in the pocket: take it back, then ask Claude to connect again.", actions: ["takeBack"] });
    expect(connectFailure("expired", ctx).actions).toEqual(["back"]);
    expect(CONNECT_COPY.requestEndedBody("Claude")).toBe("Ask Claude to connect to Agate again. Nothing was set up.");
  });

  test("after the money was taken back from the failure panel: what came back, and Start again (never a bare Try again)", () => {
    const took = { ...ctx, funded: false, tookBack: 1000 };
    expect(connectFailure("refused", took)).toEqual({ message: "Agate didn't accept this connection, so Claude isn't connected. $1,000 is back in your account.", actions: ["startAgain"] });
    expect(connectFailure("offline", took)).toEqual({ message: "Agate's AI service is offline right now. $1,000 is back in your account.", actions: ["startAgain"] });
    expect(connectFailure("expired", took)).toEqual({ message: "The request ran out of time, so Claude isn't connected. $1,000 is back in your account. Ask Claude to connect again.", actions: ["back"] });
    // whatever stopped it, a run whose money came back never offers Try again or another Take back
    const all: ConnectProblem[] = ["key", "sign", "funding", "notYet", "refused", "unchecked", "pocketInUse", "offline", "expired", "approve"];
    for (const problem of all) {
      const f = connectFailure(problem, took);
      expect(f.actions).not.toContain("retry");
      expect(f.actions).not.toContain("takeBack");
      expect(f.actions.length).toBeGreaterThan(0);
    }
  });

  test("every disconnect failure, and the done line", () => {
    const c = { ai: "Claude", amount: 742 };
    expect(disconnectFailure("stopping", c)).toEqual({ message: "Couldn't reach Agate's server, so Claude may still trade. Try again.", actions: ["retry"] });
    expect(disconnectFailure("revoking", c)).toEqual({ message: "Disconnect didn't finish. Try again.", actions: ["retry"] });
    expect(disconnectFailure("takingBack", c)).toEqual({ message: "Claude is disconnected. The $742 didn't move yet.", actions: ["takeBack"] });
    expect(disconnectDoneText({ ...c, tookBack: true, serverMissed: false })).toBe("$742 is back in your account.");
    expect(disconnectDoneText({ ...c, tookBack: false, serverMissed: false })).toBe("Its $742 stays in the pocket. Take it back any time.");
    expect(disconnectDoneText({ ...c, tookBack: true, serverMissed: true })).toBe("$742 is back in your account. Agate's server didn't answer, but Claude's trading key is off, so it can't trade.");
    expect(disconnectDoneText({ ...c, amount: 0, tookBack: false, serverMissed: false })).toBe("");
    expect(POCKET_COPY.over(8478)).toBe("More than your $8,478.");
  });
});

describe("what an AI tried: refusal rules, MCP statuses, the autopilot", () => {
  /** mcp/server.ts: a WriteError reason in the AI's words, else the reason lower-cased. */
  const MCP_RULES: Record<string, string> = { InsufficientBalance: "budget_left", InsufficientTokens: "not_enough_tokens", PriceMoved: "price_moved", ThinBook: "thin_book", AboveBand: "above_band", BelowBand: "below_band", Depth: "thin_book", DripTooSoon: "drip_too_soon", EmptyBook: "empty_book" };
  const SERVER_RULES = ["not_allowed_contract", "not_allowed_function", "over_per_trade_cap", "payee_must_be_you", "approve_router_only", "no_native_value", "daily_limit", "grant_revoked", "grant_expired", "no_market", "bad_input", "not_found"];

  test("every rule reads as a plain clause", () => {
    for (const rule of SERVER_RULES) expect(ruleText(rule)).not.toBe(FALLBACK);
    for (const reason of WRITE_REASONS) expect(ruleText(MCP_RULES[reason] ?? reason.toLowerCase())).not.toBe(FALLBACK);
    expect(ruleText("daily_limit: 5 of 5 trades used in the last 24 hours")).toBe(REFUSAL_RULES.daily_limit);
    expect(ruleText("OVER_PER_TRADE_CAP")).toBe(REFUSAL_RULES.over_per_trade_cap);
    expect(ruleText("something_new")).toBe(FALLBACK);
    expect(ruleText(null)).toBe(FALLBACK);
  });

  test("the activity lines", () => {
    expect(refusedText("daily_limit", "Claude")).toBe("Claude tried a trade that didn't go through: it had used all of its trades for the day.");
    expect(mcpStatusText("done", "Claude")).toBe("A trade went through on Monad.");
    expect(mcpStatusText("sent", "Claude")).toBe("A trade was sent and hasn't landed yet.");
    expect(mcpStatusText("reverted", "Claude")).toBe("A trade didn't go through on Monad. Nothing changed.");
    expect(mcpStatusText("refused", "Claude", "over_per_trade_cap")).toBe("Claude tried a trade that didn't go through: it would have spent more than its limit on one trade.");
    expect(mcpStatusText("needs_approval", "Claude")).toBe("Claude asked to go over its limit.");
  });

  test("the autopilot's last result", () => {
    expect(autopilotText(null)).toBe("Not run yet.");
    expect(autopilotText({ skip: "nothing due" })).toBe("Waiting: nothing needs to move yet.");
    expect(autopilotText({ skip: "daily_limit: 5 of 5 trades used" })).toBe("Waiting: it had used all of its trades for the day.");
    expect(autopilotText({ rolled: { from: "2026-11", to: "2026-12", gpuHours: 120 }, txHash: "0x1" })).toBe("Moved 120 GPU-hours from November into December.");
    expect(autopilotText({ refused: "thin_book", detail: "x" })).toBe("Didn't roll: the book couldn't fill that size.");
    expect(autopilotText({ error: "boom" })).toBe("Something went wrong. Agate tries again at the next check.");
  });
});

describe("the copy keeps the house rules", () => {
  /** Every shown string, the functions called with sample values. */
  function allCopy(): string[] {
    const out: string[] = [];
    const take = (v: unknown) => {
      if (typeof v === "string") out.push(v);
      else if (typeof v === "function") out.push(String((v as (...a: unknown[]) => unknown)("2026-10-05T14:02:00Z")));
      else if (v && typeof v === "object") Object.values(v).forEach(take);
    };
    [COPY, SIGNIN_COPY, SERVER_COPY, CONNECT_COPY, POCKET_COPY, REFUSAL_RULES].forEach(take);
    for (const p of ["key", "sign", "funding", "notYet", "refused", "unchecked", "pocketInUse", "offline", "expired", "approve"] as const) {
      for (const funded of [true, false]) out.push(connectFailure(p, { ai: "Claude", budget: 1000, funded }).message);
      out.push(connectFailure(p, { ai: "Claude", budget: 1000, funded: false, tookBack: 1000 }).message);
    }
    for (const at of ["stopping", "revoking", "takingBack"] as const) out.push(disconnectFailure(at, { ai: "Claude", amount: 742 }).message);
    out.push(thinText("2026-11", quote), movedText("buy", quote), movedText("short", quote), movedText("closeShort", quote));
    return out;
  }

  test("no em dash, no hidden words, Agate capitalized", () => {
    const text = allCopy();
    expect(text.length).toBeGreaterThan(80);
    for (const t of text) {
      expect(t.includes(String.fromCharCode(0x2014))).toBe(false);
      expect(t).not.toMatch(/sub-?account|vault|kernel|smart account|assistant|session key|user operation|\bmpc\b|paymaster/i);
      expect(t).not.toMatch(/\bagate\b/);
    }
  });
});

describe("passkey-first failures", () => {
  const err = (code: string) => Object.assign(new Error("x"), { name: "AgatePasskeyError", code });

  test("only the wallet package's codes are read", async () => {
    const { agatePasskeyCode } = await import("./errors");
    expect(agatePasskeyCode(err("cancelled"))).toBe("cancelled");
    expect(agatePasskeyCode(err("unknown_passkey"))).toBe("unknown_passkey");
    expect(agatePasskeyCode(err("something_else"))).toBeNull();
    expect(agatePasskeyCode(Object.assign(new Error("x"), { code: "cancelled" }))).toBeNull();
    expect(agatePasskeyCode(null)).toBeNull();
  });

  test("every code has its own plain line, and a cancel says which way it went", async () => {
    const { passkeyFirstText } = await import("./errors");
    const codes = ["unsupported", "cancelled", "exists", "unknown_passkey", "expired", "rate_limited", "signups_paused", "rejected", "dynamic", "service"] as const;
    const lines = codes.map((code) => passkeyFirstText({ code, mode: "create" }));
    expect(new Set(lines).size).toBe(codes.length);
    for (const l of lines) expect(l).not.toMatch(/\u2014/);
    expect(passkeyFirstText({ code: "cancelled", mode: "signin" })).toBe("No passkey signed you in.");
    expect(passkeyFirstText({ code: "cancelled", mode: "create" })).toBe("No passkey was made.");
  });

  test("Confirm it's you with an account's own passkey", async () => {
    const { passkeyConfirmText } = await import("./errors");
    expect(passkeyConfirmText(err("cancelled"))).toBe("Your passkey didn't confirm it. Try again, or Cancel.");
    expect(passkeyConfirmText(err("service"))).toBe("Agate can't be reached right now. Try again in a moment.");
  });
});
