"use client";
// The month's market at a glance, beside the two prices: what traded today, what is held open, when the next index
// price lands and when trading closes. What the references put there (Hyperliquid, Lighter, Coinbase Advanced):
// plain figures, volume, open interest, a countdown; each label opens a note on hover or tap.
import { useEffect, useId, useMemo, useState } from "react";
import { Num } from "@/components/num/Num";
import { monthName } from "@/components/markets/PriceChart";
import { AS_OF } from "@/lib/mock/data";
import { novCandles } from "@/lib/mock/market";
import type { Market } from "@/lib/mock/types";
import { int } from "@/lib/format";
import s from "./trade.module.css";

/** row: the four figures as bare cells for Pro's one-line header (shorter values: the countdown alone, the close
 * date alone, the rest in the notes); otherwise two columns of two beside the prices. */
export function HeadStats({ market, row = false }: { market: Market; row?: boolean }) {
  const uid = useId();
  const series = market.series[0];
  const { today, open } = useMemo(() => {
    const c = novCandles(market.gpu, market);
    const all = c.reduce((a, x) => a + x.v, 0);
    return {
      today: c.slice(-24).reduce((a, x) => a + x.v, 0),
      open: Math.round((all * 0.62) / 240) * 240,
    };
  }, [market]);
  const [y, m] = series.month.split("-").map(Number);
  const closes = Date.UTC(y, m, 0);
  const days = Math.max(0, Math.ceil((closes - Date.parse(AS_OF)) / 86400000));
  const month = monthName(series.month);

  const cells: { label: string; note: string; value: React.ReactNode }[] = [
    {
      label: "Traded today",
      note: `GPU-hours of ${month} that changed hands on Kuru in the last 24 hours.`,
      value: (
        <>
          <Num>{int(today)}</Num> <small>GPU-hours</small>
        </>
      ),
    },
    {
      label: "Held open",
      note: `GPU-hours of ${month} sitting in open positions right now.`,
      value: (
        <>
          <Num>{int(open)}</Num> <small>GPU-hours</small>
        </>
      ),
    },
    {
      label: "Next index price",
      note: "A new index price each day from the clouds' list prices: the day closes at midnight UTC, its price is published about 01:00 UTC and becomes final about 07:00 UTC, after a six-hour window for checks. Daily payouts and new months use the final price; until then the index above stays as it is.",
      value: <NextFix short={row} />,
    },
    {
      label: "Trading closes",
      note: `The last day to trade ${month}, in ${days} days. It settles on the month's average index; December opens Nov 1.`,
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

  const cell = (c: (typeof cells)[number], i: number) => (
    <>
      <dt className={row ? s.pLabel : undefined}>
        <button type="button" className={s.tipBtn} aria-describedby={`${uid}-${i}`}>
          {c.label}
          <InfoIcon />
        </button>
        <span role="tooltip" id={`${uid}-${i}`} className={s.tip}>
          {c.note}
        </span>
      </dt>
      <dd className={row ? s.hsVal : undefined}>{c.value}</dd>
    </>
  );
  if (row)
    return cells.map((c, i) => (
      <div key={c.label} className={s.hsCell}>
        {cell(c, i)}
      </div>
    ));
  return (
    <dl className={s.hsGrid} aria-label={`${month} market`}>
      {cells.map((c, i) => (
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
 * running, a live countdown to it. Live data carries it as Market.nextUpdateAt (published: nextCloseAt). */
function NextFix({ short = false }: { short?: boolean }) {
  const [left, setLeft] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const d = new Date(now);
      let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7);
      if (next <= now) next += 86400000;
      const mins = Math.ceil((next - now) / 60000);
      setLeft(`${Math.floor(mins / 60)}h ${mins % 60}m`);
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);
  if (short) return <>{left ? `in ${left}` : "07:00 UTC"}</>;
  return (
    <>
      07:00 UTC
      {left && (
        <>
          {" "}
          <small>in {left}</small>
        </>
      )}
    </>
  );
}
