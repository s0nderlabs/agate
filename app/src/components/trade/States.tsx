"use client";
// The trade screen's live situations, each said once, plainly, in the area it belongs to: the index before its first
// price, a month that is not open yet, a month listed with no trades or an empty book, a price-only GPU, the indexer
// or Monad's test network unreachable. Copy from the live map (Oct 4). Body size throughout, never the fine print,
// and never a made-up number: a state with no price says so instead of showing $0.00.
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useFlow } from "@/components/markets/Flow";
import { monthName } from "@/components/markets/PriceChart";
import type { Trade } from "@/components/markets/useTrade";
import { useSource } from "@/lib/data/context";
import { useNow, useSeriesFor } from "@/lib/data/hooks";
import { bandNow, countWord, dateText, listText, monthStage, panelCount, sellEndsAt, timeText, whenText } from "@/lib/data/derive";
import { usd, usd0 } from "@/lib/format";
import { GPUS } from "@/lib/mock/data";
import { DRIP, useAccount } from "@/lib/account";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import type { Market, Series } from "@/lib/mock/types";
import { int } from "@/lib/format";
import { SideToggle } from "./SideToggle";
import s from "./trade.module.css";

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** "Oct 5, about 07:00 UTC" for a month's opening (or "soon" when the time is not known) */
function opens(series: Series) {
  return series.opensOn ? `${dateText(series.opensOn)}, about ${timeText(series.opensOn)}` : "soon";
}

/** Monad unreachable, nothing read yet: the one line (the Notice bar and the header say the same, with a retry here). */
export const NO_DATA_TEXT = "Can't reach Monad's test network right now. Trying again every minute.";

/** Before the index's first final price: the chart's index panel. */
export function indexStartsText(market: Market) {
  return `The index starts ${dateText(market.nextUpdateAt)}. One price a day from ${countWord(panelCount(market))} clouds, added here as each day turns final.`;
}

/** Before the index's first final price: who is read today (the sources panel and the Index page's readings). */
export function readTodayText(market: Market) {
  const counted = market.panel.filter((p) => !p.reserve).map((p) => p.family);
  const reserve = market.panel.filter((p) => p.reserve).map((p) => p.family);
  if (!counted.length) return null;
  const spare = reserve.length ? ` ${listText(reserve)} ${reserve.length > 1 ? "wait as reserves" : "waits as the reserve"}.` : "";
  return `${cap(countWord(counted.length))} clouds are read through the day: ${listText(counted)}.${spare} Their prices show here once the first day is final.`;
}

/** The month chart's line when it has nothing to draw: not open yet, no trade history, or no trades yet. */
export function monthChartText(series: Series, indexerUp: boolean) {
  const m = monthName(series.month);
  if (series.phase === "upcoming" || !series.quote) return `${m} opens for trading ${opens(series)}. Its hourly prices show here from the first trade.`;
  if (!indexerUp) return "Trade history is unavailable right now. Prices and the book are live.";
  const at = series.listedAt;
  return at ? `No trades yet. ${m} listed ${dateText(at)} at ${timeText(at)}; hourly candles start with its first trade.` : `No trades yet. Hourly candles start with ${m}'s first trade.`;
}

/** The book's line when it has no rows: a price-only GPU, a month not open yet, or nobody quoting yet. */
export function bookText(market: Market, series: Series, state: "priceOnly" | "upcoming" | "emptyBook") {
  if (state === "priceOnly") return `${market.gpu} has no market, so there is no book.`;
  if (state === "upcoming") return `${monthName(series.month)}'s book opens ${opens(series)}.`;
  return "No orders in the book yet.";
}

/** One side of the book is empty: what the ticket says on that side. */
export function emptySideText(series: Series, long: boolean) {
  return `No one is ${long ? "selling" : "buying"} ${monthName(series.month)} right now.`;
}

/** An empty area (the chart's plot, the header) holding one plain line, centered. */
export function StateBox({ children, start = false }: { children: React.ReactNode; start?: boolean }) {
  return (
    <div className={s.stateBox} data-align={start ? "start" : undefined}>
      {children}
    </div>
  );
}

/** Monad unreachable and nothing read yet: the line and a way to try again at once. */
export function NoData({ start = false }: { start?: boolean }) {
  const qc = useQueryClient();
  const source = useSource();
  return (
    <StateBox start={start}>
      <p className={s.tCopy}>{NO_DATA_TEXT}</p>
      <button type="button" className={`ag-btn ag-btn--ghost ${s.stateBtn}`} onClick={() => qc.invalidateQueries({ queryKey: [source.key] })}>
        Try now
      </button>
    </StateBox>
  );
}

/** The ticket's month picker when more than one month is open (the Simple ticket's head, and the waiting ticket's, so
 * a month with an empty book never strands the reader away from the other open one). */
export function MonthSeg({ trade, className }: { trade: Trade; className?: string }) {
  return (
    <div className={className ?? s.seg} role="group" aria-label="Month">
      {trade.open.map((sr) => (
        <button key={sr.month} aria-pressed={trade.month === sr.month} onClick={() => trade.setMonth(sr.month)}>
          {monthName(sr.month)}
        </button>
      ))}
    </div>
  );
}

