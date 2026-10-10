"use client";
// "Five clouds in, one price out" (asset lab, round 2): what Agate does, drawn from today's real reads. Each cloud that
// priced the GPU today is a stream of light starting at its own price; the streams meet at the index, the middle of
// them, and one stream runs on into the number. Pick another GPU and the streams re-form from its own clouds.
// After Public's prediction-market lines, Stripe's transaction fan and Computable's "collect, one number".
import { useEffect, useMemo, useRef, useState } from "react";
import { usd } from "@/lib/format";
import type { Gpu } from "@/lib/mock/types";
import { LAB_GPUS, token, type LabGpu, stillMode } from "./data";
import s from "./lab.module.css";

interface Lane {
  name: string;
  price: number;
  y: number;
  mid: boolean;
}

/** Label positions: by price, then pushed apart so close prices never overlap. */
function lanes(g: LabGpu, top: number, bottom: number, gap: number): Lane[] {
  const c = [...g.clouds].sort((a, b) => b.price - a.price);
  if (!c.length) return [];
  const hi = c[0].price, lo = c[c.length - 1].price;
  const span = hi - lo || 1;
  const ys = c.map((x) => top + ((hi - x.price) / span) * (bottom - top));
  for (let pass = 0; pass < 40; pass++) {
    for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] < gap) { const m = (ys[i] + ys[i - 1]) / 2; ys[i - 1] = m - gap / 2; ys[i] = m + gap / 2; }
    const lift = Math.max(0, top - ys[0]), drop = Math.max(0, ys[ys.length - 1] - bottom);
    for (let i = 0; i < ys.length; i++) ys[i] += lift - drop;
  }
  let midIdx = c.findIndex((x) => Math.abs(x.price - g.price) < 0.005);
  if (midIdx < 0) midIdx = Math.floor(c.length / 2);
  return c.map((x, i) => ({ name: x.name, price: x.price, y: ys[i], mid: i === midIdx }));
}

const bez = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

