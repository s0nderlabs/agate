"use client";
// Hourly candles for the traded month. The index itself is one fix a day, so it has no candles;
// the November token trades all day on Kuru, so it does. Volume sits under the candles.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Candle } from "@/lib/mock/market";
import { Num } from "@/components/num/Num";
import { int, usd } from "@/lib/format";
import s from "./chart.module.css";

function niceStep(span: number) {
  for (const st of [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]) if (span / st <= 6) return st;
  return 2;
}
const hourLabel = (iso: string) => {
  // shown in UTC
  const d = new Date(Date.parse(iso));
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day}, ${String(d.getUTCHours()).padStart(2, "0")}:00`;
};
const dayLabel = (iso: string) => new Date(Date.parse(iso)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const HOUR = 3_600_000;

/** The hourly candles merged into candles of `size` hours (UTC-aligned): open of the first, close of the last, the
 * highest high, lowest low and summed volume. size 1 returns them as they are. */
function merged(all: Candle[], size: number): Candle[] {
  if (size <= 1) return all;
  const B = size * HOUR;
  const out: Candle[] = [];
  for (const c of all) {
    const at = Math.floor(Date.parse(c.t) / B) * B;
    const prev = out[out.length - 1];
    if (prev && Date.parse(prev.t) === at) {
      prev.h = Math.max(prev.h, c.h);
      prev.l = Math.min(prev.l, c.l);
      prev.c = c.c;
      prev.v += c.v;
    } else out.push({ t: new Date(at).toISOString(), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
  }
  return out;
}

/** startAt: when the month listed. The axis then runs one slot per candle from the listing (or `hours` back from the
 * last candle, whichever is later) to the last candle, so the time before its first trade, and any quiet slot, stays
 * empty. Without it, the last candles that fit `hours` side by side. size: hours per candle (1, 4 or 24). */
/** spread: the book's best bid and ask now, drawn as a quiet band behind the candles, so a market that barely trades
 *  reads calm: a fill at the bid or the ask lands on the band's edge instead of looking like a sudden drop. */
export function CandleChart({ candles: hourly, hours, size = 1, kind = "candles", height = 360, startAt, spread = null }: { candles: Candle[]; hours: number; size?: number; kind?: "candles" | "line"; height?: number | string; startAt?: string; spread?: { bid: number; ask: number } | null }) {
  const { candles, slots } = useMemo(() => {
    const all = merged(hourly, size);
    const B = size * HOUR;
    const start = startAt ? Date.parse(startAt) : NaN;
    const span = Math.max(1, Math.ceil(hours / size));
    if (!Number.isFinite(start) || !all.length) {
      const c = all.slice(-span);
      return { candles: c as (Candle | null)[], slots: c.map((x) => Date.parse(x.t)) };
    }
    const slotOf = (iso: string) => Math.floor(Date.parse(iso) / B) * B;
    const end = slotOf(all[all.length - 1].t);
    const from = Math.min(end, Math.max(Math.floor(start / B) * B, end - (span - 1) * B));
    const bySlot = new Map(all.map((c) => [slotOf(c.t), c]));
    const slots: number[] = [];
    for (let t = from; t <= end; t += B) slots.push(t);
    return { candles: slots.map((t) => bySlot.get(t) ?? null), slots };
  }, [hourly, hours, size, startAt]);
  // a daily candle is a UTC day; shorter ones carry their hour
  const label = (iso: string) => (size >= 24 ? dayLabel(iso) : hourLabel(iso));
  // the candles actually drawn (an empty hour has none)
  const drawn = useMemo(() => candles.filter((c): c is Candle => c !== null), [candles]);
  const n = candles.length;
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  // the band only for a real two-sided book
  const band = spread && spread.bid > 0 && spread.ask > spread.bid ? spread : null;
  const { lo, hi, ticks, vmax } = useMemo(() => {
    // no trades yet: an empty plot, no scale
    if (!drawn.length) return { lo: 0, hi: 1, ticks: [] as number[], vmax: 1 };
    const mn = Math.min(...drawn.map((c) => c.l), band ? band.bid : Infinity);
    const mx = Math.max(...drawn.map((c) => c.h), band ? band.ask : -Infinity);
    const pad = (mx - mn) * 0.12 || 0.02;
    const st = niceStep(mx - mn + pad * 2);
    const lo = Math.floor((mn - pad) / st) * st;
    const hi = Math.ceil((mx + pad) / st) * st;
    const ticks: number[] = [];
    for (let v = lo; v <= hi + 1e-9; v += st) ticks.push(Math.round(v * 1000) / 1000);
    return { lo, hi, ticks, vmax: Math.max(...drawn.map((c) => c.v)) || 1 };
  }, [drawn, band?.bid, band?.ask]);
  // a touch readout stays pinned until a tap lands outside the plot
  const pinned = hover !== null;
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      if (!plotRef.current?.contains(e.target as Node)) setHover(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [pinned]);
  // every hook sits above this line: with no candles the plot keeps its size and draws nothing (the state's own panel
  // comes with live pass 2)
  if (!n || !drawn.length) return <div className={s.wrap}><div className={s.chart} style={{ height }} /></div>;

  // price area takes the top 80%, volume the bottom 16%
  const slot = 1000 / n;
  const X = (i: number) => slot * (i + 0.5);
  const Y = (p: number) => ((hi - p) / (hi - lo)) * 320;
  const VY = (v: number) => 400 - (v / vmax) * 64;
  const pct = (v: number, max: number) => `${(v / max) * 100}%`;
  const last = drawn[drawn.length - 1];
  // the line joins the hours that traded (index i is the slot)
  const pts = candles.flatMap((c, i) => (c ? [{ c, i }] : []));
  const xTicks = [0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1];

  const onMove = (e: React.PointerEvent) => {
    const r = plotRef.current?.getBoundingClientRect();
    if (!r) return;
    const t = Math.max(0, Math.min(0.9999, (e.clientX - r.left) / r.width));
    setHover(Math.floor(t * n));
  };
  const h = hover !== null ? candles[hover] : null;

  return (
    <div className={s.wrap}>
      <div className={s.chart} style={{ height }}>
        <div
          ref={plotRef}
          className={s.plot}
          onPointerMove={onMove}
          // a finger: a tap pins the readout (a mouse keeps hover); it clears on a tap outside the plot
          onPointerDown={(e) => e.pointerType !== "mouse" && onMove(e)}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
        >
          <svg viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
            {ticks.map((v) => (
              <line key={v} className={s.grid} x1={0} x2={1000} y1={Y(v)} y2={Y(v)} />
            ))}
            {band && (
              <g className={s.spread}>
                <rect x={0} width={1000} y={Y(band.ask)} height={Math.max(Y(band.bid) - Y(band.ask), 0.8)} />
                <line x1={0} x2={1000} y1={Y(band.ask)} y2={Y(band.ask)} />
                <line x1={0} x2={1000} y1={Y(band.bid)} y2={Y(band.bid)} />
              </g>
            )}
            {kind === "line" && (
              <>
                <path className={s.area} d={`${pts.map(({ c, i }, k) => `${k ? "L" : "M"}${X(i).toFixed(2)},${Y(c.c).toFixed(2)}`).join(" ")} L${X(pts[pts.length - 1].i).toFixed(2)},320 L${X(pts[0].i).toFixed(2)},320 Z`} />
                <path className={s.line} d={pts.map(({ c, i }, k) => `${k ? "L" : "M"}${X(i).toFixed(2)},${Y(c.c).toFixed(2)}`).join(" ")} />
              </>
            )}
            {candles.map((c, i) => {
              if (!c) return null;
              const up = c.c >= c.o;
              if (kind === "line")
                return <rect key={c.t} className={s.vol} x={X(i) - slot * 0.32} y={VY(c.v)} width={slot * 0.64} height={400 - VY(c.v)} />;
              const top = Y(Math.max(c.o, c.c));
              const bh = Math.max(Math.abs(Y(c.o) - Y(c.c)), 0.8);
              return (
                <g key={c.t} className={up ? s.cUp : s.cDown} opacity={hover === null || hover === i ? 1 : 0.55}>
                  <line className={s.wick} x1={X(i)} x2={X(i)} y1={Y(c.h)} y2={Y(c.l)} />
                  <rect x={X(i) - slot * 0.32} y={top} width={slot * 0.64} height={bh} />
                  <rect className={s.vol} x={X(i) - slot * 0.32} y={VY(c.v)} width={slot * 0.64} height={400 - VY(c.v)} />
                </g>
              );
            })}
            {h && <line className={s.guide} x1={X(hover!)} x2={X(hover!)} y1={0} y2={400} />}
          </svg>
          {h && (
            <div className={s.readout} style={{ left: pct(X(hover!), 1000) }} data-side={hover! > n * 0.7 ? "left" : "right"}>
              <b>
                <Num>{usd(h.c)}</Num>
              </b>
              <span>{label(h.t)} UTC</span>
              <span className={s.ohlc}>
                <Num>{`O ${h.o.toFixed(3)}  H ${h.h.toFixed(3)}`}</Num>
              </span>
              <span className={s.ohlc}>
                <Num>{`L ${h.l.toFixed(3)}  C ${h.c.toFixed(3)}`}</Num>
              </span>
              <span className={s.note}>
                <Num>{int(h.v)}</Num> GPU-hours traded
              </span>
            </div>
          )}
        </div>
        <div className={s.axis} aria-hidden="true">
          {ticks.map((v) =>
            Math.abs(Y(v) - Y(last.c)) < 26 ? null : (
              <span key={v} style={{ top: pct(Y(v), 400) }}>
                <Num>{usd(v)}</Num>
              </span>
            ),
          )}
          <span className={s.endTag} style={{ top: pct(Y(last.c), 400) }}>
            <Num>{last.c.toFixed(2)}</Num>
          </span>
        </div>
      </div>
      <div className={s.xaxis} aria-hidden="true">
        {xTicks.map((i, k) => (
          <span key={k} style={{ left: pct(X(i), 1000) }} data-edge={k === 0 ? "start" : k === xTicks.length - 1 ? "end" : undefined}>
            {label(new Date(slots[i]).toISOString())}
          </span>
        ))}
      </div>
    </div>
  );
}
