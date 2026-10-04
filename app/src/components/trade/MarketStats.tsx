"use client";
// The month's market at a glance, beside the two prices: what traded today, what is held open, when the next index
// price lands and when trading closes. What the references put there (Hyperliquid, Lighter, Coinbase Advanced):
// plain figures, volume, open interest, a countdown; each label opens a note on hover or tap.
import { useEffect, useId, useMemo, useState } from "react";
import { Num } from "@/components/num/Num";
import { monthName } from "@/components/markets/PriceChart";
import { useCandles, useIndexer, useNow } from "@/lib/data/hooks";
import { countdown, dateText, lastTradingDay, monthLong, nextMonthOf, placeholderSeries, timeText, tradedToday, whenText } from "@/lib/data/derive";
import type { Market, Series } from "@/lib/mock/types";
import { int } from "@/lib/format";
import s from "./trade.module.css";
import { Note } from "./Note";

/** row: the four figures as bare cells for Pro's one-line header (shorter values: the countdown alone, the close
 * date alone, the rest in the notes); otherwise two columns of two beside the prices. series: the ticket's month
 * (the first open one by default). loading: the figures are on their way (skeletons). A month not open yet has
 * nothing traded or held ("None yet"); a price-only GPU shows the next index price alone. */
export function HeadStats({ market, series: picked, row = false, loading = false }: { market: Market; series?: Series; row?: boolean; loading?: boolean }) {
  const uid = useId();
  // the ticket's month, else the first open one (a stand-in for a price-only GPU), its candles from the shared read
  const series = useMemo(() => picked ?? market.series[0] ?? placeholderSeries(market), [picked, market]);
  const cq = useCandles(series);
  const candles = cq.candles;
  const { indexerUp } = useIndexer();
  const now = useNow();
  const waiting = series.phase === "upcoming" || !series.quote;
  // what traded today counts from the candles: a skeleton until they are read, "Not available" when they could not be
  // (never 0 GPU-hours made up from no candles)
  const noTrades = waiting || (indexerUp && series.quote?.lastAt === null && !candles.length);
  const todayWait = !noTrades && indexerUp && cq.loading && !cq.error;
  const todayFailed = cq.loading && cq.error;
  const { today, open } = useMemo(
    () => ({
      // GPU-hours traded in the last 24 hours, and held open (tokens out plus pay-me-daily longs)
      today: tradedToday(candles, now),
      open: series.openInterest,
    }),
    [candles, now, series],
  );
  const closes = lastTradingDay(series);
  const days = Math.max(0, Math.ceil((closes - now) / 86400000));
  const month = monthName(series.month);
  // the month after: it opens for trading as this one starts
  const after = `${monthLong(nextMonthOf(series.month))} opens ${dateText(`${series.month}-01`)}`;

  // skel: this figure's own read is still on its way (a skeleton even after the screen has loaded)
  const cells: { label: string; note: string; value: React.ReactNode; skel?: boolean }[] = [
    {
      label: "Traded today",
      note: `GPU-hours of ${month} that changed hands on Kuru in the last 24 hours.`,
      // nothing can have traded before the month opens or its first trade; without the indexer (or the candles) there
      // is no history
      value: noTrades ? (
        "None yet"
      ) : !indexerUp || todayFailed ? (
        "Not available"
      ) : (
        <>
          <Num>{int(today)}</Num> <small>GPU-hours</small>
        </>
      ),
      skel: todayWait,
    },
    {
      label: "Held open",
      note: `GPU-hours of ${month} sitting in open positions right now.`,
      value: waiting ? (
        "None yet"
      ) : (
        <>
          <Num>{int(open)}</Num> <small>GPU-hours</small>
        </>
      ),
    },
    {
      label: "Next index price",
      note: "A new index price each day from the clouds' list prices: the day closes at midnight UTC, its price is published about 01:00 UTC and becomes final about 07:00 UTC, after a six-hour window for checks. Daily payouts and new months use the final price; until then the index above stays as it is.",
      // before the first price, the day it lands as well as the time
      value: <NextFix short={row} at={market.nextUpdateAt} withDate={market.priceDate === null} />,
    },
    {
      label: "Trading closes",
      note: `The last day to trade ${month}, in ${days} days. It settles on the month's average index; ${after}.`,
      value: row ? (
        `${month.slice(0, 3)} ${new Date(closes).getUTCDate()}`
      ) : (
        <>
          {`${month.slice(0, 3)} ${new Date(closes).getUTCDate()}`}{" "}
          <small>
            in <Num>{String(days)}</Num> days
          </small>
        </>
      ),
    },
  ];

  // a price-only GPU has no month: only the next index price applies
  const shown = market.tradable || loading ? cells : cells.filter((c) => c.label === "Next index price");
  const cell = (c: (typeof cells)[number], i: number) => (
    <>
      <dt className={row ? s.pLabel : undefined}>
        <Note label={c.label} note={c.note} />
      </dt>
      <dd className={row ? s.hsVal : undefined}>{loading || c.skel ? <span className={c.skel ? "ag-skel ag-skel-on" : "ag-skel"}>{c.value}</span> : c.value}</dd>
    </>
  );
  if (row)
    return shown.map((c, i) => (
      // data-stat: the phone header leaves these to the stats panel under the chart
      <div key={c.label} className={s.hsCell} data-stat>
        {cell(c, i)}
      </div>
    ));
  return (
    <dl className={s.hsGrid} aria-label={market.tradable ? `${month} market` : `${market.gpu} index`}>
      {shown.map((c, i) => (
        <div key={c.label}>{cell(c, i)}</div>
      ))}
    </dl>
  );
}

/** The hover hint: a thin info circle after a label or phrase that has a note (Public, Ostium, Kalshi use the same). */
export function InfoIcon() {
  return (
    <svg className={s.tipIcon} viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M6 5.3v3.4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="6" cy="3.55" r="0.75" fill="currentColor" />
    </svg>
  );
}

/** The next final index price: about 07:00 UTC (the day closes at midnight, its price is published about 01:00
 * UTC and turns final after a six-hour pending window; pay and listings use the final one), and once the page is
 * running, a live countdown to it. `at` is Market.nextUpdateAt, an expectation: once it is due and the price has not
 * landed yet, the countdown says so instead of going negative. */
function NextFix({ short = false, at, withDate = false }: { short?: boolean; at: string; withDate?: boolean }) {
  const [left, setLeft] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setLeft(countdown(at, Date.now()) ?? "due");
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [at]);
  const time = (withDate ? whenText(at) : timeText(at)) || "07:00 UTC";
  const soon = left === "due" ? "Any minute now" : left && `in ${left}`;
  if (short) return <>{soon || time}</>;
  return (
    <>
      {time}
      {soon && (
        <>
          {" "}
          <small>{soon}</small>
        </>
      )}
    </>
  );
}
