"use client";
// Hero round (Oct 8 2026): the parts every hero
// style shares. The rule for every asset: one piece of the product, rebuilt big with real numbers, never a screenshot
// of the app. Everything here reads the same live (or example) market the app reads; nothing is invented.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Lockup } from "@/components/brand/Logo";
import { TestnetTag } from "@/components/brand/Testnet";
import { stillMode, useLabData, type LabGpu } from "@/components/lab/data";
import { useMarkets } from "@/lib/data/hooks";
import { usd } from "@/lib/format";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import k from "./kit.module.css";

export { usd, k };

export interface Side {
  key: "pay" | "earn" | "trade" | "ai";
  q: string;
  a: string;
}

/** The hero's numbers: H100 today, its next month's two prices, every GPU, H100's daily history, and the four sides
 *  of the headline (who you are, what Agate does for you). */
export function useHero() {
  const { ready, gpus } = useLabData();
  const { markets } = useMarkets();
  const h = gpus.find((g) => g.gpu === "H100")!;
  const m = h.month;
  const hist = useMemo(() => (markets?.find((x) => x.gpu === "H100")?.history ?? []).filter((d) => d.price > 0).map((d) => ({ date: d.date, price: d.price })), [markets]);
  const sides: Side[] = [
    { key: "pay", q: "Paying for GPUs?", a: m ? `Lock in ${usd(m.long)} an hour.` : "Lock in what you pay." },
    { key: "earn", q: "Renting them out?", a: m ? `Lock in ${usd(m.short)} an hour.` : "Lock in what you earn." },
    { key: "trade", q: "Trading?", a: "Go long or short on GPUs." },
    { key: "ai", q: "Building with AI?", a: "Let it trade, within limits." },
  ];
  const open = gpus.reduce((a, g) => a + (g.month?.open ?? 0), 0);
  return { ready, gpus, h, m, hist, sides, open, month: m?.name ?? "next month" };
}
export type Hero = ReturnType<typeof useHero>;
export type { LabGpu };

export const CORE = "Agate makes the price of compute tradable.";

/** Which side the headline is on: turns every few seconds, holds still for a render check or reduced motion. */
export function useSide(count: number, interval = 4200) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (stillMode()) return;
    const t = window.setInterval(() => setI((x) => (x + 1) % count), interval);
    return () => window.clearInterval(t);
  }, [count, interval]);
  return i;
}

/** True once the page has painted, so entrances can run from their start state. */
export function useEntered(delay = 60) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (stillMode()) {
      setOn(true);
      return;
    }
    const t = window.setTimeout(() => setOn(true), delay);
    return () => window.clearTimeout(t);
  }, [delay]);
  return on;
}

/** The changing headline: the question and its answer rise through a mask; the one leaving rises out above. All sides
 *  share one grid cell, so nothing below moves. */
export function Rotator({ sides, index, className = "", qClass = "", aClass = "", style, as: Tag = "h1" }: { sides: Side[]; index: number; className?: string; qClass?: string; aClass?: string; style?: CSSProperties; as?: "h1" | "p" }) {
  const entered = useEntered(120);
  const [prev, setPrev] = useState<number | null>(null);
  const last = useRef(index);
  useEffect(() => {
    if (last.current === index) return;
    setPrev(last.current);
    last.current = index;
    const t = window.setTimeout(() => setPrev(null), 1000);
    return () => window.clearTimeout(t);
  }, [index]);
  const cur = sides[index];
  return (
    <Tag className={`${k.rot} ${className}`} style={style} aria-label={`${cur.q} ${cur.a}`}>
      {sides.map((s, n) => (
        <span key={s.key} className={k.side} data-state={n === index && entered ? "on" : n === prev ? "out" : "off"} aria-hidden>
          <span className={k.ln}>
            <span className={`${k.li} ${qClass}`} style={{ "--l": 0 } as CSSProperties}>
              {s.q}
            </span>
          </span>
          <span className={k.ln}>
            <span className={`${k.li} ${aClass}`} style={{ "--l": 1 } as CSSProperties}>
              {s.a}
            </span>
          </span>
        </span>
      ))}
    </Tag>
  );
}

/** The hero's headline (the Oct 8 calls: the claim itself, then shorter, "Making compute tradable"). */
export const CLAIM = "Making compute tradable.";

/** The line under the headline that follows a hero's loop: one step at a time, all in one grid cell so nothing moves. */
export function StepLine({ steps, index, className = "" }: { steps: string[]; index: number; className?: string }) {
  return (
    <p className={`${k.steps} ${className}`} aria-live="polite">
      {steps.map((t, i) => (
        <span key={i} data-on={i === index ? "" : undefined}>
          {t}
        </span>
      ))}
    </p>
  );
}

