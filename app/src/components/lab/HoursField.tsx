"use client";
// "Every GPU-hour, counted" (asset lab, round 2): the GPU-hours open on the next month, read from the three markets
// right now, drawn as a field of small squares per market, each square a fixed number of GPU-hours. The squares light
// up when the field comes into view. After Modal's compute-unit glyphs and SF Compute's GPU-hour grid: the product's
// own unit as the image. It grows as people trade.
import { useEffect, useRef, useState } from "react";
import { stillMode, token, type LabGpu } from "./data";
import s from "./lab.module.css";

const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];

export function HoursField({ data, dark }: { data: LabGpu[]; dark: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(0);
  const blocks = data.filter((g) => g.month && g.month.open > 0).map((g) => ({ gpu: g.gpu, n: Math.round(g.month!.open) }));
  const total = blocks.reduce((a, b) => a + b.n, 0);
  const narrow = w < 700;
  const gap = narrow ? 0 : 32;
  const head = 34;
  const per = narrow ? 1 : Math.max(1, blocks.length);
  const bw = per ? (w - gap * (per - 1)) / per : w;
  const cell = narrow ? 9 : 11;
  const cols = Math.max(1, Math.floor(bw / cell));
  const maxRows = narrow ? 12 : 28;
  const need = Math.max(...blocks.map((b) => b.n), 1) / (cols * maxRows);
  const unit = NICE.find((u) => u >= need) ?? 1000;
  const sq = blocks.map((b) => Math.ceil(b.n / unit));
  const rowsOf = sq.map((n) => Math.ceil(n / cols));
  const blockH = (r: number) => head + r * cell;
  const h = narrow ? rowsOf.reduce((a, r) => a + blockH(r) + 20, 0) : blockH(Math.max(...rowsOf, 0));
  const month = data.find((g) => g.month)?.month?.name ?? "";
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = cv.current, el = wrap.current;
    if (!c || !el || !w || !blocks.length) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const accent = token(el, "--lab-accent", dark ? "#9ab5f4" : "#4f55c7");
    const ink = token(el, "--ink", dark ? "#f2f0ea" : "#17171a");
    const mute = token(el, "--ink-2", dark ? "#c9c6be" : "#4a4944");
    const font = getComputedStyle(el).fontFamily;
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // each square: where it sits, how bright it settles, when it lights
    const all: { x: number; y: number; a: number; at: number }[] = [];
    const heads: { x: number; y: number; gpu: string; n: number }[] = [];
    let oy = 0;
    blocks.forEach((b, bi) => {
      const ox = narrow ? 0 : bi * (bw + gap);
      const by = narrow ? oy : 0;
      heads.push({ x: ox, y: by, gpu: b.gpu, n: b.n });
      for (let i = 0; i < sq[bi]; i++) {
        const cx = i % cols, cy = Math.floor(i / cols);
        all.push({ x: ox + cx * cell, y: by + head + cy * cell, a: 0.5 + rnd() * 0.5, at: (cy / Math.max(1, rowsOf[bi])) * 0.5 + rnd() * 0.5 });
      }
      if (narrow) oy += blockH(rowsOf[bi]) + 20;
    });
    const still = stillMode();
    let raf = 0, start = 0;
    const draw = (now: number) => {
      const p = still ? 2 : start ? (now - start) / 1500 : 0;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.textBaseline = "top";
      for (const hd of heads) {
        ctx.font = `500 17px ${font}`;
        ctx.fillStyle = ink;
        ctx.fillText(hd.gpu, hd.x, hd.y + 2);
        const gw = ctx.measureText(hd.gpu).width;
        ctx.font = `400 17px ${font}`;
        ctx.fillStyle = mute;
        ctx.fillText(`${hd.n.toLocaleString("en-US")} GPU-hours`, hd.x + gw + 10, hd.y + 2);
      }
      ctx.fillStyle = accent;
      for (const q of all) {
        const v = Math.max(0, Math.min(1, (p - q.at) / 0.25));
        if (v <= 0) continue;
        ctx.globalAlpha = v * q.a * (dark ? 0.95 : 0.85);
        ctx.beginPath();
        ctx.roundRect(q.x, q.y, cell - 2, cell - 2, 2);
        ctx.fill();
      }
      if (!still && p < 1.3) raf = requestAnimationFrame(draw);
    };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !start) {
        start = performance.now();
        raf = requestAnimationFrame(draw);
      }
    }, { threshold: 0.2 });
    io.observe(c);
    draw(performance.now());
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h, dark, cell, cols, unit, narrow]);
  return (
    <div className={s.field}>
      <div className={s.fieldHead}>
        <span className={s.fieldBig}>{total.toLocaleString("en-US")}</span>
        <span className={s.fieldSub}>
          GPU-hours open on {month}. Every square is {unit === 1 ? "one GPU-hour" : `${unit} GPU-hours`}.
        </span>
      </div>
      <div ref={wrap} className={s.fieldWrap}>
        <canvas ref={cv} style={{ width: "100%", height: h, display: "block" }} role="img" aria-label={`${total} GPU-hours open on ${month}: ${blocks.map((b) => `${b.gpu} ${b.n}`).join(", ")}`} />
      </div>
    </div>
  );
}
