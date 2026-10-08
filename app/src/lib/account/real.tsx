"use client";
// The real account (wallet spec 2, 3.1, 4): Dynamic's headless email code (or Google, or a passkey added earlier) signs
// the person in, their main embedded wallet owns the main account (Kernel v3.1, index 0) on Monad testnet, and trades
// are the client's plans sent as one sponsored user operation. The same sign-in machine as the pretend account (machine.ts), so every sheet
// reads the same steps. A new person is set up once: the wallet, then the first 10,000 test dollars (their own drip).
// Inert while the data source is example: no SDK download, no queries.
import type { AgateClient, Wallet } from "@agate/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { UserOperationReceipt } from "viem/account-abstraction";
import { getAgate } from "@/lib/data/agate";
import type { Gpu } from "@/lib/mock/types";
import { getDynamic, googlePending, markGoogle, readHint, REAL_CONFIGURED, writeHint, type Dyn, type Hint } from "./dynamic";
import { codeProblemOf, passkeyProblemOf, sendCodeProblemOf, SIGNIN_COPY } from "./errors";
import { canStart, cleanCode, GETTING_READY_MS, isCode, ordersAfter, refreshDue, restingKey, RESTORE_PATIENCE_MS, SIGNED_OUT, signInReducer, toAccountStep, withoutResting, type SignInState } from "./machine";
import { forgetClients, mainAddressOf, sendCalls } from "./main";
import type { Account, AccountPlan, DoneResult, LimitDone, LimitOrder, LimitPlan, OnStep, Order, RestingOrder, SignInStep, TradeAction } from "./types";

type EmailOtp = Awaited<ReturnType<Dyn["lib"]["startEmailSignIn"]>>;

/** Google's way back is finished once per page, whatever Strict Mode's double effects do. */
let googleFinish: Promise<boolean> | null = null;

const reverted = () => Object.assign(new Error("the operation landed and reverted"), { name: "WriteError", reason: "reverted", stage: "receipt" });

/** What a landed trade did, from its own logs (readResult), in the Done sheet's words. */
function doneOf(action: TradeAction, x: Record<string, unknown>, r: UserOperationReceipt): DoneResult {
  const n = (k: string) => (typeof x[k] === "number" ? (x[k] as number) : undefined);
  const base = { action, txHash: r.receipt.transactionHash, userOpHash: r.userOpHash };
  const ids = Array.isArray(x.positionIds) ? (x.positionIds as string[]) : undefined;
  switch (action) {
    case "openLong":
      return { ...base, gpuHours: n("gpuHours"), spent: n("spent"), refund: n("refund"), avg: n("avgPrice") };
    case "openLongDaily":
      return { ...base, gpuHours: n("gpuHours"), spent: n("spent"), refund: n("refund"), avg: n("avgPrice"), paidNow: n("paidNow"), positionIds: ids };
    case "openShort":
      return { ...base, gpuHours: n("gpuHours"), spent: n("spent"), received: n("received"), avg: n("avgPrice"), positionIds: ids };
    case "closeLong":
      return { ...base, gpuHours: n("gpuHours"), received: n("received"), avg: n("avgPrice") };
    case "closeLongDaily": {
      const received = (n("received") ?? 0) + (n("paid") ?? 0);
      return { ...base, received, net: received - (n("cost") ?? 0) };
    }
    case "closeShort":
      return { ...base, spent: n("spent"), refund: n("refund"), received: n("paid"), net: (n("paid") ?? 0) - (n("spent") ?? 0) };
    case "drip":
      return { ...base, amount: n("amount") };
  }
}

