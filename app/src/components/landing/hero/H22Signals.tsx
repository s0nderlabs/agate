"use client";
// Direction 3, new variant (Oct 8): "Signals". What a GPU at work looks like on a logic analyzer: a clock, a valid and a
// ready line handshaking, data lines toggling in bursts, a bus passing words (drawn as the analyzer draws them, long
// hexagons, without the numbers). They come out of a cursor at "now" and scroll left into the past. The bottom channel
// is the price: H100's real line, ending at the same cursor. Compute above, its price below. The page is the
// instrument: dark, the headline over the faded left end of the channels.
import { useEffect, useRef } from "react";
import { stillMode } from "@/components/lab/data";
import { frontMonth } from "@/lib/data/derive";
import { useCandles, useMarkets, useNow } from "@/lib/data/hooks";
import { runCanvas } from "./gl";
import { CLAIM, Cta, Nav, k, smoothPath, useHero, useStill, usd } from "./kit";
import s from "./h22.module.css";

const SUB = ["Lock in what you pay for GPUs.", "Lock in what you earn from them.", "Or trade where the price goes."];
const h2 = (a: number, b: number) => {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return v - Math.floor(v);
};
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
// bursts of work: a slow value noise over bit time, busy above a threshold
const busy = (b: number) => {
  const a = Math.floor(b / 20), f = smooth(b / 20 - a);
  return h2(a, 0.5) + (h2(a + 1, 0.5) - h2(a, 0.5)) * f > 0.42;
};
// the channels, top to bottom: what each one's level is at bit b (0 low, 1 high), or the bus's words
type Ch = { kind: "clock" | "bit"; level: (b: number) => number } | { kind: "bus" };
const CHANNELS: Ch[] = [
  { kind: "clock", level: (b) => b & 1 },
  { kind: "bit", level: (b) => (busy(b) ? 1 : 0) },
  { kind: "bit", level: (b) => (busy(b - 2) && h2(b, 7.7) > 0.12 ? 1 : 0) },
  { kind: "bus" },
  { kind: "bit", level: (b) => (busy(b) ? (h2(Math.floor(b / 2), 1.1) > 0.5 ? 1 : 0) : 0) },
  { kind: "bit", level: (b) => (busy(b) ? (h2(Math.floor(b / 3), 2.2) > 0.45 ? 1 : 0) : 0) },
  { kind: "bit", level: (b) => (busy(b) ? (h2(b, 3.3) > 0.55 ? 1 : 0) : 0) },
  { kind: "bit", level: (b) => (busy(b + 3) ? (h2(Math.floor(b / 4), 4.4) > 0.5 ? 1 : 0) : 0) },
];

