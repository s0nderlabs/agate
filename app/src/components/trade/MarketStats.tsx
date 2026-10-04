"use client";
// The month's market at a glance, in the header's empty space: what traded today, what is held open, and how
// long trading runs. Hyperliquid's header carries the same kind of row (24h volume, open interest, countdown);
// here in plain words and in GPU-hours, the unit the trade panel uses.
import { useEffect, useId, useMemo, useState } from "react";
import { Num } from "@/components/num/Num";
import { monthName } from "@/components/markets/PriceChart";
import { AS_OF } from "@/lib/mock/data";
import { monthChangePct, novCandles } from "@/lib/mock/market";
import type { Market } from "@/lib/mock/types";
import { int, usd } from "@/lib/format";
import s from "./trade.module.css";

export function MarketStats({ market }: { market: Market }) {
  const series = market.series[0];
  return (
    <dl className={s.stats} aria-label={`${monthName(series.month)} market`}>
      <StatItems market={market} />
    </dl>
  );
}

/** The same figures as bare dl rows, for the scoreboard header: the number first, its unit quiet beside it. */
export function StatItems({ market, units = false }: { market: Market; units?: boolean }) {
  const series = market.series[0];
  const { today, open } = useMemo(() => {
    const c = novCandles(market.gpu, market);
    const today = c.slice(-24).reduce((a, x) => a + x.v, 0);
    const all = c.reduce((a, x) => a + x.v, 0);
    return { today, open: Math.round((all * 0.62) / 240) * 240 };
  }, [market]);
  const [y, m] = series.month.split("-").map(Number);
  const closes = Date.UTC(y, m, 0); // last day of the month
  const days = Math.max(0, Math.ceil((closes - Date.parse(AS_OF)) / 86400000));
  const lastDay = new Date(closes).getUTCDate();
  const mon = monthName(series.month).slice(0, 3);
  const unit = (t: string) => (units ? <small>{t}</small> : t);
  return (
    <>
      <div>
        <dt>Traded today</dt>
        <dd>
          <Num>{int(today)}</Num> {unit("GPU-hours")}
        </dd>
      </div>
      <div>
        <dt>Held open</dt>
        <dd>
          <Num>{int(open)}</Num> {unit("GPU-hours")}
        </dd>
      </div>
      <div>
        <dt>Trading closes</dt>
        <dd>
          {units ? (
            <>
              {mon} {lastDay} <small>in <Num>{String(days)}</Num> days</small>
            </>
          ) : (
            <>
              {mon} {lastDay}, <Num>{String(days)}</Num> days
            </>
          )}
        </dd>
      </div>
    </>
  );
}


/** The header's stats as a two-row block that fills the prices' height, read in columns: the outlook (what
 * traders expect, where it settles), today (range, volume), the month (held open, closes). "Traders expect" is the
 * "What it means" sentence as a number.
 * look "lines": a range shows where the price sits in it, units go quiet, the forecast gets its direction, and every
 * label has a dotted underline that opens a plain-words note on hover or tap (as Hyperliquid's header labels do).
 * look "charts": the same, plus a small chart under every number in the shape of its data (a slope, a risk and
 * reward split, a day range, hourly volume, growth since listing, time elapsed), colored only where green and red
 * mean up and down. look "plain": the earlier text-only cells.
 * look "refs": what the references put there (Hyperliquid, Lighter, Coinbase Advanced): four plain figures, volume,
 * open interest, the next index price as a countdown (their funding countdown) and the close; no charts, color only
 * on changes, labels that explain themselves. The forecast moves under the November price. */