/** A month part paid, in one line: how many of its days are priced and their average so far, or when selling ends on
 *  its last day. Null before the month starts. */
export function monthSoFarText(series: Series, now: number) {
  const st = monthStage(series, now);
  const b = bandNow(series);
  if (st === "lastDay") return `Last day to sell: until ${timeText(sellEndsAt(series))} tonight`;
  if (st !== "paying" || b.soFar === null) return null;
  return `${b.k} of ${b.n} days priced, averaging ${usd(b.soFar)}`;
}

/** A month you hold that is not on screen and needs you now (Simple keeps to the next full month): its last day to
 *  sell, the hours before its last day is final, or dollars ready to collect. One line and the way to Positions. */
export function HeldNote({ month }: { month: string }) {
  const account = useAccount();
  const seriesFor = useSeriesFor();
  const now = useNow();
  const linkQuery = useLinkQuery();
  if (!account.ready) return null;
  let line: string | null = null;
  for (const p of account.positions) {
    if (p.month === month) continue;
    const sr = seriesFor(p.gpu, p.month);
    if (!sr) continue;
    const st = monthStage(sr, now);
    const m = monthName(p.month);
    const ready = account.positions.filter((x) => x.month === p.month && x.claimable > 0.005).reduce((a, x) => a + x.claimable, 0);
    if (st === "final" && ready > 0) line = account.collect ? `${m} is final: ${usd0(ready)} is ready to collect.` : `${m} is final.`;
    else if (st === "lastDay") line = `Last day to sell your ${m}: until ${timeText(sellEndsAt(sr))} tonight.`;
    else if (st === "closed") line = `${m} has ended. What you hold in it pays out once its last day is final, about 07:00 UTC.`;
    if (line) break;
  }
  if (!line) return null;
  return (
    <p className={s.held}>
      {line} <Link href={`/positions${linkQuery}`}>Positions</Link>
    </p>
  );
}

/** The ticket while it cannot trade (Simple and Pro alike): the month not open yet, an empty book, or no prices read
 * yet. Long / Short stay pickable (no prices on them), the line says why, the button says when. With more than one
 * month open, the month picker stays at its head, so the reader can go back to a month that trades. */
export function TicketWait({ market, trade, kind }: { market: Market; trade: Trade; kind: "upcoming" | "emptyBook" | "nodata" }) {
  const account = useAccount();
  const { openSignIn } = useFlow();
  const series = trade.n.series;
  const m = monthName(series.month);
  const when = whenText(series.opensOn);
  const copy =
    kind === "upcoming"
      ? `${m} opens for trading ${opens(series)}. Its floor and ceiling are set from the five index days before it opens, so the most you can lose or make is known before you trade.`
      : kind === "emptyBook"
        ? "The market maker posts prices shortly after a month lists. This updates on its own."
        : null;
  const cta = kind === "upcoming" ? (when ? `Opens ${when}` : "Opens soon") : kind === "emptyBook" ? "No prices in the book yet" : "Waiting for prices";
  // signed out, a month that is about to open is the moment to get the test dollars ready
  const invite = kind === "upcoming" && !account.ready;
  const pick = kind !== "nodata" && trade.pickable;
  return (
    <div className={s.ticket}>
      <div className={s.tTop}>{pick ? <MonthSeg trade={trade} /> : <b>{kind === "nodata" ? market.gpu : `${m} ${market.gpu}`}</b>}</div>
      <HeldNote month={series.month} />
      <SideToggle side={trade.side} onSide={trade.setSide} ask={null} bid={null} />
      {copy && <p className={s.tCopy}>{copy}</p>}
      <div className={s.ctaBar}>
        {invite ? (
          <button type="button" className={s.cta} data-gate="true" onClick={openSignIn}>
            Sign in now
          </button>
        ) : (
          <button type="button" className={s.cta} disabled>
            {cta}
          </button>
        )}
        {invite && <p className={`${s.tCopy} ${s.ctaLine}`}>Get your {int(DRIP)} free test dollars ready.</p>}
      </div>
    </div>
  );
}

/** A price-only GPU (B300, A100, L40S): what it has, and the way to a GPU that trades. */
export function PriceOnlyTicket({ market }: { market: Market }) {
  const { setConfig } = useMock();
  return (
    <div className={s.ticket}>
      <div className={s.tTop}>
        <b>{market.gpu}</b>
      </div>
      <p className={s.tCopy}>
        {market.gpu} has a daily index price from {countWord(panelCount(market))} clouds, and no monthly market yet. Follow it here and on the Index page.
      </p>
      <div className={s.stateBtns}>
        {GPUS.map((g) => (
          <button key={g} type="button" className={`ag-btn ag-btn--ghost ${s.stateBtn}`} onClick={() => setConfig({ gpu: g })}>
            Trade {g}
          </button>
        ))}
      </div>
    </div>
  );
}
