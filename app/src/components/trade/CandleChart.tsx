"use client";
// Hourly candles for the traded month. The index itself is one fix a day, so it has no candles;
// the November token trades all day on Kuru, so it does. Volume sits under the candles.
import { useMemo, useRef, useState } from "react";
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

export function CandleChart({ candles: all, hours, kind = "candles", height = 360 }: { candles: Candle[]; hours: number; kind?: "candles" | "line"; height?: number | string }) {
  const candles = useMemo(() => all.slice(-hours), [all, hours]);
  const n = candles.length;
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const { lo, hi, ticks, vmax } = useMemo(() => {
    const mn = Math.min(...candles.map((c) => c.l));
    const mx = Math.max(...candles.map((c) => c.h));
    const pad = (mx - mn) * 0.12 || 0.02;
    const st = niceStep(mx - mn + pad * 2);
    const lo = Math.floor((mn - pad) / st) * st;
    const hi = Math.ceil((mx + pad) / st) * st;
    const ticks: number[] = [];
    for (let v = lo; v <= hi + 1e-9; v += st) ticks.push(Math.round(v * 1000) / 1000);
    return { lo, hi, ticks, vmax: Math.max(...candles.map((c) => c.v)) };
  }, [candles]);

  // price area takes the top 80%, volume the bottom 16%
  const slot = 1000 / n;
  const X = (i: number) => slot * (i + 0.5);
  const Y = (p: number) => ((hi - p) / (hi - lo)) * 320;
  const VY = (v: number) => 400 - (v / vmax) * 64;
  const pct = (v: number, max: number) => `${(v / max) * 100}%`;
  const last = candles[n - 1];
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
        <div ref={plotRef} className={s.plot} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <svg viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
            {ticks.map((v) => (
              <line key={v} className={s.grid} x1={0} x2={1000} y1={Y(v)} y2={Y(v)} />
            ))}
            {kind === "line" && (
              <>
                <path className={s.area} d={`${candles.map((c, i) => `${i ? "L" : "M"}${X(i).toFixed(2)},${Y(c.c).toFixed(2)}`).join(" ")} L${X(n - 1).toFixed(2)},320 L${X(0).toFixed(2)},320 Z`} />
                <path className={s.line} d={candles.map((c, i) => `${i ? "L" : "M"}${X(i).toFixed(2)},${Y(c.c).toFixed(2)}`).join(" ")} />
              </>
            )}
            {candles.map((c, i) => {
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
              <span>{hourLabel(h.t)} UTC</span>
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
            {hourLabel(candles[i].t)}
          </span>
        ))}
      </div>
    </div>
  );
}
