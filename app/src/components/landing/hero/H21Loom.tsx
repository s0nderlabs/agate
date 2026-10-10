"use client";
// Direction 3, new variant (Oct 8): "The loom". A matrix multiply is rows times columns, and so is weaving: the warp
// runs one way, the weft crosses it, and which thread lies on top at each crossing makes the pattern (the Jacquard loom
// read that pattern from punched cards, which is where computing's punched cards came from). Here the cloth is woven
// from H100's real price: each weft pick is one step of time, the price itself is a gold thread, the cloth under it is
// weft-faced (cream), above it warp-faced (indigo), in opposite twills, so the chart shows the way a damask's pattern
// does. At the right the newest pick is being woven; past it only the bare warp runs on to the edge: the future, not
// yet woven. A soft light passes over the cloth.
import { useEffect, useRef } from "react";
import { stillMode } from "@/components/lab/data";
import { frontMonth } from "@/lib/data/derive";
import { useCandles, useMarkets, useNow } from "@/lib/data/hooks";
import { runCanvas } from "./gl";
import { CLAIM, Cta, Nav, k, useHero, useStill, usd } from "./kit";
import s from "./h21.module.css";

const SUB = ["Lock in what you pay for GPUs.", "Lock in what you earn from them.", "Or trade where the price goes."];
const WARP = ["#1f2b50", "#4a5f9e"], WEFT = ["#cdc3ab", "#f7f2e7"], GOLD = ["#9c7024", "#efc874"];

/** One thread's segment as a small shaded sprite: a bar across the cell, darker at its edges. */
function sprite(px: number, vertical: boolean, [edge, mid]: string[]) {
  const c = document.createElement("canvas");
  c.width = c.height = Math.max(2, Math.round(px));
  const g = c.getContext("2d")!;
  const t = px * 0.86, o = (px - t) / 2;
  const gr = vertical ? g.createLinearGradient(o, 0, o + t, 0) : g.createLinearGradient(0, o, 0, o + t);
  gr.addColorStop(0, edge);
  gr.addColorStop(0.5, mid);
  gr.addColorStop(1, edge);
  g.fillStyle = gr;
  if (vertical) g.fillRect(o, 0, t, px);
  else g.fillRect(0, o, px, t);
  return c;
}

