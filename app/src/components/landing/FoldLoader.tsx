"use client";
// The landing's loading screen:
// while the page loads, a flat sheet the shape of a chip, creased, folds into the Agate A in the page's ink (the logo's
// own geometry, brand/fold.ts) and holds; once the fonts and the page are in, the screen fades off and the hero's film
// plays from its first cell, as before. Any scroll, click or key hurries it. Render checks (?still=1) and reduced
// motion never see it, except a check that asks for one moment of the fold (?still=1&fold=0..1).
import { useEffect, useRef, useState } from "react";
import { FOLD_GAP, fold, pointsOf } from "@/components/brand/fold";
import { stillMode } from "@/components/lab/data";
import s from "./loader.module.css";

// its clock (seconds): the fold, the least it holds the A once the page is ready, the fade off, and the longest it
// waits for the page after the fold; the creases' gap (half of it, on the fold's 100 box)
const FOLD_IN = 1.6, HOLD = 0.35, WAIT_MAX = 6, GAP = FOLD_GAP;
export const LOADER_LEAVE = 0.5;
const FLAT = fold(0, 0);

// when the screen began to lift (performance.now()), 0 while it is up: the hero's film waits on it; and whether one is
// up at all (the film's own fallback never starts it under a screen that is still showing)
let leftAt = 0, up = false;
export const loaderLeftAt = () => leftAt;
export const loaderUp = () => up;

export function FoldLoader({ tone }: { tone: "light" | "dark" }) {
  const [state, setState] = useState<"up" | "leaving" | "gone">("up");
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => {
    leftAt = 0;
    const polys = svg.current ? Array.from(svg.current.querySelectorAll("polygon")) : [];
    const paint = (t: number) =>
      fold(t).forEach((f, i) => {
        const p = polys[i];
        if (p) p.setAttribute("points", f.alpha > 0 ? pointsOf(f, GAP) : "");
      });
    const q = new URLSearchParams(window.location.search).get("fold");
    if (stillMode()) {
      if (q !== null) paint(Math.min(1, Math.max(0, Number(q) || 0)));
      else {
        leftAt = performance.now();
        setState("gone");
      }
      return;
    }
    up = true;
    let fontsIn = false, loaded = document.readyState === "complete";
    document.fonts.ready.then(() => (fontsIn = true));
    const onLoad = () => (loaded = true);
    window.addEventListener("load", onLoad);
    let e = 0, last = performance.now(), speed = 1, folded = false, raf = 0, timer = 0;
    const hurry = () => (speed = 5);
    const evs = ["wheel", "keydown", "touchstart", "pointerdown"] as const;
    evs.forEach((n) => window.addEventListener(n, hurry, { passive: true }));
    const tick = (now: number) => {
      e += Math.min(0.05, (now - last) / 1000) * speed;
      last = now;
      if (!folded) {
        paint(Math.min(1, e / FOLD_IN));
        if (e >= FOLD_IN) [folded, e] = [true, 0];
      } else if ((fontsIn && loaded && e >= HOLD) || e >= WAIT_MAX) {
        [leftAt, up] = [now, false];
        setState("leaving");
        timer = window.setTimeout(() => setState("gone"), LOADER_LEAVE * 1000 + 50);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      window.removeEventListener("load", onLoad);
      evs.forEach((n) => window.removeEventListener(n, hurry));
      // (a remount, or the Opening row switched off: the film must never wait on a screen that is gone)
      if (!leftAt) leftAt = performance.now();
      up = false;
    };
  }, []);

  if (state === "gone") return null;
  return (
    <div className={s.loader} data-tone={tone} data-state={state} role="status" aria-label="Loading Agate">
      <svg ref={svg} className={s.mark} viewBox="0 0 100 100" aria-hidden>
        {FLAT.map((f) => (
          <polygon key={f.id} points={pointsOf(f, GAP)} />
        ))}
      </svg>
    </div>
  );
}
