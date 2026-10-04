"use client";
// Sign in, test dollars, review, place, done: the sheets every Markets variant shares.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { DRIP, useMock } from "@/lib/mock/store";
import { fmtHours } from "@/lib/size";
import { int, usd, usd0 } from "@/lib/format";
import { monthName } from "./PriceChart";
import type { TradeNumbers } from "./useTrade";

type Sheet =
  | { kind: "signin"; then?: TradeNumbers }
  | { kind: "funds"; then: TradeNumbers }
  | { kind: "review"; n: TradeNumbers }
  | { kind: "placing"; n: TradeNumbers }
  | { kind: "done"; n: TradeNumbers }
  | { kind: "account" };

interface FlowCtx {
  submit: (n: TradeNumbers) => void;
  openAccount: () => void;
  openSignIn: () => void;
}
const Ctx = createContext<FlowCtx | null>(null);
export const useFlow = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useFlow outside TradeFlow");
  return c;
};

export function TradeFlow({ children }: { children: React.ReactNode }) {
  const { wallet, signIn, signOut, drip, open, config } = useMock();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const close = () => setSheet(null);

  const submit = useCallback(
    (n: TradeNumbers) => {
      if (!(n.hours > 0)) return;
      if (!wallet.signedIn) return setSheet({ kind: "signin", then: n });
      if (wallet.balance < n.outlay) return setSheet({ kind: "funds", then: n });
      setSheet({ kind: "review", n });
    },
    [wallet.signedIn, wallet.balance],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet((s) => (s?.kind === "placing" ? s : null));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (sheet?.kind !== "placing") return;
    const n = sheet.n;
    const t = setTimeout(() => {
      open({ gpu: n.series.gpu, month: n.series.month, side: n.side, q: n.hours, price: n.price, floor: n.series.floor, cap: n.series.cap, daily: n.daily });
      setSheet({ kind: "done", n });
    }, 1100);
    return () => clearTimeout(t);
  }, [sheet, open]);

  return (
    <Ctx.Provider value={{ submit, openAccount: () => setSheet({ kind: "account" }), openSignIn: () => setSheet({ kind: "signin" }) }}>
      {children}
      {sheet && (
        <div className={`ag-backdrop ${config.theme === "dark" ? "tone-dark" : "tone-light"}`} onClick={(e) => e.target === e.currentTarget && sheet.kind !== "placing" && close()}>
          <div className="ag-sheet" role="dialog" aria-modal="true">
            {sheet.kind === "signin" && <SignIn onDone={(email) => { signIn(email); setSheet(sheet.then ? { kind: "funds", then: sheet.then } : { kind: "account" }); }} onClose={close} />}
            {sheet.kind === "funds" && (
              <Funds
                need={sheet.then.outlay}
                balance={wallet.balance}
                onDrip={() => {
                  drip();
                  setSheet(wallet.balance + DRIP >= sheet.then.outlay ? { kind: "review", n: sheet.then } : { kind: "funds", then: sheet.then });
                }}
                onReview={() => setSheet({ kind: "review", n: sheet.then })}
                onClose={close}
              />
            )}
            {sheet.kind === "review" && <Review n={sheet.n} onConfirm={() => setSheet({ kind: "placing", n: sheet.n })} onBack={close} />}
            {sheet.kind === "placing" && <Placing n={sheet.n} />}
            {sheet.kind === "done" && <Done n={sheet.n} onClose={close} />}
            {sheet.kind === "account" && (
              <Account
                email={wallet.email}
                balance={wallet.balance}
                positions={wallet.positions.length}
                onDrip={drip}
                onSignOut={() => {
                  signOut();
                  close();
                }}
                onClose={close}
              />
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

function SignIn({ onDone, onClose }: { onDone: (email: string) => void; onClose: () => void }) {
  const [email, setEmail] = useState("");
  return (
    <form
      className="grid gap-[18px]"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(email || "you@example.com");
      }}
    >
      <h2>Sign in to trade</h2>
      <p>Use your email. We set up your wallet and pay the network fees, so there is nothing to install.</p>
      <input id="email" className="ag-input" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      <button className="ag-btn ag-btn--primary ag-btn--lg" type="submit">
        Continue with email
      </button>
      <button className="ag-btn ag-btn--ghost ag-btn--lg" type="button" onClick={() => onDone("you@gmail.com")}>
        Continue with Google
      </button>
      <button className="ag-btn" type="button" style={{ background: "transparent", color: "var(--mute)" }} onClick={onClose}>
        Not now
      </button>
    </form>
  );
}

function Funds({ need, balance, onDrip, onReview, onClose }: { need: number; balance: number; onDrip: () => void; onReview: () => void; onClose: () => void }) {
  const enough = balance >= need;
  return (
    <>
      <h2>{enough ? "You're set" : "Get test dollars"}</h2>
      <p>
        Agate runs on Monad's test network, so trades use test dollars. You get {int(DRIP)} a day for free.
        {!enough && ` This trade needs ${usd0(need)} and you have ${usd0(balance)}.`}
      </p>
      {enough ? (
        <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onReview}>
          Review trade
        </button>
      ) : (
        <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onDrip}>
          Get {int(DRIP)} test dollars
        </button>
      )}
      <button className="ag-btn" style={{ background: "transparent", color: "var(--mute)" }} onClick={onClose}>
        Not now
      </button>
    </>
  );
}

export function sideLabel(n: TradeNumbers) {
  return `${n.side === "long" ? "Long" : "Short"} ${n.series.gpu}, ${monthName(n.series.month)}`;
}

function Review({ n, onConfirm, onBack }: { n: TradeNumbers; onConfirm: () => void; onBack: () => void }) {
  const L = n.side === "long";
  return (
    <>
      <h2>{sideLabel(n)}</h2>
      <div className="ag-rows">
        <div>
          <span>Size</span>
          <span>
            {fmtHours(n.hours)} GPU-hours at {usd(n.price)}
          </span>
        </div>
        <div>
          <span>{L ? "You pay" : "You put up"}</span>
          <span>{usd0(n.outlay)}</span>
        </div>
        {n.daily && (
          <div>
            <span>{L ? "Back right away" : "Paid out"}</span>
            <span>{L ? usd0(n.backNow) : "Every morning"}</span>
          </div>
        )}
        <div>
          <span>Most you can lose</span>
          <span>{usd0(n.maxLoss)}</span>
        </div>
        <div>
          <span>Most you can make</span>
          <span>{usd0(n.maxGain)}</span>
        </div>
      </div>
      <p style={{ fontSize: 15 }}>
        {L
          ? `You get ${monthName(n.series.month)}'s average ${n.series.gpu} price for every GPU-hour, between ${usd(n.series.floor)} and ${usd(n.series.cap)}.`
          : `You get ${usd(n.series.cap)} minus ${monthName(n.series.month)}'s average for every GPU-hour, so you gain when the average comes in below ${usd(n.price)}.`}{" "}
        {n.daily ? "Paid a share every morning. This locks the market rate, not your bill." : `Paid once, after ${monthName(n.series.month)} ends.`}
      </p>
      <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onConfirm}>
        Confirm {L ? "Long" : "Short"}
      </button>
      <button className="ag-btn ag-btn--ghost" onClick={onBack}>
        Back
      </button>
    </>
  );
}

