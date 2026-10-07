"use client";
// Close a position (wallet spec 8.2): planned from the chain the moment the sheet opens, so it shows what comes back
// (at least, never a guess), then sent as one operation. Held tokens are sold; a pay me daily Long or a Short is closed
// whole. The sheet cannot close while it sends. The pretend account closes at the book's top from the market read.
// The close form (mock option closeUi "tabs", ClosePanel.tsx) hands it its own order (a part of held tokens) and the
// prices it showed; this sheet is then its review, planned and sent the same way.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountPlan, DoneResult, Order, SendStep } from "@/lib/account";
import type { Position } from "@/lib/mock/types";
import { useAccount, type TicketShown } from "@/lib/account";
import { useSeriesFor } from "@/lib/data/hooks";
import { explorerTx } from "@/lib/account/aiView";
import { refusalOfOrder, sendRefusal } from "@/lib/account/errors";
import { REPLAN_AFTER_MS } from "@/lib/account/machine";
import { usd } from "@/lib/format";
import { floorHours, fmtHours } from "@/lib/size";
import { monthName } from "@/components/markets/PriceChart";
import { Check } from "./Steps";

type Run =
  | { at: "planning" }
  /** moved: planned again at confirm and worse than what was shown, so the new numbers are shown first */
  | { at: "review"; plan: AccountPlan; moved?: boolean }
  | { at: "placing"; step: SendStep }
  | { at: "done"; result: DoneResult }
  /** sent: it went to Monad (not seen landing, or reverted), so it is never sent again from here */
  | { at: "failed"; message: string; sent: boolean };

/** What closing this position asks for. Tokens resting at Kuru are not sold from here (they settle at the month's end). */
export function closeOrder(p: Position): Order | null {
  const on = { gpu: p.gpu, month: p.month };
  if (p.kind === "tokens") {
    const hours = floorHours(p.q - p.inMargin);
    return hours > 0 ? { kind: "sellLong", ...on, gpuHours: hours.toFixed(4) } : null;
  }
  if (p.kind !== "position" || !p.positionId) return null;
  return p.side === "long" ? { kind: "closeLongDaily", ...on, positionIds: [p.positionId] } : { kind: "closeShort", ...on, positionIds: [p.positionId] };
}

/** given / givenShown: set on the close form (its amount, and the prices it showed, which the pretend account books
 * at); without them, the whole holding at the book's top, as before. onBack: where Back goes (the form it came from). */