/** The client's plan for an order, from the main account. */
async function planOf(agate: AgateClient, me: `0x${string}`, order: Order) {
  const c = await import("@agate/client");
  if (order.kind === "drip") return c.planDrip(agate, me);
  const on = { gpu: order.gpu as Gpu, month: order.month };
  switch (order.kind) {
    case "buyLong":
      return c.planBuyLong(agate, me, { ...on, dollars: order.dollars, minGpuHours: order.minGpuHours, maxPrice: order.maxPrice, slippageBps: order.slippageBps });
    case "openLongDaily":
      return c.planOpenLongDaily(agate, me, { ...on, dollars: order.dollars, parts: order.parts, minGpuHours: order.minGpuHours, maxPrice: order.maxPrice, slippageBps: order.slippageBps });
    case "openShort":
      return c.planOpenShort(agate, me, { ...on, gpuHours: order.gpuHours, parts: order.parts, daily: order.daily, minDollars: order.minDollars, minPrice: order.minPrice, slippageBps: order.slippageBps });
    case "sellLong":
      return c.planSellLong(agate, me, { ...on, gpuHours: order.gpuHours, minDollars: order.minDollars });
    case "closeLongDaily":
      return c.planCloseLongDaily(agate, me, { ...on, positionIds: order.positionIds, minDollars: order.minDollars });
    case "closeShort":
      return c.planCloseShort(agate, me, { ...on, positionIds: order.positionIds, maxDollars: order.maxDollars });
  }
}

/** The client's three limit builders (a test hands in its own). */
export type LimitBuilders = Pick<typeof import("@agate/client"), "planPlaceLimit" | "planCancelLimit" | "planWithdrawMargin">;

/** The client's limit batch for a limit order, from the main account. A bid or an ask is post-only (it rests, never
 *  takes: the ticket sends an order that fills now through Review instead); an ask mints the pairs it sells, so it
 *  opens a Short and never sells a Long held beside it; a cancel takes what it frees back in the same batch. */
export async function limitPlanOf(agate: AgateClient, me: `0x${string}`, order: LimitOrder, c: LimitBuilders | null = null): Promise<LimitPlan> {
  const b = c ?? (await import("@agate/client"));
  const p =
    order.kind === "placeLimit"
      ? await b.planPlaceLimit(agate, me, { gpu: order.gpu as Gpu, month: order.month, side: order.side, price: order.price, gpuHours: order.gpuHours, postOnly: true, mint: order.side === "short" })
      : order.kind === "cancelLimit"
        ? await b.planCancelLimit(agate, me, { gpu: order.gpu as Gpu, month: order.month, orderIds: order.orderIds, withdraw: true })
        : await b.planWithdrawMargin(agate, me, { asset: order.asset === "dollar" ? "dollar" : { gpu: order.asset.gpu as Gpu, month: order.asset.month } });
  return { account: p.account, calls: p.calls.map((x) => ({ to: x.to, value: x.value, data: x.data, label: x.label })), summary: { ...p.summary, action: p.summary.action as LimitOrder["kind"] }, plannedAt: Date.now() };
}

/** What a landed limit batch did, from its own logs (readResult) and its plan (what a cancel or withdraw took back). */
function limitDoneOf(p: LimitPlan, x: Record<string, unknown>, r: UserOperationReceipt): LimitDone {
  const base = { action: p.summary.action, txHash: r.receipt.transactionHash, userOpHash: r.userOpHash };
  if (p.summary.action === "placeLimit") return { ...base, orderId: typeof x.orderId === "string" ? x.orderId : "" };
  const cancelled = Array.isArray(x.cancelled) ? (x.cancelled as string[]) : p.summary.cancelled;
  return p.summary.action === "cancelLimit" ? { ...base, cancelled, withdrawn: p.summary.withdrawn } : { ...base, withdrawn: p.summary.withdrawn };
}

/** withOrders: Pro is on, the only place resting orders show, so only then are they read (without the indexer the
 *  client scans each book's newest order ids on chain). */