/** A price whose digits roll like a counter's drums, from zero on arrival and from the old value on every change. */
export function Roll({ text, className = "", drum = "", delay = 0 }: { text: string; className?: string; drum?: string; delay?: number }) {
  const entered = useEntered(delay);
  let d = 0;
  return (
    <span className={`${k.roll} ${className}`} aria-label={text}>
      {text.split("").map((ch, i) => {
        if (!/[0-9]/.test(ch)) {
          return (
            <span key={i} className={k.rollChar} aria-hidden>
              {ch}
            </span>
          );
        }
        const n = entered ? Number(ch) : 0;
        const at = d++;
        return (
          <span key={i} className={`${k.drum} ${drum}`} aria-hidden>
            <span className={k.strip} style={{ "--d": n, "--i": at } as CSSProperties}>
              {"0123456789".split("").map((x) => (
                <span key={x}>{x}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** A smooth path through the points in a w by h box with the given padding. Monotone cubic (Fritsch-Carlson): it
 *  never overshoots, so a price that steps and then holds draws as a clean step, not a wobble. */
export function smoothPath(values: number[], w: number, h: number, pad = { t: 8, b: 8, l: 0, r: 0 }, range?: [number, number]) {
  if (values.length < 2) return { d: "", pts: [] as [number, number][] };
  const lo = range?.[0] ?? Math.min(...values), hi = range?.[1] ?? Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i): [number, number] => [pad.l + (i / (values.length - 1)) * (w - pad.l - pad.r), pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b)]);
  const n = pts.length;
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i][0]);
  const sl = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / dx[i]);
  const m = pts.map((_, i) => (i === 0 ? sl[0] : i === n - 1 ? sl[n - 2] : sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (sl[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / sl[i], b = m[i + 1] / sl[i];
    const t = a * a + b * b;
    if (t > 9) {
      const k = 3 / Math.sqrt(t);
      m[i] = k * a * sl[i];
      m[i + 1] = k * b * sl[i];
    }
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const c = dx[i] / 3;
    d += ` C${(x0 + c).toFixed(1)},${(y0 + m[i] * c).toFixed(1)} ${(x1 - c).toFixed(1)},${(y1 - m[i + 1] * c).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return { d, pts };
}

export function useHref() {
  const q = useLinkQuery();
  // "/" is the site's home (the landing); the app lives under /app
  return (path: string) => `${path}${q}`;
}

/** The one button a hero has: start trading. */
export function Cta({ children = "Start trading", className = "", href = "/app" }: { children?: ReactNode; className?: string; href?: string }) {
  const to = useHref();
  return (
    <Link href={to(href)} className={`${k.cta} ${className}`}>
      {children}
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

/** The top bar, in the hero's own colours: the lockup, three links, the start button. */
/** The top bar. links "docs" (the chips heroes): Markets, Index and Docs, and a quiet "Open app",
 *  so the hero's own "Start trading" is the one solid button on the screen; "app" is the bar before. shape: split (the mark left, everything else right), center (the links
 *  on the page's centre line) or pill (the whole bar a floating capsule in the middle). */
export function Nav({ dark = false, className = "", cta = "", theme = false, links = "app", shape = "split", corners = "round", current }: { dark?: boolean; className?: string; cta?: string; theme?: boolean; links?: "app" | "docs"; shape?: "split" | "center" | "pill"; corners?: "round" | "square"; current?: "docs" }) {
  const to = useHref();
  const docs = links === "docs";
  return (
    <header className={`${k.nav} ${dark ? "tone-dark" : ""} ${className}`} data-shape={shape} data-corners={corners}>
      <div className={k.brandRow}>
        <Link href={to("/")} aria-label="Agate" className={k.brand}>
          <Lockup height={28} wcase="title" />
        </Link>
        <TestnetTag href={to("/docs/limits")} />
      </div>
      <nav className={k.links} aria-label="Agate">
        <Link href={to("/app")}>Markets</Link>
        <Link href={to("/app/gpu-index")}>Index</Link>
        {docs ? <Link href={to("/docs")} aria-current={current === "docs" ? "page" : undefined}>Docs</Link> : <Link href={to("/app/positions")}>Positions</Link>}
      </nav>
      <div className={k.end}>
        {theme && <ThemeSwitch />}
        <Link href={to("/app")} className={`${docs ? k.navGhost : k.navCta} ${cta}`}>
          {docs ? "Open app" : "Start trading"}
        </Link>
      </div>
    </header>
  );
}

/** The app's own light and dark switch (the same choice the app's top bar makes, kept across pages), for a hero that
 *  follows the theme (a choice only in Mock controls cannot be found). */
function ThemeSwitch() {
  const { config, setConfig } = useMock();
  const dark = config.theme === "dark";
  return (
    <button type="button" className={k.theme} aria-label={dark ? "Switch to light" : "Switch to dark"} onClick={() => setConfig({ theme: dark ? "light" : "dark" })}>
      {dark ? (
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
          <circle cx="10" cy="10" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 2v2.2M10 15.8V18M2 10h2.2M15.8 10H18M4.3 4.3l1.6 1.6M14.1 14.1l1.6 1.6M4.3 15.7l1.6-1.6M14.1 5.9l1.6-1.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
          <path d="M16.5 12.2A6.8 6.8 0 0 1 7.8 3.5a6.8 6.8 0 1 0 8.7 8.7z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="miter" />
        </svg>
      )}
    </button>
  );
}

/** "+$0.04" or "-$0.03" (a true minus), or "No change", for a move since the day before. */
export function moveText(change: number) {
  const c = Math.round(change * 100) / 100;
  return c > 0 ? `+${usd(c)}` : c < 0 ? `−${usd(Math.abs(c))}` : "No change";
}

export function useStill() {
  const [still, setStill] = useState(false);
  useEffect(() => setStill(stillMode()), []);
  return still;
}