export function H21Loom() {
  const r = useHero();
  const { markets } = useMarkets();
  const now = useNow();
  const h100 = markets?.find((x) => x.gpu === "H100");
  const series = h100?.tradable ? frontMonth(h100, now) : undefined;
  const { candles } = useCandles(series);
  const traded = candles.filter((c) => c.c > 0);
  const vals = traded.length >= 12 ? traded.map((c) => c.c) : r.hist.slice(-90).map((d) => d.price);
  const valsRef = useRef<number[]>(vals);
  valsRef.current = vals;
  // the canvas starts once there is a price to weave (a still frame repaints when it changes)
  const still = useStill();
  const dataKey = vals.length >= 2 ? (still ? `${vals.length}:${vals[vals.length - 1]}` : "on") : "";
  const cv = useRef<HTMLCanvasElement>(null);
  const words = CLAIM.split(" ");
  const lines = [words.slice(0, -1).join(" "), words[words.length - 1]];

  useEffect(() => {
    const c = cv.current;
    if (!c || !dataKey) return;
    const cloth = document.createElement("canvas");
    let key = "", geo = { p: 6, rows: 0, cols: 0, fell: 0 };
    return runCanvas(c, {
      still: stillMode(),
      dprMax: 2,
      draw: (ctx, t0, W, H) => {
        const t = t0 < 0 ? 5 : t0;
        const v = valsRef.current;
        if (v.length < 2) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const k2 = `${W}x${H}:${dpr}:${v.length}:${v[0]}:${v[v.length - 1]}`;
        if (k2 !== key) {
          key = k2;
          const p = W > 900 ? 10 : 7;
          const rows = Math.floor(H / p), cols = Math.ceil(W / p), fell = Math.floor(cols * (W > 900 ? 0.82 : 0.76));
          geo = { p, rows, cols, fell };
          cloth.width = Math.round(fell * p * dpr);
          cloth.height = Math.round(rows * p * dpr);
          const g = cloth.getContext("2d")!;
          const sp = p * dpr;
          const warp = sprite(sp, false, WARP), weft = sprite(sp, true, WEFT), gold = sprite(sp, true, GOLD);
          g.fillStyle = "#141a2c";
          g.fillRect(0, 0, cloth.width, cloth.height);
          // the price, as a row for every pick: the line sits in the middle band of the cloth
          const lo = Math.min(...v), hi = Math.max(...v), span = Math.max(hi - lo, v[v.length - 1] * 0.03);
          const top = lo + span * 1.6, bot = lo - span * 0.9;
          for (let j = 0; j < fell; j++) {
            const u = (j / Math.max(1, fell - 1)) * (v.length - 1);
            const a = Math.floor(u), f = u - a;
            const val = v[a] + ((v[Math.min(v.length - 1, a + 1)] ?? v[a]) - v[a]) * f;
            const line = ((top - val) / (top - bot)) * rows;
            for (let i = 0; i < rows; i++) {
              const d = i - line;
              let img: HTMLCanvasElement;
              if (Math.abs(d) < 1) img = gold;
              else if (d > 0) img = (i + 3 * j) % 4 === 0 ? warp : weft;
              else img = (i + j) % 4 === 0 ? weft : warp;
              g.drawImage(img, j * sp, i * sp);
            }
          }
        }
        const { p, rows, fell } = geo;
        const fx = fell * p;
        ctx.drawImage(cloth, 0, 0, fx, rows * p);
        // the bare warp past the fell, under a little tension
        for (let i = 0; i < rows; i++) {
          const y = i * p + p / 2;
          ctx.strokeStyle = i % 2 ? "rgba(28,40,72,0.55)" : "rgba(28,40,72,0.42)";
          ctx.lineWidth = p * 0.42;
          ctx.beginPath();
          ctx.moveTo(fx, y);
          const wob = 0.5 * Math.sin(t * 1.3 + i * 0.7);
          ctx.quadraticCurveTo((fx + W) / 2, y + wob, W, y);
          ctx.stroke();
        }
        // the reed at the fell, and the shuttle laying the newest pick, bottom to top
        ctx.fillStyle = "rgba(243,238,226,0.9)";
        ctx.fillRect(fx, 0, 2, rows * p);
        const cyc = 2.8, ph = (t % cyc) / cyc;
        if (ph < 0.6) {
          const y = rows * p * (1 - ph / 0.6);
          const gr = ctx.createLinearGradient(0, y - 40, 0, y + 6);
          gr.addColorStop(0, "rgba(232,193,105,0)");
          gr.addColorStop(1, "rgba(232,193,105,0.95)");
          ctx.fillStyle = gr;
          ctx.fillRect(fx + 3, y - 40, p * 0.9, 46);
        }
        // light passing over the cloth
        const sx = ((t / 9) % 1) * (fx + 600) - 300;
        const sh = ctx.createLinearGradient(sx - 260, 0, sx + 260, 0);
        sh.addColorStop(0, "rgba(255,255,255,0)");
        sh.addColorStop(0.5, "rgba(255,255,255,0.16)");
        sh.addColorStop(1, "rgba(255,255,255,0)");
        ctx.save();
        ctx.globalCompositeOperation = "soft-light";
        ctx.fillStyle = sh;
        ctx.fillRect(0, 0, fx, rows * p);
        ctx.restore();
      },
    });
  }, [dataKey]);

  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav cta={s.sq} />
      <div className={s.body}>
        <h1 className={s.h1}>
          {lines.map((l) => (
            <span key={l}>{l} </span>
          ))}
        </h1>
        <div className={s.band}>
          <canvas ref={cv} className={s.cloth} role="img" aria-label="H100's price woven into cloth, one thread for each step of time; past the newest thread only bare warp, the future not yet woven" />
        </div>
        <div className={s.foot}>
          <p className={s.sub}>
            {SUB.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </p>
          <div className={s.price}>
            <span>H100, an hour today</span>
            <b>{r.h.price > 0 ? usd(r.h.price) : ""}</b>
          </div>
          <Cta className={`${s.sq} ${s.cta}`} />
        </div>
      </div>
    </section>
  );
}