export function H22Signals() {
  const r = useHero();
  const { markets } = useMarkets();
  const now = useNow();
  const h100 = markets?.find((x) => x.gpu === "H100");
  const series = h100?.tradable ? frontMonth(h100, now) : undefined;
  const { candles } = useCandles(series);
  const traded = candles.filter((c) => c.c > 0);
  const useTraded = traded.length >= 12;
  const vals = useTraded ? traded.map((c) => c.c) : r.hist.slice(-90).map((d) => d.price);
  const last = vals[vals.length - 1] ?? r.h.price;
  const info = useRef({ vals, label: "", price: "" });
  info.current = { vals, label: useTraded ? `H100 ${r.month}, last trade` : "H100, an hour today", price: last > 0 ? usd(last) : "" };
  const still = useStill();
  const dataKey = vals.length >= 2 ? (still ? `${vals.length}:${last}` : "on") : "";
  const cv = useRef<HTMLCanvasElement>(null);
  const words = CLAIM.split(" ");
  const lines = [words.slice(0, -1).join(" "), words[words.length - 1]];

  useEffect(() => {
    const c = cv.current;
    if (!c || !dataKey) return;
    const display = getComputedStyle(c.closest("section")?.querySelector("h1") ?? document.body).fontFamily;
    const body = getComputedStyle(document.body).fontFamily;
    return runCanvas(c, {
      still: stillMode(),
      dprMax: 2,
      draw: (ctx, t0, W, H) => {
        const t = t0 < 0 ? 7 : t0;
        const wide = W > 900;
        const u = wide ? 26 : 18; // one bit, in points
        const nowX = W * (wide ? 0.9 : 0.86);
        const top = H * 0.05, priceH = H * (wide ? 0.22 : 0.22), gap = H * 0.01;
        const digital = H - top - priceH - gap - H * 0.03;
        const rh = digital / CHANNELS.length;
        const off = t * 64; // the signals' scroll, in points
        const slew = 3;
        const b0 = Math.floor((off - nowX) / u) - 1, b1 = Math.ceil(off / u) + 1;
        const xOf = (b: number) => nowX - (off - b * u);

        // time divisions and channel rules
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        ctx.beginPath();
        for (let b = Math.floor(b0 / 8) * 8; b <= b1; b += 8) {
          const x = Math.round(xOf(b)) + 0.5;
          if (x < 0 || x > nowX) continue;
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + digital);
        }
        for (let n = 0; n <= CHANNELS.length; n++) {
          const y = Math.round(top + n * rh) + 0.5;
          ctx.moveTo(0, y);
          ctx.lineTo(nowX, y);
        }
        ctx.stroke();

        // the channels
        CHANNELS.forEach((ch, n) => {
          const y0 = top + n * rh, hi = y0 + rh * 0.3, lo = y0 + rh * 0.7, mid = y0 + rh * 0.5;
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, y0, nowX, rh);
          ctx.clip();
          if (ch.kind === "bus") {
            // words on the bus while it is busy, a floating mid line while idle
            const p = new Path2D(), fill = new Path2D();
            let b = b0;
            while (b <= b1) {
              if (!busy(b)) {
                const xs = xOf(b);
                p.moveTo(xs, mid);
                p.lineTo(xs + u, mid);
                b++;
                continue;
              }
              let e = b + 1;
              while (e <= b1 + 8 && busy(e) && h2(e, 9.9) > 0.3) e++;
              const xs = xOf(b), xe = xOf(e);
              const hex = new Path2D();
              hex.moveTo(xs, mid);
              hex.lineTo(xs + slew, hi);
              hex.lineTo(xe - slew, hi);
              hex.lineTo(xe, mid);
              hex.lineTo(xe - slew, lo);
              hex.lineTo(xs + slew, lo);
              hex.closePath();
              p.addPath(hex);
              fill.addPath(hex);
              b = e;
            }
            ctx.fillStyle = "rgba(157,182,255,0.10)";
            ctx.fill(fill);
            ctx.strokeStyle = "rgba(200,210,226,0.72)";
            ctx.lineWidth = 1.3;
            ctx.stroke(p);
          } else {
            const p = new Path2D(), fill = new Path2D();
            let lv = ch.level(b0);
            p.moveTo(xOf(b0), lv ? hi : lo);
            let start = lv ? xOf(b0) : 0;
            const step = ch.kind === "clock" ? 0.5 : 1;
            for (let b = b0 + step; b <= b1; b += step) {
              const nv = ch.kind === "clock" ? Math.floor(b * 2) & 1 : ch.level(b);
              if (nv === lv) continue;
              const x = xOf(b);
              p.lineTo(x - slew / 2, lv ? hi : lo);
              p.lineTo(x + slew / 2, nv ? hi : lo);
              if (lv) fill.rect(start, hi, x - start, lo - hi);
              else start = x;
              lv = nv;
            }
            p.lineTo(nowX, lv ? hi : lo);
            if (lv) fill.rect(start, hi, nowX - start, lo - hi);
            if (ch.kind !== "clock") {
              ctx.fillStyle = "rgba(157,182,255,0.06)";
              ctx.fill(fill);
            }
            ctx.strokeStyle = ch.kind === "clock" ? "rgba(200,210,226,0.42)" : "rgba(200,210,226,0.78)";
            ctx.lineWidth = 1.3;
            ctx.stroke(p);
          }
          ctx.restore();
        });

        // the cursor at now, down through the price
        const py0 = H - priceH - H * 0.03;
        ctx.strokeStyle = "rgba(157,182,255,0.45)";
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(Math.round(nowX) + 0.5, top);
        ctx.lineTo(Math.round(nowX) + 0.5, py0 + priceH);
        ctx.stroke();
        ctx.setLineDash([]);

        // the price channel: the real line, its area, the dot at now, the last price
        const { vals: v, label, price } = info.current;
        if (v.length >= 2) {
          const lo = Math.min(...v), hi = Math.max(...v), span = Math.max(hi - lo, v[v.length - 1] * 0.02);
          const { d, pts } = smoothPath(v, nowX, priceH, { t: priceH * 0.34, b: priceH * 0.2, l: 0, r: 0 }, [lo - span * 0.3, hi + span * 0.3]);
          ctx.save();
          ctx.translate(0, py0);
          const path = new Path2D(d);
          const area = new Path2D(`${d} L${nowX},${priceH} L0,${priceH} Z`);
          const g = ctx.createLinearGradient(0, 0, 0, priceH);
          g.addColorStop(0, "rgba(157,182,255,0.16)");
          g.addColorStop(1, "rgba(157,182,255,0)");
          ctx.fillStyle = g;
          ctx.fill(area);
          ctx.shadowColor = "rgba(157,182,255,0.6)";
          ctx.shadowBlur = 12;
          ctx.strokeStyle = "#a9c0ff";
          ctx.lineWidth = 2.2;
          ctx.stroke(path);
          ctx.shadowBlur = 0;
          const [ex, ey] = pts[pts.length - 1];
          const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
          ctx.fillStyle = `rgba(169,192,255,${(0.18 + 0.14 * pulse).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(ex, ey, 10 + 6 * pulse, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#e6ecff";
          ctx.beginPath();
          ctx.arc(ex, ey, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.textAlign = "right";
          ctx.textBaseline = "alphabetic";
          ctx.fillStyle = "#ffffff";
          ctx.font = `400 ${wide ? 40 : 30}px ${display}`;
          ctx.fillText(price, ex - 18, ey - 38);
          ctx.fillStyle = "#8f98ab";
          ctx.font = `400 15px ${body}`;
          ctx.fillText(label, ex - 18, ey - 16);
          ctx.restore();
        }
      },
    });
  }, [dataKey]);

  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav dark cta={s.sq} />
      <div className={s.body}>
        <canvas ref={cv} className={s.scope} role="img" aria-label="A GPU's signals on a logic analyzer, a clock, handshakes, data and a bus, scrolling past; under them, H100's price line ending at now" />
        <div className={s.shade} aria-hidden />
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
          <Cta className={s.sq} />
        </div>
      </div>
    </section>
  );
}
