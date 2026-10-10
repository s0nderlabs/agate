"use client";
// Landing round 3 kit (Oct 8 2026): the parts all four variants share. The motion vocabulary is the one from the
// larisamaarnold landing (one easing; headlines rise line by line through a mask, photos settle, ordered sets stagger,
// numbers count up once, the hero is covered like a curtain, wheel scrolling glides), applied by content type, never per
// section. Every number is live from the testnet; nothing is invented.
import Link from "next/link";
import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Lockup } from "@/components/brand/Logo";
import { stillMode } from "@/components/lab/data";
import { usd } from "@/lib/format";
import { useMock } from "@/lib/mock/store";
import { useHref, useR2, type R2 } from "../r2/parts";
import k from "./kit.module.css";

export { usd };
export type R3 = R2 & { sides: Side[] };

export interface Side {
  key: "pay" | "earn" | "trade" | "ai";
  q: string;
  a: string;
}

/** The live story numbers plus the four sides of the headline (who you are, what Agate does for you). */
export function useR3(): R3 {
  const r = useR2();
  const m = r.m;
  const sides: Side[] = [
    { key: "pay", q: "Paying for GPUs?", a: m ? `Lock in ${usd(m.long)} an hour.` : "Lock in what you pay." },
    { key: "earn", q: "Renting them out?", a: m ? `Lock in ${usd(m.short)} an hour.` : "Lock in what you earn." },
    { key: "trade", q: "Trading?", a: "Go long or short on compute." },
    { key: "ai", q: "Building with AI?", a: "Let it trade, within your limits." },
  ];
  return { ...r, sides };
}

export function useDark() {
  return useMock().config.theme === "dark";
}

/** The headline that changes for each kind of person. All sides share one grid cell, so nothing below it moves. */
export function Rotator({ sides, className = "", style, index, interval = 3800, qClass = "" }: { sides: Side[]; className?: string; style?: CSSProperties; index?: number; interval?: number; qClass?: string }) {
  const [i, setI] = useState(0);
  const [prev, setPrev] = useState<number | null>(null);
  const cur = index ?? i;
  const last = useRef(cur);
  useEffect(() => {
    if (index !== undefined || stillMode()) return;
    const t = window.setInterval(() => setI((x) => (x + 1) % sides.length), interval);
    return () => window.clearInterval(t);
  }, [index, interval, sides.length]);
  useEffect(() => {
    if (last.current !== cur) {
      setPrev(last.current);
      last.current = cur;
      const t = window.setTimeout(() => setPrev(null), 1100);
      return () => window.clearTimeout(t);
    }
  }, [cur]);
  return (
    <h1 className={`${k.rot} ${className}`} style={style}>
      {sides.map((s, n) => (
        <span key={s.key} className={k.rotSide} data-state={n === cur ? "on" : n === prev ? "out" : "off"} aria-hidden={n !== cur}>
          <span className={`${k.ln} ${k.rotQ} ${qClass}`}>
            <span className={k.li} style={{ "--l": 0 } as CSSProperties}>
              {s.q}
            </span>
          </span>
          <span className={k.ln}>
            <span className={k.li} style={{ "--l": 1 } as CSSProperties}>
              {s.a}
            </span>
          </span>
        </span>
      ))}
    </h1>
  );
}

/** A display heading that rises line by line through a mask when it scrolls in. Lines are measured from the real
 *  wrap (and re-measured on resize and once the fonts land), so the mask always follows what the reader sees. */
