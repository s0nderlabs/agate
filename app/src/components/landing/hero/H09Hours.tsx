"use client";
// Hero 9, "Every GPU-hour" (SF Compute's GPU-hour grid, Modal's compute glyphs): the unit Agate trades, drawn as a field
// of small squares across a deep night blue. The lit squares are the GPU-hours people hold open on the next month right
// now, counted from the three markets, so the field grows as people trade. A slow light passes over them.
import { useEffect, useRef, useState } from "react";
import { stillMode } from "@/components/lab/data";
import { CLAIM, Cta, Nav, Rotator, k, useHero, useSide } from "./kit";
import s from "./h09.module.css";

const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

export function H09Hours() {
  const r = useHero();
  const i = useSide(r.sides.length);
  const cv = useRef<HTMLCanvasElement>(null);
  const open = Math.round(r.open);
  const [unitN, setUnitN] = useState(0);
  useEffect(() => {
    const c = cv.current;
    if (!c || !open) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const still = stillMode();
    let raf = 0;
    let cells: { x: number; y: number; o: number }[] = [];
    let lit = 0, pitch = 14, size = 9, W = 0, H = 0;
    const layout = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = c.clientWidth;
      H = c.clientHeight;
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pitch = W < 700 ? 11 : 14;
      size = W < 700 ? 7 : 9;
      const cols = Math.ceil(W / pitch), rows = Math.ceil(H / pitch);
      cells = [];
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          // grows from the lower right: nearer cells light first, with a little grain so the edge is never a straight line
          const dx = (cols - 1 - x) / cols, dy = (rows - 1 - y) / rows;
          const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
          cells.push({ x, y, o: Math.hypot(dx * 1.15, dy) + (n - Math.floor(n)) * 0.12 });
        }
      const order = [...cells].sort((a, b) => a.o - b.o);
      // a square stands for a round number of GPU-hours, so the lit share of the field stays readable
      const want = cells.length * 0.34;
      const unit = NICE.find((u) => open / u <= want) ?? 1000;
      setUnitN(unit);
      lit = Math.min(cells.length, Math.ceil(open / unit));
      cells = order;
    };
    const t0 = performance.now();
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const grow = still ? 1 : Math.min(1, t / 2.6);
      const eased = 1 - Math.pow(1 - grow, 3);
      const on = Math.round(lit * eased);
      ctx.clearRect(0, 0, W, H);
      // a soft diagonal band of light passes over the lit squares every few seconds
      const band = still ? -10 : ((t * 0.16) % 1.6) - 0.3;
      for (let n = 0; n < cells.length; n++) {
        const q = cells[n];
        const px = q.x * pitch, py = q.y * pitch;
        if (n < on) {
          const d = (px / W) * 0.7 + (py / H) * 0.3 - band;
          const glow = Math.max(0, 1 - Math.abs(d) * 7);
          ctx.fillStyle = `rgba(${201 + 40 * glow},${213 + 30 * glow},${234 + 21 * glow},${0.62 + 0.38 * glow})`;
        } else ctx.fillStyle = "rgba(201,213,234,0.075)";
        ctx.fillRect(px, py, size, size);
      }
      if (!still) raf = requestAnimationFrame(draw);
    };
    layout();
    // a still frame is drawn at once (a render check's tab runs no animation frames)
    if (still) draw(performance.now());
    else raf = requestAnimationFrame(draw);
    const ro = new ResizeObserver(() => {
      layout();
      if (still) draw(performance.now());
    });
    ro.observe(c);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [open]);
  return (
    <section className={`${k.hero} ${s.hero}`}>
      <canvas ref={cv} className={s.field} aria-hidden />
      <Nav dark />
      <div className={s.body}>
        <div className={s.copy}>
          <h1 className={s.h1}>{CLAIM}</h1>
          <Rotator as="p" sides={r.sides} index={i} className={s.sub} qClass={s.q} />
          <Cta />
        </div>
        <div className={s.stat}>
          <b>{open ? open.toLocaleString("en-US") : " "}</b>
          <span>
            GPU-hours held open on {r.month} right now. Each lit square is {unitN ? `${unitN.toLocaleString("en-US")} GPU-hour${unitN === 1 ? "" : "s"}` : "a few GPU-hours"}.
          </span>
        </div>
      </div>
    </section>
  );
}
