"use client";
// The pretend account: the example wallet (store.tsx) behind the one Account shape. Sign-in runs the real sign-in
// machine (machine.ts signInReducer) with fake timings, so every sheet can be judged without the chain: any 6 digits
// sign in, a new person gets set up (wallet, then the first 10,000 test dollars), a returning one goes straight in.
// The example-only Mock row "Sign-in outcome" (config.signin) forces a wrong or expired first code, a new or returning
// person, a wallet that fails once, a first drip that does not arrive, or a slow setup. Trades are practice: send()
// records them in the example wallet. Never imports the sign-in SDK or @agate/wallet.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useMock, type OpenArgs } from "@/lib/mock/store";
import type { SignInOutcome } from "@/lib/mock/config";
import type { Position, Wallet } from "@/lib/mock/types";
import { holderPositions, positionAt } from "@/lib/mock/timeline";
import { SIGNIN_COPY } from "./errors";
import { canStart, CREATING_SLOW_MS, isCode, SIGNED_OUT, signInReducer, toAccountStep, type SignInEvent, type SignInState } from "./machine";
import { type Account, type AccountPlan, DRIP, type DoneResult, type OnStep, type Order, type SignInStep, type TicketShown, type TradeAction } from "./types";

/** Fake timings (ms), the real ones scaled down so each step can still be seen: the code arrives, the code is
 * checked, setup makes the wallet then adds the first test dollars (1.5 s in all), a trade signs then lands. */
export const PRETEND_MS = { sendCode: 800, verify: 1000, google: 600, wallet: 1100, dollars: 400, signing: 500, landing: 600 } as const;

/** The pretend main account's address (the real one is the Kernel account at index 0). Made up, never on Monad. */
export const PRETEND_ADDRESS = "0xF77c3a91d2b8e4c05f1a8e2d9b7c4a10e3d96b70";

/** The faucet pays once a day per account. */
const DAY_MS = 86_400_000;

/** Never funded and never traded: this person gets set up, like a first sign-in with the real account. */
const isNew = (w: Wallet) => w.lastDrip === null && w.positions.length === 0 && w.balance === 0;

const ACTION: Record<Exclude<Order["kind"], "drip">, TradeAction> = {
  buyLong: "openLong",
  openLongDaily: "openLongDaily",
  openShort: "openShort",
  sellLong: "closeLong",
  closeLongDaily: "closeLongDaily",
  closeShort: "closeShort",
};

/** The machine plus one pretend-only event: the Mock controls (Visitor row, ?auth=, Reset) set where sign-in stands. */
type PretendEvent = SignInEvent | { type: "force"; state: SignInState };
const pretendReducer = (s: SignInState, e: PretendEvent): SignInState => (e.type === "force" ? e.state : signInReducer(s, e));

/** Whether this sign-in sets up a new person. The failing setups are a new person's by nature. */
function setsUp(outcome: SignInOutcome, w: Wallet) {
  if (outcome === "returning") return false;
  if (outcome === "auto" || outcome === "wrong" || outcome === "expired") return isNew(w);
  return true;
}

