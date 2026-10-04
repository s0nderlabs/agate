"use client";
// The index as it really moves: flat for days, then a step when a cloud reprices. Drawn as a step line
// with a real crosshair (follows the pointer, vertical guide, date and value readout). Example days
// before Sep 30 are drawn lighter so nobody mistakes them for our record.
import { useMemo, useRef, useState } from "react";
import type { Day } from "@/lib/mock/market";
import { Num } from "@/components/num/Num";
import { shortDate, usd } from "@/lib/format";
import s from "./chart.module.css";

export type Range = "1W" | "1M" | "3M" | "ALL";
const SPAN: Record<Range, number> = { "1W": 7, "1M": 30, "3M": 90, ALL: 10_000 };

function niceStep(span: number) {
  for (const st of [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5]) if (span / st <= 6) return st;
  return 10;
}

export function LineChart({ days: all, range, band, height = 360 }: { days: Day[]; range: Range; band?: { floor: number; cap: number; label: string } | null; height?: number | string }) {
  const days = useMemo(() => all.slice(-SPAN[range]), [all, range]);
  const n = days.length;
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const { lo, hi, ticks } = useMemo(() => {
    let mn = Math.min(...days.map((d) => d.price));
    let mx = Math.max(...days.map((d) => d.price));
    if (band) {
      mn = Math.min(mn, band.floor);
      mx = Math.max(mx, band.cap);
    }
    const pad = Math.max((mx - mn) * 0.18, mx * 0.02);
    const st = niceStep(mx - mn + pad * 2);
    const lo = Math.floor((mn - pad) / st) * st;
    const hi = Math.ceil((mx + pad) / st) * st;
    const ticks: number[] = [];
    for (let v = lo; v <= hi + 1e-9; v += st) ticks.push(Math.round(v * 100) / 100);
    return { lo, hi, ticks };
  }, [days, band]);

  const X = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * 1000);
  const Y = (p: number) => ((hi - p) / (hi - lo)) * 400;
  const pct = (v: number, max: number) => `${(v / max) * 100}%`;

  // step-after path, split where example history ends
  const firstReal = days.findIndex((d) => !d.example);
  const pathFor = (from: number, to: number) => {
    if (to < from) return "";
    let d = `M${X(from).toFixed(2)},${Y(days[from].price).toFixed(2)}`;
    for (let i = from + 1; i <= to; i++) d += ` H${X(i).toFixed(2)} V${Y(days[i].price).toFixed(2)}`;
    return d;
  };
  const exampleEnd = firstReal === -1 ? n - 1 : Math.max(0, firstReal);
  const examplePath = firstReal === 0 ? "" : pathFor(0, exampleEnd);
  const realPath = firstReal === -1 ? "" : pathFor(firstReal, n - 1);
  const area = `${pathFor(0, n - 1)} V400 H0 Z`;
  const last = days[n - 1];
  const xTicks = [0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1];

  const onMove = (e: React.PointerEvent) => {
    const r = plotRef.current?.getBoundingClientRect();
    if (!r) return;
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    setHover(Math.round(t * (n - 1)));
  };
  const h = hover !== null ? days[hover] : null;

  return (
    <div className={s.wrap}>
      <div className={s.chart} style={{ height }}>
        <div ref={plotRef} className={s.plot} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <svg viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
            {ticks.map((v) => (
              <line key={v} className={s.grid} x1={0} x2={1000} y1={Y(v)} y2={Y(v)} />
            ))}
            {band && (
              <>
                <rect className={s.band} x={0} y={Y(band.cap)} width={1000} height={Y(band.floor) - Y(band.cap)} />
                <line className={s.rail} x1={0} x2={1000} y1={Y(band.cap)} y2={Y(band.cap)} />
                <line className={s.rail} x1={0} x2={1000} y1={Y(band.floor)} y2={Y(band.floor)} />
              </>
            )}
            <path className={s.area} d={area} />
            {examplePath && <path className={`${s.line} ${s.example}`} d={examplePath} />}
            {realPath && <path className={s.line} d={realPath} />}
            {h && <line className={s.guide} x1={X(hover!)} x2={X(hover!)} y1={0} y2={400} />}
          </svg>
          {band && (
            <>
              <span className={s.bandLbl} style={{ top: pct(Y(band.cap), 400) }}>
                {band.label} ceiling {usd(band.cap)}
              </span>
              <span className={s.bandLbl} style={{ top: pct(Y(band.floor), 400), transform: "translateY(calc(-100% - 6px))" }}>
                {band.label} floor {usd(band.floor)}
              </span>
            </>
          )}
          {days.map((d, i) =>
            d.status === "carried" ? <span key={d.date} className={s.carried} style={{ left: pct(X(i), 1000), top: pct(Y(d.price), 400) }} title={`${shortDate(d.date)}: carried, unverified`} /> : null,
          )}
          <span className={s.endDot} style={{ left: "100%", top: pct(Y(last.price), 400) }} />
          {h && (
            <>
              <span className={s.hoverDot} style={{ left: pct(X(hover!), 1000), top: pct(Y(h.price), 400) }} />
              <div className={s.readout} style={{ left: pct(X(hover!), 1000) }} data-side={hover! > n * 0.7 ? "left" : "right"}>
                <b>
                  <Num>{usd(h.price)}</Num>
                </b>
                <span>{shortDate(h.date)}, 2026</span>
                {h.status === "carried" && <span className={s.note}>Carried, unverified</span>}
                {h.example && <span className={s.note}>Example history</span>}
              </div>
            </>
          )}
        </div>
        <div className={s.axis} aria-hidden="true">
          {ticks.map((v) => (
            <span key={v} style={{ top: pct(Y(v), 400) }}>
              <Num>{usd(v)}</Num>
            </span>
          ))}
          <span className={s.endTag} style={{ top: pct(Y(last.price), 400) }}>
            <Num>{last.price.toFixed(2)}</Num>
          </span>
        </div>
      </div>
      <div className={s.xaxis} aria-hidden="true">
        {xTicks.map((i, k) => (
          <span key={k} style={{ left: pct(X(i), 1000) }} data-edge={k === 0 ? "start" : k === xTicks.length - 1 ? "end" : undefined}>
            {shortDate(days[i].date)}
          </span>
        ))}
      </div>
    </div>
  );
}