export function useRealAccount(active: boolean, withOrders = false): Account {
  const qc = useQueryClient();
  // the server cannot see the restore hint, so the server's render and the first one here start as restoring (the
  // nav's skeleton): a returning person never sees "Sign in" flash; without a hint it drops to signed out on mount
  const [m, dispatch] = useReducer(signInReducer, active, (a): SignInState => (a ? { status: "restoring", since: 0 } : SIGNED_OUT));
  // who is signed in: the embedded wallet (owner) and the main account it owns; from the hint while restoring
  const [who, setWho] = useState<Hint | null>(null);
  // the Dynamic client is up (it loads only for a hint, Google's way back, or the sign-in sheet)
  const [dynUp, setDynUp] = useState(false);
  const live = useRef({ m, who });
  live.current = { m, who };

  // every new run (a code sent, a code checked, a setup) bumps run, so a late answer from an earlier one does nothing
  const run = useRef(0);
  const nextRun = useCallback(() => ++run.current, []);
  const otp = useRef<EmailOtp | null>(null);

  const dyn = useCallback(async () => {
    const d = await getDynamic();
    setDynUp(true);
    return d;
  }, []);

  // ===== the wallet read (spec 2.6): balance, positions and the faucet, every 30 s while visible =====
  const address = who?.address ?? null;
  const wallet = useQuery({
    queryKey: ["live", "wallet", address ?? ""],
    queryFn: async () => (await getAgate()).getWallet(address!),
    enabled: active && !!address,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 2,
  });

  // ===== the resting orders on Kuru (Pro's Open orders), every 30 s while visible and Pro is on =====
  const orders = useQuery({
    queryKey: ["live", "orders", address ?? ""],
    queryFn: async (): Promise<RestingOrder[]> => (await (await getAgate()).openOrders(address!)).map((o) => ({ id: restingKey(o.gpu, o.month, o.id), orderId: o.id, gpu: o.gpu as Gpu, month: o.month, side: o.side, price: o.price, q: o.q, placedAt: o.placedAt, filled: o.filled })),
    enabled: active && withOrders && !!address,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 2,
  });

  /** Every receipt changes what the account holds and what the market shows: read again now (unless the screen was
   *  just told what changed: a read this early can still be a block behind), and again as the indexer catches up. */
  const afterReceipt = useCallback(
    (now = true) => {
      // markets and books skip Agate's snapshot for 20 s (and never take one read before this), so they show the
      // trade at once instead of the book from before it; the wallet's own sends cannot tell the client themselves
      void getAgate().then((a) => a.freshReads(), () => {});
      const again = () => void qc.invalidateQueries({ queryKey: ["live"] });
      if (now) again();
      window.setTimeout(again, 4_000);
      window.setTimeout(again, 12_000);
    },
    [qc],
  );

  const forget = useCallback(() => {
    writeHint(null);
    setWho(null);
    forgetClients();
    qc.removeQueries({ queryKey: ["live", "wallet"] });
    qc.removeQueries({ queryKey: ["live", "orders"] });
    qc.removeQueries({ queryKey: ["live", "pocket"] });
    qc.removeQueries({ queryKey: ["server"] });
    qc.removeQueries({ queryKey: ["dynamic"] });
  }, [qc]);

  /** Signed in with a main wallet: the main account's address, and the hint for the next load. */
  const settle = useCallback(async ({ lib, client }: Dyn): Promise<Hint | null> => {
    const ws = lib.wallets(client);
    if (!ws) return null;
    const owner = ws.main.address;
    const address = await mainAddressOf(owner);
    const h: Hint = { owner, address, email: client.user?.email ?? null };
    writeHint(h);
    setWho(h);
    return h;
  }, []);

  const dripFrom = useCallback(
    async (h: Hint, onStep?: OnStep) => {
      const agate = await getAgate();
      const p = await planOf(agate, h.address as `0x${string}`, { kind: "drip" });
      const r = await sendCalls(h.owner, 0, h.address, p.calls, onStep);
      if (!r.success) {
        afterReceipt();
        throw reverted();
      }
      // the dollars show at once (spec 2.7), so "You're set" never reads $0 while the wallet read catches up
      const { readResult } = await import("@agate/client");
      const amount = Number(readResult(agate, "drip", r.logs).amount ?? 0);
      const at = Date.now();
      qc.setQueryData<Wallet>(["live", "wallet", h.address], (w) => (w ? { ...w, balance: w.balance + amount, canDrip: false, lastDrip: new Date(at).toISOString(), nextDrip: new Date(at + 86_400_000).toISOString() } : w));
      afterReceipt(false);
      return r;
    },
    [afterReceipt, qc],
  );

  /** A new person (spec 4.3): the wallet, then the first 10,000 test dollars. */
  const setUp = useCallback(
    async (d: Dyn) => {
      const r = nextRun();
      let h: Hint | null;
      try {
        await d.lib.ensureMainWallet(d.client);
        h = await settle(d);
        if (!h) throw new Error("no wallet after making one");
      } catch {
        if (r === run.current) dispatch({ type: "walletFailed", message: SIGNIN_COPY.walletFailed });
        return;
      }
      if (r !== run.current) return;
      dispatch({ type: "walletMade", at: Date.now() });
      try {
        await dripFrom(h);
        if (r === run.current) dispatch({ type: "dripped" });
      } catch {
        if (r === run.current) dispatch({ type: "dripFailed" });
      }
    },
    [nextRun, settle, dripFrom],
  );

  /** A session is there (a code, Google, or a restore): ready with a wallet, or set up first. */
  const signedIn = useCallback(
    async (d: Dyn, via: "verified" | "restored") => {
      const user = !!d.client.user && !!d.lib.sessionToken(d.client);
      const ws = user ? d.lib.wallets(d.client) : null;
      const email = d.client.user?.email ?? undefined;
      if (!user) {
        if (via === "restored") {
          forget();
          dispatch({ type: "restored", user: false, wallet: false, at: Date.now() });
        }
        return;
      }
      if (ws) await settle(d);
      dispatch(via === "restored" ? { type: "restored", user: true, wallet: !!ws, email, at: Date.now() } : { type: "verified", wallet: !!ws, email, at: Date.now() });
      if (!ws) void setUp(d);
    },
    [forget, settle, setUp],
  );

  // ===== on load (spec 2.5): a hint restores, Google's way back finishes, otherwise nothing loads =====
  useEffect(() => {
    if (!active) return;
    const hint = readHint();
    const google = googlePending();
    if (hint) setWho(hint);
    dispatch({ type: "mount", hint: !!hint, at: Date.now() });
    if (!hint && !google) {
      dispatch({ type: "restored", user: false, wallet: false, at: Date.now() });
      return;
    }
    const slow = window.setTimeout(() => dispatch({ type: "restoreSlow" }), RESTORE_PATIENCE_MS);
    let gone = false;
    (async () => {
      let d: Dyn;
      try {
        d = await dyn();
      } catch {
        return; // restoreSlow shows signed out; the hint stays for the next load
      }
      if (gone) return;
      if (google) {
        markGoogle(false);
        dispatch({ type: "googleReturned" });
        let finished = false;
        try {
          googleFinish ??= d.lib.finishGoogleSignIn(d.client, window.location.href);
          finished = await googleFinish;
          // Dynamic's own query parameters go once read, so a reload never finishes it twice
          const url = new URL(window.location.href);
          [...url.searchParams.keys()].filter((k) => /^dynamic/i.test(k)).forEach((k) => url.searchParams.delete(k));
          window.history.replaceState(null, "", url.toString());
        } catch {
          dispatch({ type: "googleFailed", message: SIGNIN_COPY.google });
          return;
        }
        if (gone) return;
        if (!finished && !d.client.user) {
          dispatch({ type: "googleFailed", message: SIGNIN_COPY.google });
          return;
        }
        try {
          await signedIn(d, "verified");
        } catch {
          dispatch({ type: "googleFailed", message: SIGNIN_COPY.google });
        }
        return;
      }
      try {
        await signedIn(d, "restored");
      } catch {
        dispatch({ type: "restoreSlow" }); // signed out for now; the hint stays for the next load
      }
    })().finally(() => window.clearTimeout(slow));
    return () => {
      gone = true;
      window.clearTimeout(slow);
    };
  }, [active, dyn, signedIn]);

  // ===== the session (spec 2.5): signed out anywhere ends it here; it is refreshed before it runs out =====
  useEffect(() => {
    if (!active || !dynUp) return;
    let off: (() => void) | undefined;
    let gone = false;
    void getDynamic().then(({ lib, client }) => {
      if (gone) return;
      off = lib.onSessionEvent(client, (e) => {
        if (e.kind !== "signed-out") return;
        if (live.current.m.status === "signingOut") return;
        nextRun();
        forget();
        dispatch({ type: "loggedOut", reason: e.reason });
      });
    });
    return () => {
      gone = true;
      off?.();
    };
  }, [active, dynUp, forget, nextRun]);

  const status = m.status;
  useEffect(() => {
    if (!active || status !== "ready") return;
    const check = () =>
      void getDynamic()
        .then(({ lib, client }) => {
          const ends = lib.sessionExpiresAt(client)?.getTime() ?? null;
          if (refreshDue(ends, Date.now())) return lib.refreshSession(client);
        })
        .catch(() => {});
    const id = window.setInterval(check, 60_000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", check);
    };
  }, [active, status]);

  // ===== the sign-in sheet's taps =====

  const sendCode = useCallback(
    async (email: string) => {
      const r = nextRun();
      const ready = window.setTimeout(() => r === run.current && dispatch({ type: "gettingReady" }), GETTING_READY_MS);
      let d: Dyn;
      try {
        d = await dyn();
      } catch (e) {
        window.clearTimeout(ready);
        if (r === run.current) dispatch({ type: "sendFailed", at: "init", message: SIGNIN_COPY[sendCodeProblemOf(e, "init")] });
        return;
      }
      window.clearTimeout(ready);
      if (r !== run.current) return;
      // a session already here (another tab signed in): no code needed
      if (d.client.user && d.lib.sessionToken(d.client)) return signedIn(d, "verified");
      try {
        otp.current = await d.lib.startEmailSignIn(d.client, email);
        if (r === run.current) dispatch({ type: "codeSent", at: Date.now() });
      } catch (e) {
        if (r === run.current) dispatch({ type: "sendFailed", at: "sendCode", message: SIGNIN_COPY[sendCodeProblemOf(e, "send")] });
      }
    },
    [dyn, nextRun, signedIn],
  );

  const startSignIn = useCallback(
    (raw: string) => {
      const email = raw.trim();
      dispatch({ type: "open" });
      dispatch({ type: "start", email });
      void sendCode(email);
    },
    [sendCode],
  );

  const verifyCode = useCallback(
    (code: string) => {
      const at = live.current.m;
      if (at.status !== "codeSent") return;
      dispatch({ type: "verify", code });
      if (!isCode(code) || !otp.current) return;
      const r = nextRun();
      const sent = otp.current;
      void (async () => {
        try {
          const d = await dyn();
          await d.lib.finishEmailSignIn(d.client, sent, cleanCode(code));
          if (r !== run.current) return;
          await signedIn(d, "verified");
        } catch (e) {
          if (r === run.current) dispatch({ type: "codeRejected", problem: codeProblemOf(e) });
        }
      })();
    },
    [dyn, nextRun, signedIn],
  );

  const resendCode = useCallback(() => {
    const at = live.current.m;
    if (at.status !== "codeSent") return;
    dispatch({ type: "resend", at: Date.now() });
    void sendCode(at.email);
  }, [sendCode]);

  const otherEmail = useCallback(() => {
    nextRun();
    dispatch({ type: "otherEmail" });
  }, [nextRun]);

  const startGoogle = useCallback(() => {
    nextRun();
    dispatch({ type: "open" });
    dispatch({ type: "google" });
    void (async () => {
      try {
        const d = await dyn();
        // finishing Google while signed in LINKS that Google account instead: sign out first (wallet package note)
        if (d.client.user) await d.lib.signOut(d.client).catch(() => {});
        markGoogle(true);
        await d.lib.startGoogleSignIn(d.client, window.location.href);
      } catch {
        markGoogle(false);
        dispatch({ type: "googleFailed", message: SIGNIN_COPY.google });
      }
    })();
  }, [dyn, nextRun]);

  const startPasskey = useCallback(() => {
    // only where a sign-in may start: a passkey that signed in while the machine was elsewhere (still signing out,
    // say) would leave Dynamic signed in under a screen that says signed out
    if (!canStart(live.current.m)) return;
    const r = nextRun();
    dispatch({ type: "open" });
    dispatch({ type: "passkey" });
    void (async () => {
      let d: Dyn;
      try {
        d = await dyn();
      } catch {
        if (r === run.current) dispatch({ type: "passkeyFailed", message: SIGNIN_COPY.init });
        return;
      }
      if (r !== run.current) return;
      // a session already here (another tab signed in) needs no passkey; otherwise the browser's dialog first
      if (!(d.client.user && d.lib.sessionToken(d.client))) {
        try {
          await d.lib.startPasskeySignIn(d.client);
        } catch (e) {
          if (r === run.current) dispatch({ type: "passkeyFailed", message: SIGNIN_COPY[passkeyProblemOf(e)] });
          return;
        }
        if (r !== run.current) return;
      }
      try {
        await signedIn(d, "verified");
      } catch {
        // signed in to Dynamic, but the account could not be read: sign that out too, so the screen and Dynamic agree
        // (a later code would otherwise sign into this account whatever email it was for)
        await d.lib.signOut(d.client).catch(() => {});
        if (r === run.current) dispatch({ type: "passkeyFailed", message: SIGNIN_COPY.service });
      }
    })();
  }, [dyn, nextRun, signedIn]);

  const retry = useCallback(() => {
    const at = live.current.m;
    if (at.status !== "error") return;
    dispatch({ type: "retry", at: Date.now() });
    if (at.at === "wallet") void dyn().then(setUp, () => dispatch({ type: "walletFailed", message: SIGNIN_COPY.walletFailed }));
    else if ((at.at === "init" || at.at === "sendCode") && at.email) void sendCode(at.email);
  }, [dyn, setUp, sendCode]);

  const cancelSignIn = useCallback(() => {
    nextRun();
    dispatch({ type: "close" });
  }, [nextRun]);

  const signOut = useCallback(async () => {
    nextRun();
    dispatch({ type: "signOut" });
    try {
      const d = await getDynamic();
      await d.lib.signOut(d.client);
    } catch {
      // signing out always completes here; the session is dropped with the hint
    }
    forget();
    dispatch({ type: "signedOut" });
  }, [forget, nextRun]);

  // ===== writes: allowed only when ready =====

  const ready = m.status === "ready" && !!who;
  const need = useCallback(() => {
    const h = live.current.who;
    if (live.current.m.status !== "ready" || !h) throw Object.assign(new Error("sign in again"), { name: "UserNotAuthenticatedError" });
    return h;
  }, []);

  // ===== passkeys on the account: how many, and adding one for next time =====
  const passkeys = useQuery({
    queryKey: ["dynamic", "passkeys", address ?? ""],
    queryFn: async () => {
      const d = await getDynamic();
      return d.lib.passkeyCount(d.client);
    },
    enabled: ready && dynUp,
    staleTime: Infinity,
    retry: 1,
  });

  // the "Confirm it's you" code sent for adding a passkey, until it is used
  const passkeyOtp = useRef<EmailOtp | null>(null);
  const addPasskey = useCallback(
    async (code?: string): Promise<"added" | "code"> => {
      const h = need();
      const d = await dyn();
      if (code !== undefined) {
        if (!passkeyOtp.current) throw new Error("no code was sent for this");
        try {
          await d.lib.confirmStepUp(d.client, passkeyOtp.current, cleanCode(code), ["credential:link"]);
        } catch (e) {
          throw Object.assign(new Error("the code did not confirm"), { name: "PasskeyCodeError", cause: e });
        }
        passkeyOtp.current = null;
      } else if (!d.lib.canAddPasskey(d.client)) {
        // a person who has a passkey confirms with it (Dynamic refuses a code then): its dialog, then the new one's
        if ((await d.lib.passkeyCount(d.client).catch(() => 0)) > 0) await d.lib.confirmWithPasskey(d.client, ["credential:link"]);
        else {
          const email = d.client.user?.email ?? h.email;
          if (!email) throw new Error("no email to confirm with");
          passkeyOtp.current = await d.lib.requestStepUp(d.client, email);
          return "code";
        }
      }
      await d.lib.addPasskey(d.client);
      await qc.invalidateQueries({ queryKey: ["dynamic", "passkeys"] });
      return "added";
    },
    [need, dyn, qc],
  );

  const drip = useCallback(async () => {
    await dripFrom(need());
    // the first test dollars came after all: the setup's "didn't arrive yet" note goes
    dispatch({ type: "dripped" });
  }, [dripFrom, need]);

  const plan = useCallback(
    async (order: Order): Promise<AccountPlan> => {
      const h = need();
      const p = await planOf(await getAgate(), h.address as `0x${string}`, order);
      return {
        account: p.account,
        calls: p.calls.map((c) => ({ to: c.to, value: c.value, data: c.data, label: c.label })),
        summary: { ...p.summary, action: p.summary.action as TradeAction },
        plannedAt: Date.now(),
      };
    },
    [need],
  );

  const send = useCallback(
    async (p: AccountPlan, onStep?: OnStep): Promise<DoneResult> => {
      const h = need();
      if (p.account.toLowerCase() !== h.address.toLowerCase()) throw new Error("This plan was not made by this account.");
      const r = await sendCalls(h.owner, 0, h.address, p.calls, onStep);
      afterReceipt();
      if (!r.success) throw reverted();
      const [agate, { readResult }] = await Promise.all([getAgate(), import("@agate/client")]);
      return doneOf(p.summary.action, readResult(agate, p.summary.action, r.logs), r);
    },
    [need, afterReceipt],
  );

  // ===== Pro's limit orders: planned and sent like a trade, without a Review sheet (machine.ts limitReducer) =====

  const planLimit = useCallback(
    async (order: LimitOrder): Promise<LimitPlan> => {
      const h = need();
      return limitPlanOf(await getAgate(), h.address as `0x${string}`, order);
    },
    [need],
  );

  const sendLimit = useCallback(
    async (p: LimitPlan, onStep?: OnStep): Promise<LimitDone> => {
      const h = need();
      if (p.account.toLowerCase() !== h.address.toLowerCase()) throw new Error("This plan was not made by this account.");
      const r = await sendCalls(h.owner, 0, h.address, p.calls, onStep);
      if (!r.success) {
        afterReceipt();
        throw reverted();
      }
      const [agate, { readResult }] = await Promise.all([getAgate(), import("@agate/client")]);
      const done = limitDoneOf(p, readResult(agate, p.summary.action, r.logs), r);
      // the open orders show the change at once (a read this early can still be a block behind and drop a new order);
      // the wallet reads again now, everything again as the indexer catches up
      qc.setQueryData<RestingOrder[]>(["live", "orders", h.address], (list) => (list ? ordersAfter(list, p, done, Date.now()) : list));
      void qc.invalidateQueries({ queryKey: ["live", "wallet"] });
      afterReceipt(false);
      return done;
    },
    [need, afterReceipt, qc],
  );

  const signIn = useMemo<SignInStep>(() => toAccountStep(m), [m]);
  const w = wallet.data;
  const email = who?.email ?? ("email" in m && m.email ? m.email : null);

  return useMemo<Account>(
    () => ({
      kind: "real",
      status: signIn.status,
      signIn,
      ready,
      email,
      owner: who?.owner ?? null,
      address,
      balance: w?.balance ?? 0,
      walletLoading: !!address && wallet.isPending,
      // a resting Short's unsold half is not a position yet (machine.ts withoutResting; orders are read in Pro only)
      positions: withoutResting(w?.positions ?? [], orders.data ?? []),
      canDrip: w?.canDrip ?? false,
      nextDrip: w?.nextDrip ?? null,
      marginBalance: w?.marginBalance ?? 0,
      configured: REAL_CONFIGURED,
      startSignIn,
      verifyCode,
      resendCode,
      otherEmail,
      startGoogle,
      startPasskey,
      // a count that can't be read offers "Add a passkey" (a second one is harmless) rather than a skeleton for good
      passkeys: passkeys.data ?? (passkeys.isError ? 0 : null),
      addPasskey,
      retry,
      cancelSignIn,
      signOut,
      drip,
      plan,
      send,
      orders: ready ? (orders.data ?? []) : [],
      planLimit,
      sendLimit,
    }),
    [signIn, ready, email, who, address, w, wallet.isPending, startSignIn, verifyCode, resendCode, otherEmail, startGoogle, startPasskey, passkeys.data, passkeys.isError, addPasskey, retry, cancelSignIn, signOut, drip, plan, send, orders.data, planLimit, sendLimit],
  );
}
