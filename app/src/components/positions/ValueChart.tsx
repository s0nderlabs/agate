"use client";
// The holdings in view hour by hour (Positions in the market frame, Oct 7): their gain or loss since bought around a
// dashed break-even line when every cost is known (`gain`), else what they were worth beside what they cost. A value
// line jumps whenever a holding is added and flattens the moves that matter; the gain line starts each holding at
// zero, so it shows only how they did and ends on the header's "since bought". The
// market chart's own look (chart.module.css): its grid, axis font, end tag, guide line and readout, so moving between
// Markets and Positions reads as one app. Money on the axis in whole dollars. The points come from frame.ts's
// valueLine: the held months' real candles and the holdings' own numbers, never a made-up curve.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Num } from "@/components/num/Num";
import { int, usd0 } from "@/lib/format";
import { axisTime, moneyScale, pointTime, spanHours, type ValuePoint } from "./frame";
import s from "@/components/trade/chart.module.css";
import m from "./posmarket.module.css";

/** The axis column, a little wider than the market's (dollars run to five figures here). */
const AXIS = 72;

export function ValueChart({ points: raw, height = "100%", gain = false }: { points: ValuePoint[]; height?: number | string; gain?: boolean }) {
  // the gain line: what it is worth (paid out included) less what it cost, so the break-even line is zero
  const given = useMemo(() => (gain ? raw.map((p) => (p.cost === null ? p : { t: p.t, value: p.value - p.cost, cost: 0 })) : raw), [raw, gain]);
  // one point (bought this hour) still draws: a flat line across
  const points = useMemo(() => (given.length === 1 ? [{ ...given[0], t: given[0].t - 3_600_000 }, given[0]] : given), [given]);
  const n = points.length;
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const fadeId = `vfade${useId().replace(/:/g, "")}`;
  const hasCost = points.some((p) => p.cost !== null);
  const { lo, hi, ticks } = useMemo(() => moneyScale(points.flatMap((p) => (p.cost === null ? [p.value] : [p.value, p.cost]))), [points]);
  const money = (v: number) => (gain ? signed(v) : usd0(v));
  const pinned = hover !== null;
  // a touch readout stays pinned until a tap lands outside the plot
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      if (!plotRef.current?.contains(e.target as Node)) setHover(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [pinned]);
  if (n < 2)
    return (
      <div className={s.wrap}>
        <div className={s.chart} style={{ height, gridTemplateColumns: `minmax(0, 1fr) ${AXIS}px` }} />
      </div>
    );

  const t0 = points[0].t;
  const t1 = points[n - 1].t;
  const X = (t: number) => ((t - t0) / (t1 - t0)) * 1000;
  const Y = (v: number) => ((hi - v) / (hi - lo)) * 400;
  const pct = (v: number, max: number) => `${(v / max) * 100}%`;
  const line = points.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(2)},${Y(p.value).toFixed(2)}`).join(" ");
  // the fade runs from the line to the break-even line (gain), else to the floor
  const base = gain ? Y(0).toFixed(2) : "400";
  const area = `${line} L1000,${base} L0,${base} Z`;
  // what was paid steps when a holding is added: a step line, dashed
  let cost = "";
  if (hasCost)
    points.forEach((p, i) => {
      if (p.cost === null) return;
      cost += cost ? ` H${X(p.t).toFixed(2)} V${Y(p.cost).toFixed(2)}` : `M${X(p.t).toFixed(2)},${Y(p.cost).toFixed(2)}`;
      if (i === n - 1) cost += " H1000";
    });
  const last = points[n - 1];
  const span = spanHours(points);
  // a short line (bought within the last hours) says only where it starts and ends
  const xTicks = [...new Set((span < 12 ? [0, 1] : [0, 1 / 3, 2 / 3, 1]).map((f) => t0 + f * (t1 - t0)))];

  // the nearest point to the pointer, by time
  const onMove = (e: React.PointerEvent) => {
    const r = plotRef.current?.getBoundingClientRect();
    if (!r) return;
    const t = t0 + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (t1 - t0);
    let a = 0;
    let b = n - 1;
    while (b - a > 1) {
      const mid = (a + b) >> 1;
      if (points[mid].t <= t) a = mid;
      else b = mid;
    }
    setHover(t - points[a].t <= points[b].t - t ? a : b);
  };
  const h = hover !== null ? points[hover] : null;

  return (
    <div className={s.wrap}>
      <div className={s.chart} style={{ height, gridTemplateColumns: `minmax(0, 1fr) ${AXIS}px` }}>
        <div
          ref={plotRef}
          className={s.plot}
          onPointerMove={onMove}
          onPointerDown={(e) => e.pointerType !== "mouse" && onMove(e)}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
        >
          <svg viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
            {ticks.map((v) => (
              <line key={v} className={s.grid} x1={0} x2={1000} y1={Y(v)} y2={Y(v)} />
            ))}
            <defs>
              <linearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: "var(--ink)", stopOpacity: 0.09 }} />
                <stop offset="1" style={{ stopColor: "var(--ink)", stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            <path d={area} fill={`url(#${fadeId})`} />
            {cost && <path className={m.costLine} d={cost} />}
            <path className={s.line} d={line} />
            {h && <line className={s.guide} x1={X(h.t)} x2={X(h.t)} y1={0} y2={400} />}
          </svg>
          <span className={s.endDot} style={{ left: "100%", top: pct(Y(last.value), 400) }} />
          {h && (
            <>
              <span className={s.hoverDot} style={{ left: pct(X(h.t), 1000), top: pct(Y(h.value), 400) }} />
              <div className={s.readout} style={{ left: pct(X(h.t), 1000) }} data-side={X(h.t) > 700 ? "left" : "right"}>
                <span>{pointTime(h.t)}</span>
                {gain ? (
                  <b>
                    Gain or loss <Num>{signed(h.value)}</Num>
                  </b>
                ) : (
                  <>
                    <b>
                      Value <Num>{usd0(h.value)}</Num>
                    </b>
                    {h.cost !== null && (
                      <span>
                        What you paid <Num>{usd0(h.cost)}</Num>
                      </span>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <div className={s.axis} aria-hidden="true">
          {/* a tick label the end tag would cover is left out (its gridline stays) */}
          {ticks.map((v) =>
            Math.abs(Y(v) - Y(last.value)) < 26 ? null : (
              <span key={v} style={{ top: pct(Y(v), 400) }}>
                <Num>{money(v)}</Num>
              </span>
            ),
          )}
          <span className={s.endTag} style={{ top: pct(Y(last.value), 400) }}>
            <Num>{gain ? signedInt(last.value) : int(last.value)}</Num>
          </span>
        </div>
      </div>
      <div className={s.xaxis} style={{ marginRight: AXIS }} aria-hidden="true">
        {xTicks.map((t, k) => (
          <span key={k} style={{ left: pct(X(t), 1000) }} data-edge={k === 0 ? "start" : k === xTicks.length - 1 ? "end" : undefined}>
            {axisTime(t, span)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** "+$120", "−$45", "$0": a gain or loss in whole dollars, signed (never a signed zero). */
function signed(v: number) {
  const r = Math.round(v);
  return r === 0 ? "$0" : `${r > 0 ? "+" : "−"}${usd0(Math.abs(r))}`;
}
/** The end tag's figure: "+120", "−45", "0". */
function signedInt(v: number) {
  const r = Math.round(v);
  return r === 0 ? "0" : `${r > 0 ? "+" : "−"}${int(Math.abs(r))}`;
}

/** The faded example for an empty page (an illustration, hidden from screen readers): a calm gain line that dips
 *  under a dashed break-even line and rises above it. The one drawn-up curve on the page, and it says nothing. */
export function ExampleLine() {
  const d = "M0,262 C70,268 120,292 190,284 S300,250 370,258 S480,286 560,262 S700,214 780,222 S900,186 1000,170";
  return (
    <svg className={m.example} viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
      {[80, 160, 240, 320].map((y) => (
        <line key={y} className={s.grid} x1={0} x2={1000} y1={y} y2={y} />
      ))}
      <path className={m.costLine} d="M0,250 H1000" />
      <path className={s.line} d={d} />
    </svg>
  );
}
