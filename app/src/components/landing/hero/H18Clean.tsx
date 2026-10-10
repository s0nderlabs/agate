"use client";
// Direction 2, "Clean line" (Oct 8). Public's white and quiet, one serif headline, one line. The second round: the words
// under the headline, and in place of the fan of possible paths a chip pathway. So: H100's real price (next month as traded on Agate, hour by hour, or the index's
// days before the month trades) is drawn in from the left and runs into a chip at now. Out of the chip's far side its
// traces fan out the way a package's pins break out on a board, a 45 degree bend each, to the right edge, and signals
// keep flowing along them. The price is the line; the chip is what it prices; the traces are where the compute goes.
import { useEffect, useRef, useState } from "react";
import { stillMode } from "@/components/lab/data";
import { frontMonth } from "@/lib/data/derive";
import { useCandles, useMarkets, useNow } from "@/lib/data/hooks";
import { runCanvas } from "./gl";
import { CLAIM, Cta, Nav, k, smoothPath, useHero, useStill, usd } from "./kit";
import s from "./h18.module.css";

const SUB = ["Lock in what you pay for GPUs.", "Lock in what you earn from them.", "Or trade where the price goes."];
// when the chip and its traces come in (after the line has drawn), and how many traces leave it
const CHIP_AT = 2.3, TRACES = 12;
const INK = "29,33,82", SIGNAL = "61,90,254";

const hash = (a: number, b: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return v - Math.floor(v);
};
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** The traces' routes out of a chip of size cs centred at (cx, cy), to lanes spread over the box's height: a pin stub,
 *  a 45 degree run to the lane, then straight to the edge. All bends at the same x, so neighbours run parallel. */
function routes(cx: number, cy: number, cs: number, W: number, H: number) {
  const out: { pts: [number, number][]; len: number }[] = [];
  const x0 = cx + cs / 2, xt = x0 + cs * 0.55;
  for (let n = 0; n < TRACES; n++) {
    const py = cy - cs / 2 + ((n + 0.5) / TRACES) * cs;
    const ly = H * 0.06 + ((n + 0.5) / TRACES) * H * 0.88;
    const pts: [number, number][] = [[x0, py], [xt, py], [xt + Math.abs(ly - py), ly], [W + 30, ly]];
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    out.push({ pts, len });
  }
  return out;
}
/** The point a distance d along a route. */
function at(pts: [number, number][], d: number): [number, number] {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const l = Math.hypot(bx - ax, by - ay);
    if (d <= l) return [ax + ((bx - ax) * d) / l, ay + ((by - ay) * d) / l];
    d -= l;
  }
  return pts[pts.length - 1];
}

