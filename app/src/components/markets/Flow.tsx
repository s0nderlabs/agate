"use client";
// Sign in, test dollars, review, place, done: the sheets every Markets variant shares. Plus the account's own sheets
// (the Account sheet, More's account head, an AI's pocket, disconnecting an AI, how to connect an AI), whose bodies
// live in components/flow/. Sheets that run a step (setting up an account, placing, a pocket move, a disconnect)
// cannot be closed until it finishes.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { DRIP, useAccount, type DoneResult, type Order, type SendStep, type TicketShown } from "@/lib/account";
import { explorerTx } from "@/lib/account/aiView";
import { COPY, refusalOfOrder, sendRefusal, type Refusal } from "@/lib/account/errors";
import { guardFromQuote } from "@/lib/account/machine";
import { ticketOrder, ticketShown } from "@/lib/account/ticket";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { finePointer, tapMode, useModalFocus } from "@/lib/ui/hooks";
import { showHours } from "@/lib/size";
import { int, usd, usd0 } from "@/lib/format";
import { AccountHead, AccountSheet, AddressRow, AisRow, DocsRow, SECURED, SIGN_OUT_NOTE, useAiSummary, usePasskeyRow } from "@/components/flow/AccountSheet";
import { CloseSheet } from "@/components/flow/CloseSheet";
import { CloseForm } from "@/components/trade/ClosePanel";
import { DisconnectSheet } from "@/components/flow/DisconnectSheet";
import { dripOpen, useDrip } from "@/components/flow/DripButton";
import { PocketSheet, type PocketTarget } from "@/components/flow/PocketSheet";
import { SignInSheet, signInLocked, type SignInFrom } from "@/components/flow/SignInSheet";
import { HowTo } from "@/components/ai/HowTo";
import { bandNow, dateText, firstPayAt, payTime } from "@/lib/data/derive";
import { monthName } from "./PriceChart";
import type { TradeNumbers } from "./useTrade";
import type { Position } from "@/lib/mock/types";

type Sheet =
  /** then: the trade to go on with; after: what a page goes on with (the Allow page, an approval) */
  | { kind: "signin"; then?: TradeNumbers; from?: SignInFrom; ai?: string; after?: () => void }
  | { kind: "funds"; then: TradeNumbers }
  /** problem: the last Confirm was refused before anything was sent, in plain words; retry: the same trade at what
   *  the book offers now (the price moved, or only part of it fills), one tap away */
  | { kind: "review"; n: TradeNumbers; problem?: string; retry?: { order: Order; label: string }; final?: boolean }
  | { kind: "placing"; n: TradeNumbers; step: SendStep }
  /** result: what the trade did, read from its own receipt (the real account) */
  | { kind: "done"; n: TradeNumbers; result?: DoneResult }
  /** sent, but not seen landing (or it landed and reverted): never sent twice, and never called failed */
  | { kind: "sent"; n: TradeNumbers; message: string }
  | { kind: "account" }
  | { kind: "info"; title: string; body: ReactNode; wide?: boolean }
  | { kind: "more" }
  /** onMoved: the page that opened it hears when the dollars moved (a stopped connect run, after a take back) */
  | { kind: "pocket"; target: PocketTarget; mode: "add" | "takeBack"; onMoved?: (dollars: number) => void }
  | { kind: "disconnect"; grantId: string }
  /** close a position (sell held tokens, or close a pay me daily Long or a Short). order / shown: set on the close form
   *  (mock option closeUi "tabs"), its amount and prices; back: Back returns to that form */
  | { kind: "close"; p: Position; order?: Order; shown?: TicketShown; back?: boolean }
  /** the close form for one holding (closeUi "tabs"): the trade panel's Close, as a sheet (the Positions page's Close).
   *  hours: the amount it had, when Back from its review returns to it */
  | { kind: "closeForm"; p: Position; hours?: number }
  | { kind: "howto" };

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
  /** sign in for a page (the Allow page, an approval): its heading, then `after` once signed in */
  signInFor: (opts: { from: SignInFrom; ai?: string; after?: () => void }) => void;
  /** add test dollars to an AI's pocket, or take back what is left in it; onMoved hears the dollars that moved */
  openPocket: (target: PocketTarget, mode: "add" | "takeBack", onMoved?: (dollars: number) => void) => void;
  /** disconnect a connected AI */
  openDisconnect: (grantId: string) => void;
  /** close a position: with an order (the close form's), its review; without, the close form for it (closeUi "tabs")
   *  or the whole position's review (before) */
  openClose: (p: Position, set?: { order: Order; shown?: TicketShown }) => void;
  /** how to let an AI trade: add Agate's link to the AI app */
  openHowTo: () => void;
}
const Ctx = createContext<FlowCtx | null>(null);
export const useFlow = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useFlow outside TradeFlow");
  return c;
};

