"use client";
// Positions by month (Oct 5, the two-months round): each month you hold says where it stands in one line and one bar
// (days priced of the month), then what you hold in it, each with the one thing it can do now: Sell while the month
// trades, Collect once it is final. A month that paid everything moves to Finished. This is where the current month
// lives once the next one opens: the market screen's Simple ticket keeps to the next full month.
import { useState } from "react";
import { closeOrder } from "@/components/flow/CloseSheet";
import { useFlow } from "@/components/markets/Flow";
import { monthName } from "@/components/markets/PriceChart";
import { Num } from "@/components/num/Num";
import { useAccount } from "@/lib/account";
import { bandNow, dateText, firstPayAt, monthOpen, monthStage, payTime, sellEndsAt, timeText, type MonthStage } from "@/lib/data/derive";
import { useNow, useSeriesFor } from "@/lib/data/hooks";
import { usd, usd0 } from "@/lib/format";
import { fmtHours } from "@/lib/size";
import type { Position, Series } from "@/lib/mock/types";
import s from "./positions.module.css";

const pnlText = (pnl: number) => {
  const r = Math.round(pnl);
  return r === 0 ? "$0" : `${r > 0 ? "+" : "−"}${usd0(Math.abs(r))}`;
};
const tone = (pnl: number | null) => (pnl === null || Math.round(pnl) === 0 ? undefined : pnl > 0 ? "up" : "down");

/** When a month's last day turns final (about 07:00 UTC on the 1st after it), ISO. */
function finalAt(series: Series) {
  const t = Date.parse(series.closesAt);
  return Number.isFinite(t) ? new Date(t + 7 * 3_600_000).toISOString() : "";
}

/** The month in one line: where it stands and what that means for what you hold. */
function stageText(series: Series, st: MonthStage) {
  const m = monthName(series.month);
  const b = bandNow(series);
  const closes = `${dateText(sellEndsAt(series))}, ${timeText(sellEndsAt(series))}`;
  switch (st) {
    case "listed":
      return `Starts ${dateText(series.startsAt)}. Pay me daily pays a share each day from ${dateText(firstPayAt(series))}, about ${payTime(series)}; the rest pays once ${m} is final. You can sell any time until ${closes}.`;
    case "paying":
      return `${b.k} of ${b.n} days priced, averaging ${b.soFar === null ? "nothing yet" : usd(b.soFar)}. You can sell any time until ${closes}.`;
    case "lastDay":
      return `Last day: selling stops at ${timeText(sellEndsAt(series))} tonight. After that ${m} pays out once its last day is final, about ${timeText(finalAt(series))} on ${dateText(finalAt(series))}.`;
    case "closed":
      return `${m} has ended and can't be sold. Its last day turns final about ${timeText(finalAt(series))}; then the last daily payment arrives and the rest can be collected.`;
    case "final":
      return `Final: ${m} averaged ${usd(series.S / series.n)} per GPU-hour.`;
    default:
      return "";
  }
}