export function HeadStats({ market, look = "plain", hint = "dots" }: { market: Market; look?: "plain" | "lines" | "charts" | "refs"; hint?: "icon" | "dots" }) {
  const uid = useId();
  const rich = look !== "plain";
  const charts = look === "charts";
  const series = market.series[0];
  const index = market.price;
  const last = series.quote?.last ?? index;
  const { today, open, lo, hi, day, held } = useMemo(() => {
    const c = novCandles(market.gpu, market);
    const day = c.slice(-24);
    const all = c.reduce((a, x) => a + x.v, 0);
    // held open, hour by hour since listing: the same 62% of volume so far that the figure uses
    let run = 0;
    const held = c.map((x) => (run += x.v) * 0.62);
    return {
      today: day.reduce((a, x) => a + x.v, 0),
      open: Math.round((all * 0.62) / 240) * 240,
      lo: Math.min(...day.map((x) => x.l)),
      hi: Math.max(...day.map((x) => x.h)),
      day,
      held,
    };
  }, [market]);
  const [y, m] = series.month.split("-").map(Number);
  const closes = Date.UTC(y, m, 0);
  const listed = Date.UTC(y, m - 2, 1); // trading opens on the 1st of the month before
  const now = Date.parse(AS_OF);
  const days = Math.max(0, Math.ceil((closes - now) / 86400000));
  const month = monthName(series.month);
  const mon = `${month.slice(0, 3)} ${new Date(closes).getUTCDate()}`;
  const prem = index ? last / index - 1 : 0;
  const flat = Math.abs(prem) < 0.0005;
  const up = prem > 0;
  const pct = `${Math.abs(prem * 100).toFixed(1)}%`;
  // the same day change the header shows under November ("+$0.02 today"), so the dot never disagrees with it
  const dayUp = monthChangePct(market.gpu) >= 0;
  const quiet = (t: React.ReactNode) => (rich ? <small>{t}</small> : t);

  const cells: { label: string; note: string; value: React.ReactNode; cls?: string; viz?: React.ReactNode }[] = [
    {
      label: "Traders expect",
      note: flat
        ? `Traders expect ${month} to cost about the same as today's index (${usd(last)} against ${usd(index)}). Think it will average more? Long gains. Less? Short gains.`
        : `Traders expect ${month} to cost ${pct} ${up ? "more" : "less"} than today's index (${usd(last)} against ${usd(index)}). Think it will average above ${usd(last)}? Long gains. Below? Short gains.`,
      cls: flat ? undefined : up ? s.up : s.down,
      value: flat ? (
        "No change"
      ) : (
        <>
          {rich && (
            <svg className={s.expArrow} viewBox="0 0 12 12" aria-hidden="true" style={up ? undefined : { transform: "rotate(90deg)" }}>
              <path d="M3 9l6-6M4.5 3H9v4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          )}
          {`${up ? "+" : "−"}${pct}`} {quiet("vs today")}
        </>
      ),
      viz: <Slope dir={flat ? 0 : up ? 1 : -1} />,
    },
    {
      label: "Settles between",
      note: charts
        ? `However the index moves, ${month} settles between ${usd(series.floor)} and ${usd(series.cap)} an hour, so the most you can lose is known before you trade. Buying at ${usd(last)}, red is what a Long can lose and green what it can gain.`
        : `However the index moves, ${month} settles between ${usd(series.floor)} and ${usd(series.cap)} an hour, so the most you can lose is known before you trade. The dot is where ${month} trades now, ${usd(last)}.`,
      cls: rich && !charts ? s.rng : undefined,
      value: (
        <>
          <span>
            {usd(series.floor)} – {usd(series.cap)}
          </span>
          {rich && !charts && <RangeBar lo={series.floor} hi={series.cap} at={last} />}
        </>
      ),
      viz: <Split lo={series.floor} hi={series.cap} at={last} />,
    },
    {
      label: "Today's range",
      note: `${month}'s lowest and highest trade on Kuru in the last 24 hours. The dot is the last trade, ${usd(last)}.`,
      cls: rich && !charts ? s.rng : undefined,
      value: (
        <>
          <span>
            {usd(lo)} – {usd(hi)}
          </span>
          {rich && !charts && <RangeBar lo={lo} hi={hi} at={last} />}
        </>
      ),
      viz: <DayRange lo={lo} hi={hi} at={last} up={dayUp} />,
    },
    {
      label: "Traded today",
      note: charts
        ? `GPU-hours of ${month} that changed hands on Kuru in the last 24 hours, hour by hour: green hours closed higher, red lower.`
        : `GPU-hours of ${month} that changed hands on Kuru in the last 24 hours.`,
      value: (
        <>
          <Num>{int(today)}</Num> {quiet("GPU-hours")}
        </>
      ),
      viz: <HourBars candles={day} />,
    },
    {
      label: "Held open",
      note: charts
        ? `GPU-hours of ${month} sitting in open positions right now, and how that has grown since it listed on ${new Date(listed).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}.`
        : `GPU-hours of ${month} sitting in open positions right now.`,
      value: (
        <>
          <Num>{int(open)}</Num> {quiet("GPU-hours")}
        </>
      ),
      viz: <Growth points={held} />,
    },
    {
      label: "Trading closes",
      note: `The last day to trade ${month}. It settles on the month's average index; December opens Nov 1.`,
      value: rich ? (
        <>
          {mon}{" "}
          <small>
            in <Num>{String(days)}</Num> days
          </small>
        </>
      ) : (
        <>
          {mon}, <Num>{String(days)}</Num> days
        </>
      ),
      viz: <Elapsed frac={(now - listed) / (closes + 86400000 - listed)} />,
    },
  ];

  // the references' set: volume, open interest, next price countdown, close
  const shown: typeof cells =
    look === "refs"
      ? [
          cells[3],
          cells[4],
          {
            label: "Next index price",
            note: "A new index price each day from the clouds' list prices: the day closes at midnight UTC, its price is published about 01:00 UTC and becomes final about 07:00 UTC, after a six-hour window for checks. Daily payouts and new months use the final price; until then the index above stays as it is.",
            value: <NextFix />,
          },
          cells[5],
        ]
      : cells;

  return (
    <dl className={s.hsGrid} data-rich={rich} data-charts={charts} data-look={look} aria-label={`${month} market`}>
      {shown.map((c, i) => (
        <div key={c.label}>
          <dt>
            {rich ? (
              <>
                <button type="button" className={s.tipBtn} data-hint={hint} aria-describedby={`${uid}-${i}`}>
                  {c.label}
                  {hint === "icon" && <InfoIcon />}
                </button>
                <span role="tooltip" id={`${uid}-${i}`} className={s.tip}>
                  {c.note}
                </span>
              </>
            ) : (
              c.label
            )}
          </dt>
          <dd className={c.cls}>{c.value}</dd>
          {charts && c.viz && (
            <dd className={s.viz} aria-hidden="true">
              {c.viz}
            </dd>
          )}
        </div>
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
function NextFix() {
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

/** A thin line from low to high with a dot where the price sits: how close it is to either end. */
function RangeBar({ lo, hi, at }: { lo: number; hi: number; at: number }) {
  const p = hi > lo ? Math.min(1, Math.max(0, (at - lo) / (hi - lo))) : 0.5;
  return (
    <span className={s.rbar} aria-hidden="true">
      <i style={{ left: `${(p * 100).toFixed(1)}%` }} />
    </span>
  );
}

// the small charts: one 140 x 14 frame each, so every cell's chart sits on the same line
const VW = 140;
const VH = 14;
const pos = (lo: number, hi: number, at: number) => (hi > lo ? Math.min(1, Math.max(0, (at - lo) / (hi - lo))) : 0.5);

/** Today's index on the left, November on the right: the slope is the market's forecast. */
function Slope({ dir }: { dir: number }) {
  const y0 = dir > 0 ? 11 : dir < 0 ? 3 : 7;
  const y1 = dir > 0 ? 3 : dir < 0 ? 11 : 7;
  return (
    <svg className={`${s.vz} ${dir > 0 ? s.up : dir < 0 ? s.down : ""}`} viewBox={`0 0 ${VW} ${VH}`}>
      <line x1={3} y1={y0} x2={VW - 3} y2={y1} stroke="currentColor" strokeWidth={1.5} strokeDasharray="3 3" />
      <rect x={0} y={y0 - 2.5} width={5} height={5} className={s.vInk} />
      <rect x={VW - 5} y={y1 - 2.5} width={5} height={5} fill="currentColor" />
    </svg>
  );
}

/** Floor to cap, split at the price: red is what a Long can lose, green what it can gain. */
function Split({ lo, hi, at }: { lo: number; hi: number; at: number }) {
  const x = pos(lo, hi, at) * VW;
  return (
    <svg className={s.vz} viewBox={`0 0 ${VW} ${VH}`}>
      <rect x={0} y={5.5} width={x} height={3} className={s.vLoss} />
      <rect x={x} y={5.5} width={VW - x} height={3} className={s.vGain} />
      <rect x={x - 3.5} y={3.5} width={7} height={7} className={s.vInk} />
    </svg>
  );
}

/** The day's low to high with the last trade marked, green on an up day, red on a down day. */
function DayRange({ lo, hi, at, up }: { lo: number; hi: number; at: number; up: boolean }) {
  const x = pos(lo, hi, at) * VW;
  return (
    <svg className={s.vz} viewBox={`0 0 ${VW} ${VH}`}>
      <rect x={0} y={5.5} width={VW} height={3} className={s.vTrack} />
      <rect x={x - 3.5} y={3.5} width={7} height={7} className={up ? s.vUp : s.vDown} />
    </svg>
  );
}

/** The last 24 hours of volume, one bar an hour, colored by whether the hour closed up or down. */
function HourBars({ candles }: { candles: { o: number; c: number; v: number }[] }) {
  const mx = Math.max(...candles.map((c) => c.v), 1);
  const w = VW / candles.length;
  return (
    <svg className={s.vz} viewBox={`0 0 ${VW} ${VH}`}>
      {candles.map((c, i) => {
        const h = Math.max(1.5, (c.v / mx) * VH);
        return <rect key={i} x={i * w + 0.6} y={VH - h} width={w - 1.6} height={h} className={c.c >= c.o ? s.vUp : s.vDown} />;
      })}
    </svg>
  );
}

/** Held open since listing: a line with a soft fill under it. */
function Growth({ points }: { points: number[] }) {
  const mx = Math.max(...points, 1);
  const d = points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * VW).toFixed(1)} ${(VH - 1 - (p / mx) * (VH - 2)).toFixed(1)}`).join(" ");
  return (
    <svg className={s.vz} viewBox={`0 0 ${VW} ${VH}`}>
      <path d={`${d} L${VW} ${VH} L0 ${VH} Z`} className={s.vFill} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} className={s.vLine} />
    </svg>
  );
}

/** Listing to close, filled up to today. */
function Elapsed({ frac }: { frac: number }) {
  const x = Math.min(1, Math.max(0, frac)) * VW;
  return (
    <svg className={s.vz} viewBox={`0 0 ${VW} ${VH}`}>
      <rect x={0} y={5.5} width={VW} height={3} className={s.vTrack} />
      <rect x={0} y={5.5} width={Math.max(x, 2)} height={3} className={s.vInk} />
      <rect x={Math.max(x, 2) - 1} y={2} width={2} height={10} className={s.vInk} />
    </svg>
  );
}