export function usePretendAccount(): Account {
  const store = useMock();
  const { wallet, config } = store;
  const [m, dispatch] = useReducer(pretendReducer, SIGNED_OUT);
  const outcome: SignInOutcome = config.source === "example" ? config.signin : "auto";
  // "First drip fails": the setup's first test dollars are still owed, even to a wallet that already dripped today,
  // so "Get 10,000 test dollars" works at once instead of showing tomorrow's time
  const [owed, setOwed] = useState(false);

  // the latest wallet, machine state, outcome and store actions, for callbacks that stay stable across renders
  const live = useRef({ wallet, m, store, outcome, owed });
  live.current = { wallet, m, store, outcome, owed };

  // every new run (a code sent, a code checked, a setup) bumps run, so a timer left from an earlier run does nothing
  const run = useRef(0);
  // codes checked since the email step: the outcomes refuse the first one only
  const tries = useRef(0);
  // the setup's wallet step fails once under "walletfail", then works on Try again
  const walletTries = useRef(0);
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((id) => window.clearTimeout(id));
  }, []);
  const later = useCallback((ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
  }, []);
  const nextRun = useCallback(() => ++run.current, []);

  // signed in or out from the Mock controls (Visitor row, ?auth=, Reset): the machine follows the example wallet
  useEffect(() => {
    const s = live.current.m;
    if (wallet.signedIn && s.status !== "ready") {
      nextRun();
      dispatch({ type: "force", state: { status: "ready", email: wallet.email ?? undefined } });
    } else if (!wallet.signedIn && (s.status === "ready" || s.status === "signingOut")) {
      nextRun();
      dispatch({ type: "force", state: SIGNED_OUT });
    }
  }, [wallet.signedIn, wallet.email, nextRun]);

  // Mock Reset: a sign-in or setup on its way is dropped with the wallet, so no timer signs the reset wallet back in
  const seenResets = useRef(store.resets);
  useEffect(() => {
    if (store.resets === seenResets.current) return;
    seenResets.current = store.resets;
    nextRun();
    setOwed(false);
    tries.current = 0;
    walletTries.current = 0;
    dispatch({ type: "force", state: SIGNED_OUT });
  }, [store.resets, nextRun]);

  /** a new person: the wallet (fails once under "walletfail"), then the first 10,000 test dollars */
  const setUp = useCallback(
    (email: string) => {
      const r = nextRun();
      const o = live.current.outcome;
      walletTries.current += 1;
      later(PRETEND_MS.wallet * (o === "slow" ? 3 : 1), () => {
        if (r !== run.current) return;
        if (o === "walletfail" && walletTries.current === 1) {
          dispatch({ type: "walletFailed", message: SIGNIN_COPY.walletFailed });
          return;
        }
        // slow: the step reads as already past twice its time, so "Taking longer than usual" shows at once
        dispatch({ type: "walletMade", at: Date.now() - (o === "slow" ? CREATING_SLOW_MS.dollars - 1_000 : 0) });
        later(PRETEND_MS.dollars * (o === "slow" ? 4 : 1), () => {
          if (r !== run.current) return;
          const st = live.current.store;
          if (o === "dripfail") {
            dispatch({ type: "dripFailed" });
            setOwed(true);
            st.signIn(email);
            return;
          }
          dispatch({ type: "dripped" });
          st.signIn(email);
          st.drip();
        });
      });
    },
    [later, nextRun],
  );

  /** a good code (or Google): a returning person goes straight in, a new one is set up first */
  const signedIn = useCallback(
    (email: string) => {
      const o = live.current.outcome;
      const fresh = setsUp(o, live.current.wallet);
      dispatch({ type: "verified", wallet: !fresh, email, at: Date.now() - (o === "slow" ? CREATING_SLOW_MS.wallet - 1_000 : 0) });
      if (!fresh) live.current.store.signIn(email);
      else {
        walletTries.current = 0;
        setUp(email);
      }
    },
    [setUp],
  );

  const sendCode = useCallback(
    (email: string) => {
      const r = nextRun();
      later(PRETEND_MS.sendCode, () => r === run.current && dispatch({ type: "codeSent", at: Date.now() }));
      return email;
    },
    [later, nextRun],
  );

  const startSignIn = useCallback(
    (raw: string) => {
      const email = raw.trim();
      tries.current = 0;
      dispatch({ type: "open" });
      dispatch({ type: "start", email });
      sendCode(email);
    },
    [sendCode],
  );

  const verifyCode = useCallback(
    (code: string) => {
      const at = live.current.m;
      if (at.status !== "codeSent") return;
      dispatch({ type: "verify", code });
      if (!isCode(code)) return;
      tries.current += 1;
      const first = tries.current === 1;
      const r = nextRun();
      later(PRETEND_MS.verify, () => {
        if (r !== run.current) return;
        const o = live.current.outcome;
        // example: any 6 digits work, except the first code under "wrong" or "expired"
        if (first && o === "wrong") dispatch({ type: "codeRejected", problem: "wrong" });
        else if (first && o === "expired") dispatch({ type: "codeRejected", problem: "expired" });
        else signedIn(at.email);
      });
    },
    [later, nextRun, signedIn],
  );

  const resendCode = useCallback(() => {
    const at = live.current.m;
    if (at.status !== "codeSent") return;
    dispatch({ type: "resend", at: Date.now() });
    sendCode(at.email);
  }, [sendCode]);

  const otherEmail = useCallback(() => {
    nextRun();
    dispatch({ type: "otherEmail" });
  }, [nextRun]);

  const startGoogle = useCallback(() => {
    // the real account leaves for Google and finishes on the way back; here the round trip is pretended
    const r = nextRun();
    tries.current = 0;
    dispatch({ type: "open" });
    dispatch({ type: "google" });
    later(PRETEND_MS.google, () => {
      if (r !== run.current) return;
      dispatch({ type: "googleReturned" });
      later(PRETEND_MS.verify, () => r === run.current && signedIn("you@gmail.com"));
    });
  }, [later, nextRun, signedIn]);

  // passkeys here are pretended too: the browser's dialog is never opened, and the one added stays for this page
  const [passkeys, setPasskeys] = useState(0);
  const startPasskey = useCallback(() => {
    if (!canStart(live.current.m)) return;
    const r = nextRun();
    tries.current = 0;
    dispatch({ type: "open" });
    dispatch({ type: "passkey" });
    // a passkey only signs in someone who has an account: straight in, never the new-person setup
    later(PRETEND_MS.verify, () => {
      if (r !== run.current) return;
      const email = live.current.wallet.email ?? "you@example.com";
      dispatch({ type: "verified", wallet: true, email, at: Date.now() });
      live.current.store.signIn(email);
    });
  }, [later, nextRun]);
  const addPasskey = useCallback(
    () =>
      new Promise<"added">((resolve) =>
        later(PRETEND_MS.google, () => {
          setPasskeys((n) => n + 1);
          resolve("added");
        }),
      ),
    [later],
  );

  const retry = useCallback(() => {
    const at = live.current.m;
    if (at.status !== "error") return;
    dispatch({ type: "retry", at: Date.now() });
    if (at.at === "wallet") setUp(at.email ?? "");
    else if ((at.at === "init" || at.at === "sendCode") && at.email) sendCode(at.email);
  }, [setUp, sendCode]);

  const cancelSignIn = useCallback(() => {
    nextRun();
    dispatch({ type: "close" });
  }, [nextRun]);

  const signOut = useCallback(async () => {
    nextRun();
    setOwed(false);
    dispatch({ type: "signOut" });
    live.current.store.signOut();
    dispatch({ type: "signedOut" });
  }, [nextRun]);

  // the faucet: once a day, like AgateDollar.drip (the time comes from the last drip)
  const lastDrip = wallet.lastDrip ? Date.parse(wallet.lastDrip) : NaN;
  const nextDrip = owed ? null : Number.isFinite(lastDrip) ? new Date(lastDrip + DAY_MS).toISOString() : null;
  const canDrip = owed || !Number.isFinite(lastDrip) || Date.now() >= lastDrip + DAY_MS;

  // the example faucet is instant, and once a day like the real one: too soon is refused the way the client refuses
  // it (WriteError DripTooSoon), read against the clock now, not the last render
  const drip = useCallback(async () => {
    const last = live.current.wallet.lastDrip ? Date.parse(live.current.wallet.lastDrip) : NaN;
    if (!live.current.owed && Number.isFinite(last) && Date.now() < last + DAY_MS) {
      throw Object.assign(new Error(`the next drip opens at ${new Date(last + DAY_MS).toISOString()}`), { name: "WriteError", stage: "check", reason: "DripTooSoon" });
    }
    live.current.store.drip();
    setOwed(false);
    // the first test dollars came after all: the setup's "didn't arrive yet" note goes
    dispatch({ type: "dripped" });
  }, []);

  const signInAtOnce = useCallback((email: string) => live.current.store.signIn(email), []);

  // a practice plan keeps the trade it will record beside it, out of the shared plan shape
  const practice = useRef(new WeakMap<AccountPlan, OpenArgs>());
  // a practice close keeps the position and what comes back
  const closes = useRef(new WeakMap<AccountPlan, { id: string; back: number; left: number; result: Omit<DoneResult, "txHash" | "userOpHash"> }>());

  const plan = useCallback(async (order: Order, shown?: TicketShown): Promise<AccountPlan> => {
    const account = live.current.wallet.address || PRETEND_ADDRESS;
    if (order.kind === "drip") return { account, calls: [], summary: { action: "drip", maxSpend: 0, bound: { kind: "minDollarsOut", value: 0 } }, plannedAt: Date.now() };
    const action = ACTION[order.kind];
    if (!shown) throw new Error("A practice plan is made from the ticket's numbers.");
    if (action === "closeLong" || action === "closeLongDaily" || action === "closeShort") {
      // a close at the book's top: held tokens sell at the bid; a pay me daily Long sells at the bid and hands back
      // what it was paid; a Short buys back at the ask and gets the ceiling less what it was paid
      const pos = shown.close;
      if (!pos || !(shown.price > 0)) throw new Error("Can't read the market's price right now. Nothing was sent. Try again in a moment.");
      // held tokens can sell a part (the ticket's GPU-hours); a pay me daily Long or a Short closes whole
      const q = action === "closeLong" && shown.gpuHours > 0 ? Math.min(pos.q, shown.gpuHours) : pos.q;
      const cents = (x: number) => Math.round(x * 100) / 100;
      const spent = action === "closeShort" ? cents(shown.price * q) : 0;
      const received = cents(action === "closeShort" ? q * shown.cap - pos.paid : shown.price * q - (action === "closeLongDaily" ? pos.paid : 0));
      const p: AccountPlan = {
        account,
        calls: [],
        summary: {
          action,
          gpu: pos.gpu,
          month: pos.month,
          gpuHours: q,
          maxSpend: action === "closeLongDaily" ? pos.paid : spent,
          // as the real plan: the sale itself (a pay me daily Long then hands back what it was paid)
          bound: action === "closeShort" ? { kind: "maxDollarsIn", value: spent } : { kind: "minDollarsOut", value: cents(shown.price * q) },
        },
        plannedAt: Date.now(),
      };
      // a part of held tokens leaves the rest held; a whole close (or anything else) ends the holding
      const left = action === "closeLong" ? Math.max(0, Math.round((pos.q - q) * 1e4) / 1e4) : 0;
      closes.current.set(p, { id: pos.id, back: received - spent, left, result: { action, gpuHours: q, spent, received } });
      return p;
    }
    const L = shown.side === "long";
    // what the practice wallet takes: a Long pays the price, a Short puts up ceiling minus price (store.tsx open)
    const take = (L ? shown.price : shown.cap - shown.price) * shown.gpuHours;
    if (!(shown.gpuHours > 0 && shown.price > 0 && take > 0)) throw new Error("A practice trade needs a price and a size above zero.");
    const p: AccountPlan = {
      account,
      calls: [],
      summary: {
        action,
        gpu: order.gpu,
        month: order.month,
        gpuHours: shown.gpuHours,
        maxSpend: take,
        bound: L ? { kind: "minTokensOut", value: shown.gpuHours } : { kind: "minDollarsOut", value: shown.price * shown.gpuHours },
      },
      plannedAt: Date.now(),
    };
    practice.current.set(p, { gpu: order.gpu, month: order.month, side: shown.side, q: shown.gpuHours, price: shown.price, floor: shown.floor, cap: shown.cap, daily: shown.daily, backNow: shown.backNow });
    return p;
  }, []);

  const send = useCallback(
    (p: AccountPlan, onStep?: OnStep) =>
      new Promise<DoneResult>((resolve, reject) => {
        if (p.summary.action === "drip") {
          live.current.store.drip();
          resolve({ action: "drip", txHash: null, userOpHash: null, amount: DRIP });
          return;
        }
        const c = closes.current.get(p);
        if (c) {
          onStep?.("signing");
          later(PRETEND_MS.signing, () => {
            onStep?.("sending");
            later(PRETEND_MS.landing, () => {
              if (c.left > 0) live.current.store.finish(c.id, "partial", c.back, c.left);
              else live.current.store.finish(c.id, "closed", c.back);
              resolve({ ...c.result, txHash: null, userOpHash: null });
            });
          });
          return;
        }
        const a = practice.current.get(p);
        if (!a) return reject(new Error("This plan was not made by this account."));
        onStep?.("signing");
        later(PRETEND_MS.signing, () => {
          onStep?.("sending");
          later(PRETEND_MS.landing, () => {
            const pos = live.current.store.open(a);
            const L = a.side === "long";
            resolve({
              action: p.summary.action,
              txHash: null,
              userOpHash: null,
              gpuHours: a.q,
              avg: a.price,
              spent: (L ? a.price : a.cap - a.price) * a.q,
              refund: 0,
              paidNow: pos.paid,
              positionIds: [pos.id],
            });
          });
        });
      }),
    [later],
  );

  // signed in is the example wallet's own flag, so the Visitor row and ?auth= keep working as before; the machine's
  // step follows it (the effect above catches up a render later)
  const ready = wallet.signedIn;

  // Mock controls "Holds November": the Day's example holder (a Long with pay me daily, a Long, a Short), ahead of the
  // practice trades; collected ones are paid in full, closed ones gone
  const { finished, finish } = store;
  const positions = useMemo<Position[]>(() => {
    const example = config.source === "example";
    const held = example && config.holds === "nov" ? holderPositions(config.when) : [];
    // practice trades follow the Day too (paid so far, what a collect pays), as if made on the example's own morning
    const own = example ? wallet.positions.map((p) => positionAt(p, config.when)) : wallet.positions;
    // a partly sold example holding keeps what is left (what it pays scales with it)
    const sold = (p: Position) => {
      const f = finished[p.id];
      // a partial sale's size stays through a later collect (store.tsx keeps `left`)
      if (f?.how === "closed" || f?.left === undefined || !(p.q > 0)) return p;
      const r = f.left / p.q;
      return { ...p, q: f.left, paid: Math.round(p.paid * r * 100) / 100, claimable: Math.round(p.claimable * r * 100) / 100 };
    };
    return [...held.filter((p) => finished[p.id]?.how !== "closed").map(sold), ...own].map((p) => (finished[p.id]?.how === "collected" ? { ...p, paid: p.paid + p.claimable, claimable: 0 } : p));
  }, [config.source, config.holds, config.when, finished, wallet.positions]);
  const collect = useCallback(
    (p: Position) =>
      new Promise<number>((resolve) => {
        later(PRETEND_MS.signing + PRETEND_MS.landing, () => {
          finish(p.id, "collected", p.claimable);
          resolve(p.claimable);
        });
      }),
    [later, finish],
  );
  const signIn = useMemo<SignInStep>(() => {
    const step = toAccountStep(m);
    if (ready) return step.status === "ready" ? step : { status: "ready" };
    return step.status === "ready" || step.status === "signingOut" ? { status: "signedOut" } : step;
  }, [ready, m]);

  return useMemo<Account>(
    () => ({
      kind: "pretend",
      status: signIn.status,
      signIn,
      ready,
      email: wallet.email,
      owner: null,
      address: wallet.address || (ready ? PRETEND_ADDRESS : null),
      balance: wallet.balance,
      positions,
      canDrip,
      nextDrip,
      marginBalance: wallet.marginBalance,
      configured: true,
      startSignIn,
      verifyCode,
      resendCode,
      otherEmail,
      startGoogle,
      startPasskey,
      passkeys: ready ? passkeys : null,
      addPasskey,
      retry,
      cancelSignIn,
      signOut,
      drip,
      plan,
      send,
      signInAtOnce,
      collect,
    }),
    [signIn, ready, wallet, positions, canDrip, nextDrip, startSignIn, verifyCode, resendCode, otherEmail, startGoogle, startPasskey, passkeys, addPasskey, retry, cancelSignIn, signOut, drip, plan, send, signInAtOnce, collect],
  );
}