export function MonthGroups({ positions, lastFor }: { positions: Position[]; lastFor: (p: Position) => number | null }) {
  const seriesFor = useSeriesFor();
  const now = useNow();
  // finished: the month is final and nothing is left to collect (pay me daily was paid in full, or it was collected).
  // Held tokens and a short balance report nothing claimable, so they finish only once something was paid out
  const finished = (p: Position) => {
    const sr = seriesFor(p.gpu, p.month);
    return !!sr && monthStage(sr, now) === "final" && p.claimable <= 0.005 && (p.kind === "position" || p.paid > 0);
  };
  const live = positions.filter((p) => !finished(p));
  const done = positions.filter(finished);
  const keys = [...new Set(live.map((p) => `${p.month}|${p.gpu}`))].sort();
  return (
    <>
      {keys.map((k) => {
        const [month, gpu] = k.split("|");
        return <MonthGroup key={k} series={seriesFor(gpu, month)} gpu={gpu} month={month} positions={live.filter((p) => p.month === month && p.gpu === gpu)} lastFor={lastFor} now={now} />;
      })}
      {done.length > 0 && (
        <section className={s.group} aria-label="Finished">
          <h3 className={s.groupTitle}>Finished</h3>
          <ul className={s.holdings}>
            {done.map((p) => (
              <Holding key={p.id} p={p} series={seriesFor(p.gpu, p.month)} last={lastFor(p)} now={now} finished />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function MonthGroup({ series, gpu, month, positions, lastFor, now }: { series: Series | undefined; gpu: string; month: string; positions: Position[]; lastFor: (p: Position) => number | null; now: number }) {
  const st = series ? monthStage(series, now) : null;
  const b = series ? bandNow(series) : null;
  return (
    <section className={s.group} aria-label={`${gpu} ${monthName(month)}`}>
      <h3 className={s.groupTitle}>
        {gpu} {monthName(month)}
      </h3>
      {series && st && st !== "upcoming" && b && (
        <>
          {/* the month's days, priced so far: empty before it starts, full once it is final */}
          <div className={s.days} role="img" aria-label={`${b.k} of ${b.n} days priced`}>
            <span style={{ width: `${(b.k / b.n) * 100}%` }} />
          </div>
          <p className={s.stage} data-stage={st}>
            {stageText(series, st)}
          </p>
        </>
      )}
      <ul className={s.holdings}>
        {positions.map((p) => (
          <Holding key={p.id} p={p} series={series} last={lastFor(p)} now={now} />
        ))}
      </ul>
    </section>
  );
}

function Holding({ p, series, last, now, finished = false }: { p: Position; series: Series | undefined; last: number | null; now: number; finished?: boolean }) {
  const account = useAccount();
  const { openClose } = useFlow();
  const [collecting, setCollecting] = useState(false);
  const L = p.side === "long";
  const m = monthName(p.month);
  const st = series ? monthStage(series, now) : null;
  const final = st === "final";
  // a final month is worth its average (S / N); before, the token's last price
  const worth = final && series ? series.S / series.n : last;
  const pnl = worth === null ? null : (L ? worth - p.entry : p.entry - worth) * p.q;
  const canSell = !finished && !!series && monthOpen(series, now) && account.ready && !!closeOrder(p);
  const canCollect = !finished && final && p.claimable > 0.005 && !!account.collect;
  const what = `${L ? "Long" : "Short"}${p.daily ? ", pay me daily" : ""}`;
  const paidLine = () => {
    if (finished) return <>Paid <Num>{usd0(p.paid)}</Num> in all.</>;
    // the button carries the amount; the line says why it is there
    if (final) {
      if (p.claimable > 0.005) return <>Paid once, now that {m} is final.</>;
      // held tokens or a short balance: what the end pays, said even where the app cannot collect it yet
      if (p.kind !== "position" && p.paid <= 0 && series) return <>Worth <Num>{usd0(p.q * (L ? series.S / series.n : series.cap - series.S / series.n))}</Num> at the final price, to collect.</>;
      return <>Paid <Num>{usd0(p.paid)}</Num> in all.</>;
    }
    if (st === "closed") return p.daily ? <>Paid <Num>{usd0(p.paid)}</Num> so far. The last day's share comes once it is final.</> : <>Collect opens once {m}'s last day is final.</>;
    if (p.daily) return <>Paid <Num>{usd0(p.paid)}</Num> so far, the rest a share each day.</>;
    return <>Paid once, after {m} is final.</>;
  };
  return (
    <li className={s.holding}>
      <div className={s.hTop}>
        <b>{finished ? `${p.gpu} ${m}, ${what}` : what}</b>
        <span className={s.hPnl} data-tone={tone(pnl)}>
          {pnl === null ? "No price yet" : <Num>{pnlText(pnl)}</Num>}
        </span>
      </div>
      <p className={s.hLine}>
        <Num>{fmtHours(p.q)}</Num> GPU-hours at <Num>{usd(p.entry)}</Num>
        {worth === null ? ", waiting for a price" : final ? <>, final <Num>{usd(worth)}</Num></> : st === "closed" ? <>, last traded <Num>{usd(worth)}</Num></> : <>, now <Num>{usd(worth)}</Num></>}
      </p>
      <div className={s.hFoot}>
        <p className={s.hQuiet}>{paidLine()}</p>
        {canSell && (
          <button type="button" className="ag-btn ag-btn--ghost" onClick={() => openClose(p)}>
            {L ? "Sell" : "Close"}
          </button>
        )}
        {canCollect && (
          <button
            type="button"
            className="ag-btn ag-btn--primary"
            disabled={collecting}
            onClick={async () => {
              setCollecting(true);
              try {
                await account.collect?.(p);
              } finally {
                setCollecting(false);
              }
            }}
          >
            {collecting ? <span className="ag-spinner" /> : `Collect ${usd0(p.claimable)}`}
          </button>
        )}
      </div>
    </li>
  );
}