export function Head({ as = "h2", className = "", children, style }: { as?: "h1" | "h2" | "h3" | "p"; className?: string; children: string; style?: CSSProperties }) {
  const ref = useRef<HTMLElement>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  const words = children.split(/\s+/);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const spans = Array.from(el.querySelectorAll<HTMLElement>("[data-w]"));
    if (!spans.length) return;
    const out: string[][] = [];
    let top: number | null = null;
    for (const sp of spans) {
      if (top === null || Math.abs(sp.offsetTop - top) > 4) {
        out.push([]);
        top = sp.offsetTop;
      }
      out[out.length - 1].push(sp.textContent || "");
    }
    setLines(out.map((l) => l.join(" ")));
  }, []);
  useLayoutEffect(() => {
    if (lines === null) measure();
  }, [lines, measure]);
  useEffect(() => {
    let t = 0;
    const redo = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setLines(null), 120);
    };
    document.fonts?.ready.then(() => setLines(null));
    window.addEventListener("resize", redo);
    return () => {
      window.removeEventListener("resize", redo);
      window.clearTimeout(t);
    };
  }, []);
  const body =
    lines === null
      ? words.map((w, n) => (
          <span key={n} data-w>
            {w}
            {n < words.length - 1 ? " " : ""}
          </span>
        ))
      : lines.map((l, n) => (
          <span key={n} className={k.ln}>
            <span className={k.li} style={{ "--l": n } as CSSProperties}>
              {l}
            </span>
          </span>
        ));
  return createElement(as, { ref, className: `${className} ${k.rvType}`, "data-rv-type": "", style, "aria-label": children }, body);
}

/** The page's motion engine: reveals by content type, count-ups, parallax, the hero curtain, the sticky button and the
 *  wheel glide. Everything turns off for reduced motion and for still mode (render checks). */
export function useMotion(root: React.RefObject<HTMLElement | null>, opts: { smooth?: boolean } = {}) {
  const smooth = opts.smooth ?? true;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const still = stillMode();
    if (still) el.classList.add(k.still);
    el.querySelectorAll<HTMLElement>('[data-rv="set"]').forEach((c) => Array.from(c.children).forEach((ch, i) => (ch as HTMLElement).style.setProperty("--i", String(i))));
    const fmt = (n: number, f: string | undefined) => (f === "usd" ? usd(n) : Math.round(n).toLocaleString("en-US"));
    const count = (node: HTMLElement) => {
      const n = Number(node.dataset.n);
      if (!Number.isFinite(n) || node.dataset.done) return;
      node.dataset.done = "1";
      if (still) {
        node.textContent = fmt(n, node.dataset.fmt);
        return;
      }
      const t0 = performance.now();
      const D = 1000;
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / D);
        const e = 1 - Math.pow(1 - p, 3);
        node.textContent = fmt(n * e, node.dataset.fmt);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    const targets = el.querySelectorAll<HTMLElement>("[data-rv], [data-rv-type], [data-n]");
    const enter = (t: HTMLElement) => {
      if (t.dataset.n !== undefined) count(t);
      t.classList.add(k.in);
      t.setAttribute("data-in", "");
    };
    let io: IntersectionObserver | null = null;
    if (still) targets.forEach(enter);
    else {
      io = new IntersectionObserver(
        (es) => {
          for (const e of es) if (e.isIntersecting) {
            enter(e.target as HTMLElement);
            io?.unobserve(e.target);
          }
        },
        { threshold: 0.18 },
      );
      targets.forEach((t) => io!.observe(t));
    }
    // headings rendered later (line measuring) are caught by a light re-scan
    const mo = new MutationObserver(() => {
      el.querySelectorAll<HTMLElement>("[data-rv-type]:not(.in), [data-rv]:not(.in), [data-n]:not([data-done])").forEach((t) => (still ? enter(t) : io?.observe(t)));
    });
    mo.observe(el, { childList: true, subtree: true });

    // scroll-driven: curtain, parallax, sticky button
    const hero = el.querySelector<HTMLElement>("[data-curtain]");
    const pxs = Array.from(el.querySelectorAll<HTMLElement>("[data-px]"));
    const sticky = el.querySelector<HTMLElement>("[data-sticky]");
    const closeSec = el.querySelector<HTMLElement>("[data-close]");
    let queued = false;
    const tick = () => {
      queued = false;
      const vh = innerHeight;
      if (hero && !still) hero.style.setProperty("--cover", Math.max(0, Math.min(1, scrollY / (vh * 0.9))).toFixed(3));
      if (!still)
        for (const p of pxs) {
          const r = p.getBoundingClientRect();
          if (r.bottom < -200 || r.top > vh + 200) continue;
          const f = Math.max(-1, Math.min(1, (r.top + r.height / 2 - vh / 2) / (vh / 2 + r.height / 2)));
          p.style.setProperty("--py", `${(f * r.height * 0.07).toFixed(1)}px`);
        }
      if (sticky) {
        const past = scrollY > vh * 0.75;
        const atClose = closeSec ? closeSec.getBoundingClientRect().top < vh * 0.85 : false;
        sticky.classList.toggle(k.stickyOn, past && !atClose);
      }
    };
    const onScroll = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(tick);
      }
    };
    tick();
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);

    // wheel glide (desktop wheel only; touch keeps native momentum; never inside the judging dock)
    let target = scrollY, current = scrollY, raf = 0, lastT = 0;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const loop = (now: number) => {
      const dt = lastT ? Math.min(64, now - lastT) : 16.7;
      lastT = now;
      const kk = 1 - Math.pow(0.9, dt / 16.7);
      current += (target - current) * kk;
      if (Math.abs(target - current) < 0.5) {
        current = target;
        scrollTo(0, current);
        raf = 0;
        lastT = 0;
        return;
      }
      scrollTo(0, current);
      raf = requestAnimationFrame(loop);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || (e.target as HTMLElement)?.closest?.('[class*="MockDock"]')) return;
      e.preventDefault();
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 16;
      else if (e.deltaMode === 2) d *= innerHeight;
      if (!raf) target = scrollY;
      target = Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight, target + d));
      if (!raf) {
        current = scrollY;
        raf = requestAnimationFrame(loop);
      }
    };
    const onNative = () => {
      if (!raf) target = current = scrollY;
    };
    const glide = smooth && !still && !reduce;
    if (glide) {
      addEventListener("wheel", onWheel, { passive: false });
      addEventListener("scroll", onNative, { passive: true });
    }
    return () => {
      io?.disconnect();
      mo.disconnect();
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
      if (glide) {
        removeEventListener("wheel", onWheel);
        removeEventListener("scroll", onNative);
      }
      if (raf) cancelAnimationFrame(raf);
    };
  }, [root, smooth]);
}