function Placing({ n }: { n: TradeNumbers }) {
  return (
    <div className="grid justify-items-center gap-4 py-6 text-center">
      <span className="ag-spinner" />
      <h2>Placing your order</h2>
      <p>
        {n.side === "long" ? "Buying" : "Selling"} {fmtHours(n.hours)} {n.series.symbol} on Monad. This takes about a second.
      </p>
    </div>
  );
}

function Done({ n, onClose }: { n: TradeNumbers; onClose: () => void }) {
  const L = n.side === "long";
  return (
    <>
      <svg className="ag-done" viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
        <circle cx="24" cy="24" r="22" />
        <path d="M14 24.5l7 7 13-14" />
      </svg>
      <h2>You're {L ? "long" : "short"} {monthName(n.series.month)}</h2>
      <p>
        {fmtHours(n.hours)} GPU-hours of {n.series.gpu} at {usd(n.price)}.{" "}
        {n.daily ? (L ? `${usd0(n.backNow)} is back in your balance. Your first daily share arrives the morning after Nov 1.` : "Your first daily share arrives the morning after Nov 1.") : "You get paid once, after the month ends."}
      </p>
      <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onClose}>
        Done
      </button>
      <button className="ag-btn ag-btn--ghost" onClick={onClose}>
        See your positions
      </button>
    </>
  );
}

function Account({ email, balance, positions, onDrip, onSignOut, onClose }: { email: string | null; balance: number; positions: number; onDrip: () => void; onSignOut: () => void; onClose: () => void }) {
  return (
    <>
      <h2>{usd0(balance)}</h2>
      <p>Test dollars, signed in as {email}.</p>
      <div className="ag-rows">
        <div>
          <span>Open positions</span>
          <span>{positions}</span>
        </div>
        <div>
          <span>Free test dollars</span>
          <span>{int(DRIP)} a day</span>
        </div>
      </div>
      <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onDrip}>
        Get {int(DRIP)} test dollars
      </button>
      <button className="ag-btn ag-btn--ghost" onClick={onSignOut}>
        Sign out
      </button>
      <button className="ag-btn" style={{ background: "transparent", color: "var(--mute)" }} onClick={onClose}>
        Close
      </button>
    </>
  );
}