export function TradeFlow({ children }: { children: React.ReactNode }) {
  const { config } = useMock();
  const account = useAccount();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // a sheet that runs a step holds itself open (the pocket and disconnect sheets say so; sign-in from its machine)
  const [held, setHeld] = useState(false);
  const locked = held || sheet?.kind === "placing" || (sheet?.kind === "signin" && signInLocked(account.signIn));
  const live = useRef({ locked, sheet, account });
  live.current = { locked, sheet, account };
  const close = useCallback(() => {
    const { sheet: at, account: a } = live.current;
    // a sign-in closed mid-way starts at the email step next time, the email kept
    if (at?.kind === "signin" && !a.ready) a.cancelSignIn();
    setHeld(false);
    setSheet(null);
  }, []);
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
      if (!account.ready) return setSheet({ kind: "signin", then: n });
      if (account.balance < n.outlay) return setSheet({ kind: "funds", then: n });
      setSheet({ kind: "review", n });
    },
    [account.ready, account.balance],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && live.current.sheet && !live.current.locked && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // signed in from the sheet: on with the trade (test dollars first if short), the page's own next step, or close
  const signedIn = useCallback((at: Extract<Sheet, { kind: "signin" }>) => {
    const a = live.current.account;
    setHeld(false);
    if (at.then) return setSheet(a.balance < at.then.outlay ? { kind: "funds", then: at.then } : { kind: "review", n: at.then });
    setSheet(null);
    at.after?.();
  }, []);

  // Confirm: plan the ticket's trade from the chain, send it as one operation, then Done from its receipt (the pretend
  // account records a practice trade in about a second). Run from the tap, not an effect, so a trade is sent once.
  // Refused before sending (the price moved, a thin book, the fee): back to Review with why, so Confirm plans again.
  // Short of dollars: the Funds sheet. Sent but not seen landing: said so, and never sent again.
  const place = useCallback(
    async (n: TradeNumbers, again?: Order) => {
      const order = again ?? ticketOrder(n);
      setSheet({ kind: "placing", n, step: "checking" });
      let plan;
      try {
        plan = await account.plan(order, ticketShown(n));
      } catch (e) {
        const r = refusalOfOrder(e, order);
        if (r.sheet === "funds") return setSheet({ kind: "funds", then: n });
        if (sendRefusal(e).sheet === "signin") return setSheet({ kind: "signin", then: n });
        if (r.sheet === "ticket") return setSheet({ kind: "review", n, problem: r.message, final: true });
        return setSheet({ kind: "review", n, problem: r.message, retry: retryOf(order, r) });
      }
      try {
        const result = await account.send(plan, (step) => setSheet((s) => (s?.kind === "placing" ? { ...s, step } : s)));
        setSheet({ kind: "done", n, result });
      } catch (e) {
        const r = sendRefusal(e);
        if (r.sheet === "signin") return setSheet({ kind: "signin", then: n });
        setSheet(r.nothingSent ? { kind: "review", n, problem: r.message } : { kind: "sent", n, message: r.message });
      }
    },
    [account],
  );

  return (
    <Ctx.Provider
      value={{
        submit,
        openAccount: () => setSheet({ kind: "account" }),
        openSignIn: () => setSheet({ kind: "signin" }),
        sheetKind: sheet?.kind ?? null,
        openInfo: (title, body, opts) => setSheet({ kind: "info", title, body, wide: opts?.wide }),
        openMore: () => setSheet({ kind: "more" }),
        signInFor: (opts) => setSheet({ kind: "signin", ...opts }),
        openPocket: (target, mode, onMoved) => setSheet({ kind: "pocket", target, mode, onMoved }),
        openDisconnect: (grantId) => setSheet({ kind: "disconnect", grantId }),
        openClose: (p, set) =>
          setSheet((at) => (set ? { kind: "close", p, ...set, back: at?.kind === "closeForm" } : config.closeUi === "tabs" ? { kind: "closeForm", p } : { kind: "close", p })),
        openHowTo: () => setSheet({ kind: "howto" }),
      }}
    >
      {children}
      {sheet && (
        <div className={`ag-backdrop ${config.theme === "dark" ? "tone-dark" : "tone-light"}`} data-phone={config.phone} data-kind={sheet.kind} onClick={(e) => e.target === e.currentTarget && !locked && close()}>
          <div ref={sheetRef} className="ag-sheet" role="dialog" aria-modal="true" tabIndex={-1} data-wide={(sheet.kind === "info" && sheet.wide) || sheet.kind === "howto" || undefined}>
            {sheet.kind === "info" && <Info title={sheet.title} body={sheet.body} onClose={close} />}
            {sheet.kind === "more" && <More onSignIn={() => setSheet({ kind: "signin", from: "nav" })} onClose={close} />}
            {sheet.kind === "signin" && <SignInSheet from={sheet.from ?? (sheet.then ? "trade" : "nav")} ai={sheet.ai} onFinished={() => signedIn(sheet)} onClose={close} />}
            {sheet.kind === "funds" && (
              <Funds
                need={sheet.then.outlay}
                balance={account.balance}
                nextDrip={dripOpen(account) ? null : account.nextDrip}
                // only once the drip has landed (the balance before it plus what it paid)
                onDripped={() => setSheet(account.balance + DRIP >= sheet.then.outlay ? { kind: "review", n: sheet.then } : { kind: "funds", then: sheet.then })}
                onReview={() => setSheet({ kind: "review", n: sheet.then })}
                onClose={close}
              />
            )}
            {sheet.kind === "review" && <Review n={sheet.n} problem={sheet.problem} retryLabel={sheet.retry?.label} final={sheet.final} onConfirm={() => place(sheet.n, sheet.retry?.order)} onBack={close} />}
            {sheet.kind === "placing" && <Placing n={sheet.n} step={sheet.step} />}
            {sheet.kind === "done" && <Done n={sheet.n} result={sheet.result} onClose={close} />}
            {sheet.kind === "sent" && <Sent message={sheet.message} onClose={close} />}
            {sheet.kind === "account" && <AccountSheet onClose={close} />}
            {sheet.kind === "pocket" && <PocketSheet target={sheet.target} mode={sheet.mode} onMoved={sheet.onMoved} onClose={close} onLock={setHeld} />}
            {sheet.kind === "disconnect" && <DisconnectSheet grantId={sheet.grantId} onClose={close} onLock={setHeld} />}
            {sheet.kind === "close" && <CloseSheet p={sheet.p} order={sheet.order} shown={sheet.shown} onBack={sheet.back ? () => setSheet({ kind: "closeForm", p: sheet.p, hours: sheet.shown?.gpuHours }) : undefined} onClose={close} onLock={setHeld} />}
            {sheet.kind === "closeForm" && <CloseForm p={sheet.p} hours={sheet.hours} onClose={close} />}
            {sheet.kind === "howto" && (
              <>
                <HowTo onGo={close} />
                <button className="ag-btn ag-btn--quiet" type="button" onClick={close}>
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

function Funds({ need, balance, nextDrip, onDripped, onReview, onClose }: { need: number; balance: number; nextDrip: string | null; onDripped: () => void; onReview: () => void; onClose: () => void }) {
  const enough = balance >= need;
  const drip = useDrip();
  // today's test dollars are taken: when the next ones arrive, and a way back to a smaller amount
  if (!enough && nextDrip) {
    return (
      <>
        <h2>Get test dollars</h2>
        <p>
          {COPY.dripArrive(nextDrip)} This trade needs {usd0(need)} and you have {usd0(balance)}.
        </p>
        <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onClose}>
          Change the amount
        </button>
      </>
    );
  }
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
        <>
          <button
            className="ag-btn ag-btn--primary ag-btn--lg"
            disabled={drip.busy}
            onClick={async () => {
              if (await drip.run()) onDripped();
            }}
          >
            {drip.busy ? (
              <>
                <span className="ag-spinner" aria-hidden="true" />
                Getting your test dollars
              </>
            ) : (
              `Get ${int(DRIP)} test dollars`
            )}
          </button>
          {drip.error && (
            <p className="ag-err" aria-live="polite">
              {drip.error}
            </p>
          )}
        </>
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

/** The price moved or the book is thin: the same trade guarded by what the book offers now, and what its button says. */
function retryOf(order: Order, r: Refusal): { order: Order; label: string } | undefined {
  if (!r.quote || (r.sheet !== "moved" && r.sheet !== "thin")) return undefined;
  const next = guardFromQuote(order, r.quote, r.sheet);
  if (r.sheet === "thin") return { order: next, label: `Buy ${usd(r.quote.dollars)} instead` };
  const buy = order.kind === "buyLong" || order.kind === "openLongDaily";
  return { order: next, label: buy ? "Buy at the new price" : "Sell at the new price" };
}

/** final: the order itself cannot run (an amount under the market's step): no Try again, only Back to change it */
function Review({ n, problem, retryLabel, final = false, onConfirm, onBack }: { n: TradeNumbers; problem?: string; retryLabel?: string; final?: boolean; onConfirm: () => void; onBack: () => void }) {
  const L = n.side === "long";
  return (
    <>
      <h2>{sideLabel(n)}</h2>
      <div className="ag-rows">
        <div>
          <span>Size</span>
          <span>
            {showHours(n.hours)} GPU-hours at {usd(n.price)}
          </span>
        </div>
        <div>
          <span>{L ? "You pay" : "You put up"}</span>
          <span>{usd0(n.outlay)}</span>
        </div>
        {n.daily && (
          <div>
            <span>{L || n.backNow > 0 ? "Back right away" : "Paid out"}</span>
            <span>{L || n.backNow > 0 ? usd0(n.backNow) : "Each day"}</span>
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
          ? `You get ${monthName(n.series.month)}'s average ${n.series.gpu} price for every GPU-hour, between ${usd(bandNow(n.series).lo)} and ${usd(bandNow(n.series).hi)}${bandNow(n.series).k > 0 ? ` now that ${bandNow(n.series).k} of its days are priced` : ""}.`
          : `You get ${usd(n.series.cap)} minus ${monthName(n.series.month)}'s average for every GPU-hour, so you gain when the average comes in below ${usd(n.price)}.`}{" "}
        {n.daily ? `Paid a share each day about ${payTime(n.series)}. This locks the market rate, not your bill.` : `Paid once, after ${monthName(n.series.month)} ends.`}
      </p>
      {problem && (
        <p className="ag-err" role="alert">
          {problem}
        </p>
      )}
      {!final && (
        <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onConfirm}>
          {retryLabel ?? (problem ? "Try again" : `Confirm ${L ? "Long" : "Short"}`)}
        </button>
      )}
      <button className="ag-btn ag-btn--ghost" onClick={onBack}>
        Back
      </button>
    </>
  );
}

/** Placing, step by step: the price checked against the chain, the wallet signing, then Monad. */
function Placing({ n, step }: { n: TradeNumbers; step: SendStep }) {
  const what = `${n.side === "long" ? "Buying" : "Selling"} ${showHours(n.hours)} GPU-hours of ${n.series.gpu} ${monthName(n.series.month)}`;
  return (
    <div className="grid justify-items-center gap-4 py-6 text-center" aria-live="polite">
      <span className="ag-spinner" />
      <h2>{step === "checking" ? "Checking the price" : step === "signing" ? "Your wallet is signing" : "Sending to Monad"}</h2>
      <p>{step === "sending" ? `${what}. About 6 seconds on Monad's test network. Network fees are on Agate.` : `${what}.`}</p>
    </div>
  );
}

/** Sent, but not seen landing, or landed without filling: the money is safe either way, and nothing is resent. */
function Sent({ message, onClose }: { message: string; onClose: () => void }) {
  const router = useRouter();
  const linkQuery = useLinkQuery();
  return (
    <>
      <h2>Sent to Monad</h2>
      <p role="status">{message}</p>
      <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onClose}>
        Close
      </button>
      <button
        className="ag-btn ag-btn--ghost"
        onClick={() => {
          onClose();
          router.push(`/app/positions${linkQuery}`);
        }}
      >
        See your positions
      </button>
    </>
  );
}

function Done({ n, result, onClose }: { n: TradeNumbers; result?: DoneResult; onClose: () => void }) {
  const L = n.side === "long";
  const router = useRouter();
  const linkQuery = useLinkQuery();
  // the real account's numbers come from the trade's own receipt; the pretend account's from the ticket
  const hours = result?.gpuHours ?? n.hours;
  const price = result?.avg ?? n.price;
  const backNow = result?.paidNow ?? n.backNow;
  return (
    <>
      <svg className="ag-done" viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
        <circle cx="24" cy="24" r="22" />
        <path d="M14 24.5l7 7 13-14" />
      </svg>
      <h2>You're {L ? "long" : "short"} {monthName(n.series.month)}</h2>
      <p>
        {showHours(hours)} GPU-hours of {n.series.gpu} at {usd(price)}.{" "}
        {n.daily
          ? `${L ? `${usd0(backNow)} is back in your balance. ` : ""}${bandNow(n.series).k > 0 ? `Your next daily share arrives about ${payTime(n.series)}.` : `Your first daily share arrives ${dateText(firstPayAt(n.series))}, about ${payTime(n.series)}.`}`
          : "You get paid once, after the month ends."}
      </p>
      {result?.txHash && (
        <p>
          <a className="ag-textbtn" href={explorerTx(result.txHash)} target="_blank" rel="noreferrer">
            See it on Monad's explorer
          </a>
        </p>
      )}
      <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onClose}>
        Done
      </button>
      <button
        className="ag-btn ag-btn--ghost"
        onClick={() => {
          onClose();
          router.push(`/app/positions${linkQuery}`);
        }}
      >
        See your positions
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
 * top bar on phones, and the way to the docs (the compact top bars have no Docs link). */
function More({ onSignIn, onClose }: { onSignIn: () => void; onClose: () => void }) {
  const { config, setConfig } = useMock();
  const account = useAccount();
  const ai = useAiSummary();
  const passkey = usePasskeyRow();
  return (
    <>
      {account.ready ? (
        <AccountHead />
      ) : (
        <>
          <h2>Agate</h2>
          <p>Agate runs on Monad's test network. Trades use test dollars, {int(DRIP)} free a day.</p>
          <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={onSignIn}>
            Sign in
          </button>
        </>
      )}
      <div className="ag-rows" data-tall>
        {account.ready && (
          <>
            <AddressRow />
            <AisRow onGo={onClose} />
            {passkey.row}
          </>
        )}
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
        <DocsRow onGo={onClose} />
      </div>
      {account.ready && (
        <>
          {passkey.note}
          <p className="ag-fine">{SECURED}</p>
          {ai.active > 0 && <p className="ag-fine">{SIGN_OUT_NOTE}</p>}
          <button
            className="ag-btn ag-btn--ghost"
            onClick={() => {
              void account.signOut();
              onClose();
            }}
          >
            Sign out
          </button>
        </>
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