/** A number that counts up once when it scrolls in (the final value is in the markup for no-JS and readers). */
export function Count({ n, fmt = "int", className = "" }: { n: number; fmt?: "int" | "usd"; className?: string }) {
  const text = fmt === "usd" ? usd(n) : Math.round(n).toLocaleString("en-US");
  return (
    <span className={`${k.num} ${className}`} data-n={n} data-fmt={fmt}>
      {text}
    </span>
  );
}

export function Photo({ src, alt, ratio = "16 / 9", px = false, className = "", style, children }: { src: string; alt: string; ratio?: string; px?: boolean; className?: string; style?: CSSProperties; children?: ReactNode }) {
  return (
    <div className={`${k.photo} ${px ? k.px : ""} ${className}`} style={{ aspectRatio: ratio, ...style }} data-px={px ? "" : undefined} data-rv="media">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading="lazy" />
      {children}
    </div>
  );
}

const HIDE = '[class*="__notice"],[class*="MockDock-module"]{display:none!important}';

/** The live app inside a frame, cropped to one region of a 1440 by 900 (or phone) screen and scaled to fit, optionally
 *  with a depth-of-field blur at the edges. Same-origin, so the judging dock and the testnet banner are hidden. */
export function AppFrame({ path = "/", query = "", crop, vw = 1440, vh = 900, dof = false, focus, className = "", style, title, theme }: { path?: string; query?: string; crop: { x: number; y: number; w: number; h: number }; vw?: number; vh?: number; dof?: boolean; focus?: [number, number]; className?: string; style?: CSSProperties; title: string; theme?: "light" | "dark" }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0);
  const mockDark = useDark();
  const dark = theme ? theme === "dark" : mockDark;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / crop.w));
    ro.observe(el);
    return () => ro.disconnect();
  }, [crop.w]);
  // the iframe mounts only once the box is measured, so the clean-up runs from its own load event
  const clean = useCallback(() => {
    try {
      const d = frame.current?.contentDocument;
      if (d?.head && !d.getElementById("r3hide")) {
        const st = d.createElement("style");
        st.id = "r3hide";
        st.textContent = HIDE;
        d.head.appendChild(st);
      }
    } catch {}
  }, []);
  const src = `${path}?agentcheck=1&chk=r3shot&logo=lace&source=live&theme=${dark ? "dark" : "light"}${query ? `&${query}` : ""}`;
  return (
    <div ref={box} className={`${k.appFrame} ${className}`} style={{ aspectRatio: `${crop.w} / ${crop.h}`, ...style }}>
      {scale > 0 && <iframe ref={frame} src={src} title={title} tabIndex={-1} aria-hidden onLoad={clean} style={{ width: vw, height: vh, transform: `scale(${scale}) translate(${-crop.x}px, ${-crop.y}px)` }} />}
      {dof && <span className={k.dof} style={{ "--fx": `${focus?.[0] ?? 50}%`, "--fy": `${focus?.[1] ?? 45}%` } as CSSProperties} />}
    </div>
  );
}