export function H18Clean() {
  const r = useHero();
  const still = useStill();
  const words = CLAIM.split(" ");
  const lines = [words.slice(0, -1).join(" "), words[words.length - 1]];
  const { markets } = useMarkets();
  const now = useNow();
  const h100 = markets?.find((x) => x.gpu === "H100");
  const series = h100?.tradable ? frontMonth(h100, now) : undefined;
  const { candles } = useCandles(series);
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const endRef = useRef<{ x: number; y: number } | null>(null);
  const [w, setW] = useState(0);
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // measured once now, then on every resize (a resize observer's first call waits for the page to paint)
    setW(el.clientWidth);
    setH(el.clientHeight);
    const ro = new ResizeObserver(() => {
      setW(el.clientWidth);
      setH(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the traded month, hour by hour (closes); the index's days only if the month has no trades yet
  const traded = candles.filter((c) => c.c > 0);
  const useTraded = traded.length >= 12;
  const days = useTraded ? traded.map((c) => ({ date: c.t, price: c.c })) : r.hist.slice(-90);
  const vals = days.map((d) => d.price);
  const last = vals[vals.length - 1] ?? r.h.price;
  // the past in a band round the middle of the chart, ending at the chip a little past half way across
  const half = Math.max(0.02, ...vals.map((v) => Math.abs(v - last)));
  const span = half / 0.3;
  const endX = w > 700 ? w * 0.52 : w * 0.42;
  // on a wide screen the chart is the whole hero: the line sits low, under the words; on a phone it has its own box
  const low = w > 900 ? 0.42 : 0;
  const { d, pts } = w && h ? smoothPath(vals, endX, h, { t: h * low, b: 0, l: -40, r: 0 }, [last - span, last + span]) : { d: "", pts: [] };
  const end = pts[pts.length - 1];
  endRef.current = end ? { x: end[0], y: end[1] } : null;
  const firsts = days.map((x, n) => (useTraded ? x.date.slice(11, 13) === "00" : x.date.endsWith("-01")) ? n : -1).filter((n) => n > 0 && n < days.length - 3);

  // the chip and its traces, on a canvas over the chart; it starts with the line (a still frame redraws on resize)
  const lineKey = d ? (still ? `${w}x${h}` : "on") : "";
  useEffect(() => {
    const c = cv.current;
    if (!c || !lineKey) return;
    return runCanvas(c, {
      still: stillMode(),
      dprMax: 2,
      draw: (ctx, t0, W, H) => {
        const e = endRef.current;
        if (!e) return;
        const t = t0 < 0 ? 9 : t0;
        if (t < CHIP_AT) return;
        const cs = Math.max(34, Math.min(56, W * 0.03));
        const cx = e.x + cs / 2, cy = e.y;
        const rs = routes(cx, cy, cs, W, H);
        const age = t - CHIP_AT;

        // the traces draw out of the chip one after another, from the middle pins outward
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        rs.forEach((rt, n) => {
          const order = Math.abs(n - (TRACES - 1) / 2);
          const grow = smooth((age - 0.35 - order * 0.07) / 1.3);
          if (grow <= 0) return;
          ctx.strokeStyle = `rgba(${INK},0.2)`;
          ctx.setLineDash([rt.len * grow, rt.len]);
          ctx.beginPath();
          ctx.moveTo(rt.pts[0][0], rt.pts[0][1]);
          for (let i = 1; i < rt.pts.length; i++) ctx.lineTo(rt.pts[i][0], rt.pts[i][1]);
          ctx.stroke();
          ctx.setLineDash([]);
          // a via where each trace leaves its diagonal
          if (grow > 0.5) {
            const [vx, vy] = rt.pts[2];
            ctx.fillStyle = "#ffffff";
            ctx.strokeStyle = `rgba(${INK},0.35)`;
            ctx.beginPath();
            ctx.arc(vx, vy, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        });

        // signals: a short bright run travelling out along each trace, each on its own beat
        if (age > 1.6) {
          rs.forEach((rt, n) => {
            const every = 2.4 + 1.6 * hash(n, 1.3), speed = 260;
            const tt = age - 1.6 + every * hash(n, 4.1);
            const k2 = Math.floor(tt / every);
            const dist = (tt - k2 * every) * speed;
            if (dist > rt.len) return;
            const tail = 70;
            const [hx, hy] = at(rt.pts, dist);
            const [tx, ty] = at(rt.pts, Math.max(0, dist - tail));
            const g = ctx.createLinearGradient(tx, ty, hx, hy);
            g.addColorStop(0, `rgba(${SIGNAL},0)`);
            g.addColorStop(1, `rgba(${SIGNAL},0.95)`);
            ctx.strokeStyle = g;
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            const steps = 8;
            for (let i = 0; i <= steps; i++) {
              const [px, py] = at(rt.pts, Math.max(0, dist - tail) + (Math.min(tail, dist) * i) / steps);
              if (i) ctx.lineTo(px, py);
              else ctx.moveTo(px, py);
            }
            ctx.stroke();
            ctx.fillStyle = `rgba(${SIGNAL},1)`;
            ctx.beginPath();
            ctx.arc(hx, hy, 2.4, 0, Math.PI * 2);
            ctx.fill();
          });
        }

        // the chip: a package with pins on every side, its die inside, a slow glow while it works
        const pin = 5, pins = 7;
        const enter = smooth(age / 0.5);
        ctx.globalAlpha = enter;
        ctx.strokeStyle = `rgba(${INK},0.55)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < pins; i++) {
          const o = -cs / 2 + ((i + 0.5) / pins) * cs;
          ctx.moveTo(cx + o, cy - cs / 2);
          ctx.lineTo(cx + o, cy - cs / 2 - pin);
          ctx.moveTo(cx + o, cy + cs / 2);
          ctx.lineTo(cx + o, cy + cs / 2 + pin);
          ctx.moveTo(cx - cs / 2, cy + o);
          ctx.lineTo(cx - cs / 2 - pin, cy + o);
        }
        ctx.stroke();
        const glow = 0.5 + 0.5 * Math.sin(age * 1.6);
        const rg = ctx.createRadialGradient(cx, cy, cs * 0.3, cx, cy, cs * 1.6);
        rg.addColorStop(0, `rgba(${SIGNAL},${(0.1 + 0.08 * glow).toFixed(3)})`);
        rg.addColorStop(1, `rgba(${SIGNAL},0)`);
        ctx.fillStyle = rg;
        ctx.fillRect(cx - cs * 1.6, cy - cs * 1.6, cs * 3.2, cs * 3.2);
        ctx.fillStyle = "#1d2152";
        ctx.fillRect(cx - cs / 2, cy - cs / 2, cs, cs);
        const ds = cs * 0.56;
        ctx.fillStyle = "#3d4f8f";
        ctx.fillRect(cx - ds / 2, cy - ds / 2, ds, ds);
        // the die's own grid of compute units, lighting in a slow diagonal wave
        const g4 = 4, cell = ds / g4;
        for (let i = 0; i < g4; i++)
          for (let j = 0; j < g4; j++) {
            const wv = 0.5 + 0.5 * Math.sin(age * 2.2 - (i + j) * 0.9);
            ctx.fillStyle = `rgba(160,180,255,${(0.25 + 0.55 * wv).toFixed(3)})`;
            ctx.fillRect(cx - ds / 2 + j * cell + 1, cy - ds / 2 + i * cell + 1, cell - 2, cell - 2);
          }
        ctx.globalAlpha = 1;
      },
    });
  }, [lineKey]);

  const cs = Math.max(34, Math.min(56, w * 0.03));
  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav />
      <div className={s.body}>
        <div className={s.copy}>
          <h1 className={s.h1}>
            {lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </h1>
          <p className={s.sub}>
            {SUB.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </p>
          <Cta />
        </div>
        <div ref={box} className={s.chart}>
          {d && (
            <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-label={useTraded ? `H100 ${r.month} as traded on Agate since it listed, ${usd(last)} last, running into a chip whose traces fan out to the edge` : `H100's price over the last ${days.length} days, ${usd(r.h.price)} today, running into a chip whose traces fan out to the edge`}>
              <defs>
                {/* in page units: a box-relative gradient vanishes when the line is level */}
                <linearGradient id="h18stroke" gradientUnits="userSpaceOnUse" x1="0" x2={endX} y1="0" y2="0">
                  <stop offset="0" stopColor="#9fb3d9" stopOpacity="0" />
                  <stop offset=".25" stopColor="#9fb3d9" />
                  <stop offset=".8" stopColor="#3d4f8f" />
                  <stop offset="1" stopColor="#1d2152" />
                </linearGradient>
                <linearGradient id="h18fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="#c9d5ea" stopOpacity=".26" />
                  <stop offset="1" stopColor="#c9d5ea" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`${d} L${end[0]},${h} L-40,${h} Z`} fill="url(#h18fill)" className={s.area} />
              <path d={d} className={s.line} stroke="url(#h18stroke)" pathLength={1} />
              {firsts.map((n) => (
                <circle key={n} cx={pts[n][0]} cy={pts[n][1]} r="5" className={s.ring} />
              ))}
            </svg>
          )}
          <canvas ref={cv} className={s.fan} aria-hidden />
          {end && (
            <div className={s.tag} style={{ left: end[0] - 18, top: end[1] - cs / 2 - 30 }}>
              <b>{usd(useTraded ? last : r.h.price)}</b>
              <span>{useTraded ? `H100 ${r.month}, last trade` : "H100, an hour today"}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