export function CloudsToOne({ data, dark, compact = false }: { data: LabGpu[]; dark: boolean; compact?: boolean }) {
  const [gpu, setGpu] = useState<Gpu>("H100");
  const g = data.find((x) => x.gpu === gpu) ?? data[0];
  const stage = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = box.w < 760;
  const labelW = narrow ? 156 : Math.min(240, box.w * 0.2);
  const xEnd = narrow ? box.w - 18 : box.w * 0.58;
  const ls = useMemo(() => (box.h ? lanes(g, 40, box.h - 40, narrow ? 30 : 52) : []), [g, box.h, narrow]);
  const midY = ls.find((l) => l.mid)?.y ?? box.h / 2;

  useEffect(() => {
    const c = cv.current, el = stage.current;
    if (!c || !el || !box.w || !ls.length) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(box.w * dpr);
    c.height = Math.round(box.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = token(el, "--ink", dark ? "#f2f0ea" : "#17171a");
    const accent = token(el, "--lab-accent", dark ? "#9ab5f4" : "#4f55c7");
    const x0 = labelW + 14;
    const xm = narrow ? box.w * 0.72 : box.w * 0.46;
    const ym = midY;
    // the particles: per lane a cloud of points riding its curve, then all riding one stream into the number
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const per = narrow ? 46 : 80;
    const parts = ls.flatMap((l, li) => Array.from({ length: per }, () => ({ li, ph: rnd(), sp: 0.055 + rnd() * 0.035, j: rnd() * 2 - 1, r: 0.8 + rnd() * 1.1 })));
    const still = stillMode();
    const t0 = performance.now();
    let raf = 0, visible = true;
    const lanePt = (l: Lane, t: number) => ({
      x: bez(x0, x0 + (xm - x0) * 0.55, xm - (xm - x0) * 0.3, xm, t),
      y: bez(l.y, l.y, ym, ym, t),
    });
    const draw = () => {
      const time = still ? 6 : (performance.now() - t0) / 1000;
      ctx.clearRect(0, 0, box.w, box.h);
      // the lanes, faint
      for (const l of ls) {
        ctx.beginPath();
        ctx.moveTo(x0, l.y);
        ctx.bezierCurveTo(x0 + (xm - x0) * 0.55, l.y, xm - (xm - x0) * 0.3, ym, xm, ym);
        ctx.strokeStyle = l.mid ? accent : ink;
        ctx.globalAlpha = l.mid ? 0.42 : dark ? 0.16 : 0.12;
        ctx.lineWidth = l.mid ? 1.4 : 1;
        ctx.stroke();
      }
      // the one stream out
      const og = ctx.createLinearGradient(xm, 0, xEnd, 0);
      og.addColorStop(0, accent);
      og.addColorStop(1, accent);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = og;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xm, ym);
      ctx.lineTo(xEnd, ym);
      ctx.stroke();
      // points
      for (const p of parts) {
        const l = ls[p.li];
        const u = (p.ph + time * p.sp) % 1.3;
        let x: number, y: number, a: number, r = p.r;
        if (u < 1) {
          const q = lanePt(l, u);
          const spread = (1 - u) * (1 - u) * 7;
          x = q.x;
          y = q.y + p.j * spread;
          a = Math.min(1, u / 0.08) * (l.mid ? 0.95 : dark ? 0.7 : 0.55);
          ctx.fillStyle = l.mid ? accent : ink;
        } else {
          const v = (u - 1) / 0.3;
          x = xm + v * (xEnd - xm);
          y = ym + p.j * 1.6;
          a = (1 - v * 0.6) * 0.95;
          r = p.r * 1.15;
          ctx.fillStyle = accent;
        }
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // where they meet: a soft pulse
      const pulse = still ? 0.6 : 0.5 + 0.5 * Math.sin(time * 2.2);
      const rg = ctx.createRadialGradient(xm, ym, 0, xm, ym, 26 + 8 * pulse);
      rg.addColorStop(0, accent);
      rg.addColorStop(1, "transparent");
      ctx.globalAlpha = dark ? 0.55 : 0.32;
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(xm, ym, 34 + 8 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(xm, ym, 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (!still && visible) raf = requestAnimationFrame(draw);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      cancelAnimationFrame(raf);
      if (visible) raf = requestAnimationFrame(draw);
    });
    io.observe(c);
    draw();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [ls, box, dark, labelW, narrow, xEnd, midY]);

  return (
    <div className={`${s.c2o} ${compact ? s.c2oCompact : ""}`}>
      {!compact && (
        <div className={s.pills} role="tablist" aria-label="GPU">
          {LAB_GPUS.map((x) => (
            <button key={x} role="tab" aria-selected={x === gpu} className={x === gpu ? s.pillOn : s.pill} onClick={() => setGpu(x)}>
              {x}
            </button>
          ))}
        </div>
      )}
      <div ref={stage} className={s.c2oStage}>
        <canvas ref={cv} className={s.fill} role="img" aria-label={`Today's ${g.gpu} prices from ${g.clouds.length} clouds meeting at Agate's index, ${usd(g.price)}`} />
        {ls.map((l) => (
          <div key={l.name} className={`${s.cloud} ${l.mid ? s.cloudMid : ""}`} style={{ top: l.y, width: labelW }}>
            <span>{l.name}</span>
            <b>{usd(l.price)}</b>
          </div>
        ))}
        {!narrow && (
          <div className={s.c2oNum} style={{ top: midY, left: xEnd + 18 }}>
            <span className={s.c2oBig}>{g.price ? usd(g.price) : "$0.00"}</span>
            <span className={s.c2oSub}>
              An hour of {g.gpu} today, {g.date}
            </span>
          </div>
        )}
      </div>
      {narrow && (
        <div className={s.c2oNumFlow}>
          <span className={s.c2oBig}>{g.price ? usd(g.price) : "$0.00"}</span>
          <span className={s.c2oSub}>
            An hour of {g.gpu} today, {g.date}
          </span>
        </div>
      )}
    </div>
  );
}