export function CloseSheet({ p, order: given, shown: givenShown, onClose, onBack, onLock }: { p: Position; order?: Order; shown?: TicketShown; onClose: () => void; onBack?: () => void; onLock: (locked: boolean) => void }) {
  const account = useAccount();
  const order = useMemo(() => given ?? closeOrder(p), [given, p]);
  // the pretend account books a close from the book's top (the real one plans from the chain and ignores this)
  const seriesFor = useSeriesFor();
  const series = seriesFor(p.gpu, p.month);
  const fromQuote = useMemo<TicketShown | undefined>(
    () => (series?.quote ? { side: p.side, gpuHours: p.q, price: p.side === "long" ? series.quote.bid : series.quote.ask, floor: series.floor, cap: series.cap, daily: p.daily, close: p } : undefined),
    [series, p],
  );
  const shown = givenShown ?? fromQuote;
  const [run, setRun] = useState<Run>(order ? { at: "planning" } : { at: "failed", message: "This one can't be closed from here: it settles at the month's end.", sent: false });
  useEffect(() => onLock(run.at === "placing"), [run.at, onLock]);
  const L = p.side === "long";
  // from the form, the title names the act (part of held tokens says so); before, "Close H100 November Long"
  const part = given?.kind === "sellLong" && Number(given.gpuHours) < floorHours(p.q - p.inMargin);
  const title = given ? `${L ? (part ? "Sell part of your" : "Sell your") : "Buy back your"} ${p.gpu} ${monthName(p.month)} ${L ? "Long" : "Short"}` : `Close ${p.gpu} ${monthName(p.month)} ${L ? "Long" : "Short"}`;
  const back = onBack ?? onClose;

  const plan = useCallback(async () => {
    if (!order) return;
    setRun({ at: "planning" });
    try {
      setRun({ at: "review", plan: await account.plan(order, shown) });
    } catch (e) {
      setRun({ at: "failed", message: refusalOfOrder(e, order).message, sent: false });
    }
  }, [account, order, shown]);
  // planned once, when the sheet opens (Strict Mode's second effect does not plan again)
  const planned = useRef(false);
  useEffect(() => {
    if (planned.current) return;
    planned.current = true;
    void plan();
  }, [plan]);

  const confirm = async (pl: AccountPlan) => {
    if (!order) return;
    setRun({ at: "placing", step: "checking" });
    let fresh = pl;
    try {
      // a plan read more than 15 s ago is read again, so its bound fits the book now; one worse than the person
      // confirmed (less back, or a dearer buy-back) is shown before anything is sent
      if (Date.now() - pl.plannedAt > REPLAN_AFTER_MS) {
        fresh = await account.plan(order, shown);
        const was = pl.summary.bound.value;
        const now = fresh.summary.bound.value;
        if (fresh.summary.bound.kind === "maxDollarsIn" ? now > was + 0.005 : now < was - 0.005) return setRun({ at: "review", plan: fresh, moved: true });
      }
    } catch (e) {
      return setRun({ at: "failed", message: refusalOfOrder(e, order).message, sent: false });
    }
    try {
      const result = await account.send(fresh, (step) => setRun({ at: "placing", step }));
      setRun({ at: "done", result });
    } catch (e) {
      const r = sendRefusal(e);
      setRun({ at: "failed", message: r.message, sent: !r.nothingSent });
    }
  };

  if (run.at === "planning" || run.at === "placing") {
    const words = run.at === "planning" ? "Checking the price" : run.step === "checking" ? "Checking the price" : run.step === "signing" ? "Your wallet is signing" : "Sending to Monad";
    return (
      <div className="grid justify-items-center gap-4 py-6 text-center" aria-live="polite">
        <span className="ag-spinner" />
        <h2>{run.at === "planning" ? title : words}</h2>
        <p>{run.at === "planning" ? "Reading the book for what this pays now." : run.step === "sending" ? "About 6 seconds on Monad's test network. Network fees are on Agate." : `${title}.`}</p>
      </div>
    );
  }

  if (run.at === "done") {
    const r = run.result;
    // a Short: what came back after the buy-back (the balance's change), the figure the close form showed
    const shortBack = r.net ?? (r.received ?? 0) - (r.spent ?? 0);
    const line =
      r.action === "closeLong"
        ? `${fmtHours(r.gpuHours ?? 0)} GPU-hours sold for ${usd(r.received ?? 0)}, now in your balance.`
        : r.action === "closeShort"
          ? `Bought back for ${usd(r.spent ?? 0)}. ${usd(shortBack)} came back to your balance.`
          : // a pay me daily Long: what it sold for less what it had been paid (the dollars put up front came back in the same step)
            `${usd(r.net ?? r.received ?? 0)} came back to your balance.`;
    return (
      <>
        <Check size={44} />
        <h2>Closed</h2>
        <p>{line}</p>
        {r.txHash && (
          <p>
            <a className="ag-textbtn" href={explorerTx(r.txHash)} target="_blank" rel="noreferrer">
              See it on Monad's explorer
            </a>
          </p>
        )}
        <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={onClose}>
          Done
        </button>
      </>
    );
  }

  if (run.at === "failed") {
    return (
      <>
        <h2>{run.sent ? "Sent to Monad" : title}</h2>
        <p className={run.sent ? undefined : "ag-err"} role={run.sent ? "status" : "alert"}>
          {run.message}
        </p>
        {!run.sent && order && (
          <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={() => void plan()}>
            Try again
          </button>
        )}
        <button className="ag-btn ag-btn--ghost" type="button" onClick={onClose}>
          Close
        </button>
      </>
    );
  }

  const s = run.plan.summary;
  const hours = s.gpuHours ?? p.q;
  return (
    <>
      <h2>{title}</h2>
      <div className="ag-rows">
        {s.action === "closeShort" ? (
          <div>
            <span>Buy back</span>
            <span>
              {fmtHours(hours)} GPU-hours for at most {usd(s.bound.value)}
            </span>
          </div>
        ) : (
          <>
            <div>
              <span>GPU-hours</span>
              <span>{fmtHours(hours)}</span>
            </div>
            <div>
              <span>You get at least</span>
              {/* a pay me daily Long sells, then hands back what it was already paid (shown below) */}
              <span>{usd(s.action === "closeLongDaily" ? Math.max(0, s.bound.value - p.paid) : s.bound.value)}</span>
            </div>
          </>
        )}
        {s.action === "closeLongDaily" && s.maxSpend > 0 && (
          <div>
            <span>Needs up front</span>
            <span>{usd(s.maxSpend)}, back in the same step</span>
          </div>
        )}
        {p.daily && (
          <div>
            <span>Already paid</span>
            <span>{usd(p.paid)}</span>
          </div>
        )}
      </div>
      {run.moved && (
        <p className="ag-err" role="alert">
          The price moved since you looked. These are the numbers now.
        </p>
      )}
      <p style={{ fontSize: 15 }}>{s.action === "closeShort" ? "The price is checked again when it sends: it never pays more than this." : "The price is checked again when it sends: it never pays less than this."}</p>
      <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={() => void confirm(run.plan)}>
        {given ? (L ? "Confirm sale" : "Confirm buy-back") : `Close ${L ? "Long" : "Short"}`}
      </button>
      <button className="ag-btn ag-btn--ghost" type="button" onClick={back}>
        Back
      </button>
    </>
  );
}