/** A phone running the live app. */
export function Phone({ width = 300, path = "/", query = "", className = "", style, theme }: { width?: number; path?: string; query?: string; className?: string; style?: CSSProperties; theme?: "light" | "dark" }) {
  return (
    <div className={`${k.phone} ${className}`} style={{ "--pw": `${width}px`, ...style } as CSSProperties}>
      <div className={k.phoneScreen}>
        <AppFrame path={path} query={`chk=r3phone${query ? `&${query}` : ""}`} vw={393} vh={852} crop={{ x: 0, y: 0, w: 393, h: 852 }} title="Agate on a phone, live" theme={theme} style={{ width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}

export function Go({ children = "Get started", kind = "ink", href = "/", className = "" }: { children?: ReactNode; kind?: "ink" | "line" | "paper" | "ghost"; href?: string; className?: string }) {
  const to = useHref();
  const cls = kind === "ink" ? k.btnInk : kind === "line" ? k.btnLine : kind === "paper" ? k.btnPaper : k.btnGhostLight;
  return (
    <Link href={to(href)} className={`${k.btn} ${cls} ${className}`}>
      {children}
    </Link>
  );
}

export function Nav3({ onDark = false, className = "", style }: { onDark?: boolean; className?: string; style?: CSSProperties }) {
  const to = useHref();
  return (
    <header className={`${k.nav} ${onDark ? "tone-dark" : ""} ${className}`} style={{ color: onDark ? "#f4f3ee" : undefined, ...style }}>
      <Link href={to("/")} aria-label="Agate" style={{ color: "inherit" }}>
        <Lockup height={30} wcase="title" />
      </Link>
      <nav className={k.navLinks} aria-label="Agate">
        <Link href={to("/")}>Markets</Link>
        <Link href={to("/gpu-index")}>Index</Link>
        <Link href={to("/positions")}>Positions</Link>
      </nav>
      <Go kind={onDark ? "paper" : "ink"}>Get started</Go>
    </header>
  );
}

export function Sticky({ onDark = false }: { onDark?: boolean }) {
  const to = useHref();
  return (
    <Link href={to("/")} data-sticky className={`${k.btn} ${onDark ? k.btnPaper : k.btnInk} ${k.sticky}`}>
      Get started
    </Link>
  );
}

export function Foot3({ onDark = true }: { onDark?: boolean }) {
  const to = useHref();
  return (
    <footer className={`${k.foot} ${onDark ? `${k.ink} tone-dark` : ""}`}>
      <div className={k.wrap}>
        <div className={k.footRow}>
          <Lockup height={26} wcase="title" />
          <nav className={k.footLinks} aria-label="More">
            <Link href={to("/")}>Markets</Link>
            <Link href={to("/gpu-index")}>Index</Link>
            <Link href={to("/positions")}>Positions</Link>
            <Link href={to("/privacy")}>Privacy</Link>
          </nav>
        </div>
        <p className={k.footNote}>Agate runs on Monad testnet.</p>
      </div>
    </footer>
  );
}

export { k };
