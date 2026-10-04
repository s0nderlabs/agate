"use client";
// Sign in, test dollars, review, place, done: the sheets every Markets variant shares.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { DRIP, useLinkQuery, useMock } from "@/lib/mock/store";
import { finePointer, tapMode, useModalFocus } from "@/lib/ui/hooks";
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
  | { kind: "account" }
  | { kind: "info"; title: string; body: ReactNode; wide?: boolean }
  | { kind: "more" };

interface FlowCtx {
  submit: (n: TradeNumbers) => void;
  openAccount: () => void;
  openSignIn: () => void;
  /** the sheet on screen right now, or null */
  sheetKind: Sheet["kind"] | null;
  /** a note or the sources as a sheet (phones and tablets) */
  openInfo: (title: string, body: ReactNode, opts?: { wide?: boolean }) => void;
  /** the phone tab bar's More: balance, Simple or Pro, light or dark */
  openMore: () => void;
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
  const sheetRef = useRef<HTMLDivElement>(null);
  const kind = sheet?.kind ?? null;
  // the open sheet takes focus and keeps Tab inside (a sheet over the phone ticket included); closing it gives
  // focus back to whatever opened it
  useModalFocus(sheetRef, kind !== null);
  // each new step: focus moves to the sheet when what held it left with the last step. Sign in puts it in the email
  // field, except on a touch screen, so the keyboard never rises over the sheet unasked
  useEffect(() => {
    const box = sheetRef.current;
    if (!kind || !box) return;
    const field = kind === "signin" && finePointer() ? box.querySelector<HTMLInputElement>("#email") : null;
    if (field) {
      field.focus();
      return;
    }
    const at = document.activeElement;
    if (!at || !box.contains(at)) box.focus({ preventScroll: true });
  }, [kind]);

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
    <Ctx.Provider
      value={{
        submit,
        openAccount: () => setSheet({ kind: "account" }),
        openSignIn: () => setSheet({ kind: "signin" }),
        sheetKind: sheet?.kind ?? null,
        openInfo: (title, body, opts) => setSheet({ kind: "info", title, body, wide: opts?.wide }),
        openMore: () => setSheet({ kind: "more" }),
      }}
    >
      {children}
      {sheet && (
        <div className={`ag-backdrop ${config.theme === "dark" ? "tone-dark" : "tone-light"}`} data-phone={config.phone} data-kind={sheet.kind} onClick={(e) => e.target === e.currentTarget && sheet.kind !== "placing" && close()}>
          <div ref={sheetRef} className="ag-sheet" role="dialog" aria-modal="true" tabIndex={-1} data-wide={(sheet.kind === "info" && sheet.wide) || undefined}>
            {sheet.kind === "info" && <Info title={sheet.title} body={sheet.body} onClose={close} />}
            {sheet.kind === "more" && <More onSignIn={() => setSheet({ kind: "signin" })} onClose={close} />}
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
  // the field takes focus from TradeFlow (not on a touch screen), after the sheet has recorded who opened it
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
      <input
        id="email"
        className="ag-input"
        type="email"
        placeholder="you@example.com"
        aria-label="Email"
        autoComplete="email"
        inputMode="email"
        enterKeyHint="go"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
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
  // live prices, practice wallet: until sign-in brings a real wallet, nothing goes to Monad, and the sheets say so
  const practice = useMock().config.source === "live";
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
        {practice && " Practice for now: nothing is sent to Monad yet."}
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
  const practice = useMock().config.source === "live";
  return (
    <div className="grid justify-items-center gap-4 py-6 text-center">
      <span className="ag-spinner" />
      <h2>Placing your order</h2>
      <p>
        {practice ? (
          "Saving your practice order at the live price."
        ) : (
          <>
            {n.side === "long" ? "Buying" : "Selling"} {fmtHours(n.hours)} {n.series.symbol} on Monad. This takes about a second.
          </>
        )}
      </p>
    </div>
  );
}

function Done({ n, onClose }: { n: TradeNumbers; onClose: () => void }) {
  const L = n.side === "long";
  const router = useRouter();
  const linkQuery = useLinkQuery();
  const practice = useMock().config.source === "live";
  return (
    <>
      <svg className="ag-done" viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
        <circle cx="24" cy="24" r="22" />
        <path d="M14 24.5l7 7 13-14" />
      </svg>
      <h2>You're {L ? "long" : "short"} {monthName(n.series.month)}</h2>
      <p>
        {fmtHours(n.hours)} GPU-hours of {n.series.gpu} at {usd(n.price)}.{" "}
        {n.daily
          ? `${L ? `${usd0(n.backNow)} is back in your balance. ` : ""}Your first daily share arrives the morning after ${monthName(n.series.month).slice(0, 3)} 1.`
          : "You get paid once, after the month ends."}
        {practice && " Practice order saved in this browser at the live price. Real test trades open with sign-in."}
      </p>
      <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onClose}>
        Done
      </button>
      <button
        className="ag-btn ag-btn--ghost"
        onClick={() => {
          onClose();
          router.push(`/positions${linkQuery}`);
        }}
      >
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

/** A note or the sources, as a sheet: the same words the hover note holds on desktop, readable on a phone. */
function Info({ title, body, onClose }: { title: string; body: ReactNode; onClose: () => void }) {
  return (
    <>
      <h2>{title}</h2>
      {typeof body === "string" ? <p>{body}</p> : body}
      <button className="ag-btn ag-btn--ghost ag-btn--lg" onClick={onClose}>
        Close
      </button>
    </>
  );
}

/** The phone tab bar's More: the balance (or what Agate is), then Simple or Pro and light or dark, which leave the
 * top bar on phones. No Docs row until docs exist. */
function More({ onSignIn, onClose }: { onSignIn: () => void; onClose: () => void }) {
  const { wallet, config, setConfig, drip, signOut } = useMock();
  return (
    <>
      {wallet.signedIn ? (
        <>
          <h2>{usd0(wallet.balance)}</h2>
          <p>Test dollars, signed in as {wallet.email}.</p>
          <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={drip}>
            Get {int(DRIP)} test dollars
          </button>
        </>
      ) : (
        <>
          <h2>Agate</h2>
          <p>Agate runs on Monad's test network. Trades use test dollars, {int(DRIP)} free a day.</p>
          <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onSignIn}>
            Sign in
          </button>
        </>
      )}
      <div className="ag-rows">
        <div>
          <span>Trading view</span>
          <div className="ag-seg" role="group" aria-label="Trading view">
            <button aria-pressed={config.mode === "simple"} onClick={() => setConfig({ mode: "simple" })}>
              Simple
            </button>
            <button aria-pressed={config.mode === "pro"} onClick={() => setConfig({ mode: "pro" })}>
              Pro
            </button>
          </div>
        </div>
        <div>
          <span>Appearance</span>
          <div className="ag-seg" role="group" aria-label="Appearance">
            <button aria-pressed={config.theme === "light"} onClick={() => setConfig({ theme: "light" })}>
              Light
            </button>
            <button aria-pressed={config.theme === "dark"} onClick={() => setConfig({ theme: "dark" })}>
              Dark
            </button>
          </div>
        </div>
      </div>
      {wallet.signedIn && (
        <button
          className="ag-btn ag-btn--ghost"
          onClick={() => {
            signOut();
            onClose();
          }}
        >
          Sign out
        </button>
      )}
      <button className="ag-btn" style={{ background: "transparent", color: "var(--mute)" }} onClick={onClose}>
        Close
      </button>
    </>
  );
}

/** Tap a note or the sources on a phone or tablet in the new layout: it opens as a sheet and returns true. Anywhere
 * else (a mouse on desktop, the stacked layout) it does nothing and returns false, so hover and popovers stay. */
export function useInfoSheet() {
  const { openInfo } = useFlow();
  const { config } = useMock();
  return (title: string, body: ReactNode, opts?: { wide?: boolean }) => {
    if (config.phone !== "new" || !tapMode()) return false;
    openInfo(title, body, opts);
    return true;
  };
}
