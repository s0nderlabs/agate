"use client";
// The landing mocks' shared kit (Oct 7 2026, judged in Mock controls): one frozen set of words, the live numbers, and
// the objects the pages stage (the agate slice, the price line, the app on a laptop and a phone). Every page says the
// same thing in its own reference's grammar, so only the design differs (larisamaarnold's COPY.md rule).
import Link from "next/link";
import { useEffect, useId, useMemo, type CSSProperties, type ReactNode } from "react";
import { Lockup, Stone } from "@/components/brand/Logo";
import { STONE_OUTER } from "@/components/brand/paths";
import { dateText, frontMonth, monthLong } from "@/lib/data/derive";
import { useMarkets, useNow } from "@/lib/data/hooks";
import { usd } from "@/lib/format";
import { LANDINGS, MOCK_CONTROLS } from "@/lib/mock/config";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import k from "./kit.module.css";

/** The words, frozen across every page. Facts checked Oct 7: five clouds for H100 (three for the price-only GPUs),
 *  read hourly, the middle sets the day; fully backed between a floor and a ceiling; pay me daily; email, Google or
 *  passkey sign-in; AI apps from their own pocket; live on Monad testnet since Oct 4; 10,000 test dollars a day. The
 *  "twice Bitcoin" line is our Sep 30 measurement (traded H100 price 75% a year, Bitcoin 38%, Jun 30 to Sep 29). */
export const COPY = {
  title: "The price of compute, made tradable.",
  titleLines: ["The price of compute,", "made tradable."],
  lead: "Agate is an open price for a GPU-hour, kept onchain. Go Long or Short on next month's price, fully backed, from your browser, your app or your AI.",
  cta: "Open the market",
  cta2: "See the index",
  facts: ["Fully backed", "Settles on an open index", "Free test dollars every day"],
  why: {
    title: "A GPU-hour has no price you can lock in.",
    text: "This summer the traded price of an H100 hour swung about twice as much as Bitcoin. Teams that rent compute can't fix next month's bill, and clouds can't sell next month ahead.",
  },
  how: [
    { t: "One open price a day", d: "Five clouds' on-demand prices, read every hour. The middle one sets the day's price, onchain." },
    { t: "A market for each month", d: "Go Long if you think November costs more, Short if less. It settles on November's average." },
    { t: "Fully backed", d: "Both sides pay in full up front, between a floor and a ceiling. Nobody gets liquidated." },
    { t: "Paid daily, if you like", d: "Pay me daily gives you the floor back now, then a share of each day as it lands." },
  ],
  doors: [
    { t: "Trade in your browser", d: "Sign in with email, Google or a passkey. No wallet to install." },
    { t: "Let your AI trade", d: "Connect Claude or another AI app. It trades from its own pocket, and asks you first." },
    { t: "Build on the data", d: "Every price, order book and trade is open for your app to read." },
    { t: "Read it onchain", d: "Any contract can read the day's price: lending, insurance, other markets." },
  ],
  proof: {
    title: "Live on Monad's test network since October 4.",
    text: "Every price, trade and payout is a Monad transaction anyone can check.",
  },
  close: { title: "Try it with 10,000 free test dollars a day.", text: "Sign in, pick a month, and see what the price of compute does next." },
  foot: "Agate runs on Monad's test network. Everything here uses test dollars, not real money.",
};

export const GPU_NAMES = ["H100", "H200", "B200", "B300", "A100", "L40S"] as const;

export type Live = {
  ready: boolean;
  date: string;
  price: number;
  change: number;
  month: string;
  long: number;
  short: number;
  last: number;
  floor: number;
  cap: number;
  history: number[];
  clouds: { name: string; price: number; mid: boolean }[];
  gpus: { g: string; price: number | null; tradable: boolean }[];
};

/** H100 today, its next month, its last 90 days and its clouds, plus every GPU's price, from the app's one read. */
export function useLive(): Live {
  const { markets } = useMarkets();
  const now = useNow();
  return useMemo(() => {
    const m = markets?.find((x) => x.gpu === "H100");
    const mo = m ? frontMonth(m, now) : undefined;
    const days = m ? [...(m.prelaunch ?? []), ...m.history].map((d) => d.price).filter((p) => p > 0) : [];
    const read = (m?.sources ?? []).filter((s) => s.live && s.price > 0).sort((a, b) => a.price - b.price);
    const mid = Math.floor(read.length / 2);
    return {
      ready: !!m && m.priceDate !== null,
      date: m?.priceDate ? dateText(m.priceDate) : "",
      price: m?.price ?? 0,
      change: m ? m.price - m.prevPrice : 0,
      month: mo ? monthLong(mo.month) : "November",
      long: mo?.quote?.ask ?? 0,
      short: mo?.quote?.bid ?? 0,
      last: mo?.quote?.last ?? 0,
      floor: mo?.floor ?? 0,
      cap: mo?.cap ?? 0,
      history: days.slice(-90),
      clouds: read.map((s, i) => ({ name: s.family, price: s.price, mid: i === mid })),
      gpus: GPU_NAMES.map((g) => {
        const x = markets?.find((y) => y.gpu === g);
        return { g, price: x && x.price > 0 ? x.price : null, tradable: !!x?.tradable };
      }),
    };
  }, [markets, now]);
}

/** A price, or a quiet placeholder while nothing is read (never a made-up number). */
export function P({ v, digits = 2 }: { v: number | null; digits?: number }) {
  return <span className={k.num}>{v ? usd(v, digits) : "$0.00"}</span>;
}

/** A GPU's price, or plain words when it has none yet (the price-only GPUs before their first day). */
export function GpuPrice({ v }: { v: number | null }) {
  return v ? <P v={v} /> : <span className={k.soon}>Price soon</span>;
}

export function Change({ v }: { v: number }) {
  if (Math.abs(v) < 0.005) return <span className={k.flat}>Unchanged today</span>;
  return <span className={v > 0 ? k.up : k.down}>{`${v > 0 ? "+" : "−"}${usd(Math.abs(v))} today`}</span>;
}

/** Links keep the mock state, so judging carries into the app. */
export function useLinks() {
  const q = useLinkQuery();
  return { market: `/${q}`, index: `/gpu-index${q}`, positions: `/positions${q}` };
}

/** Any app path with the mock state carried ("/" is the market). */
export function useLinkQueryHref() {
  const q = useLinkQuery();
  return (path: string) => (path === "/" ? `/${q}` : `${path}${q}`);
}

export function Cta({ className, children = COPY.cta, soft = false }: { className?: string; children?: ReactNode; soft?: boolean }) {
  const l = useLinks();
  return (
    <Link href={l.market} className={`ag-btn ${soft ? "ag-btn--soft" : "ag-btn--primary"} ag-btn--lg ${k.cta} ${className ?? ""}`}>
      {children}
    </Link>
  );
}

export function IndexLink({ className, children = COPY.cta2 }: { className?: string; children?: ReactNode }) {
  const l = useLinks();
  return (
    <Link href={l.index} className={`ag-btn ag-btn--ghost ag-btn--lg ${k.cta} ${className ?? ""}`}>
      {children}
    </Link>
  );
}

/** The landing's own bar: the lockup, two links, one button. `float` lays it over a full-bleed scene. */
export function LNav({ className, float = false }: { className?: string; float?: boolean }) {
  const l = useLinks();
  return (
    <header className={`${k.nav} ${float ? k.navFloat : ""} ${className ?? ""}`}>
      <Link href={l.market} className={k.brand} aria-label="Agate">
        <Lockup height={30} wcase="title" />
      </Link>
      <nav className={k.links} aria-label="Agate">
        <Link href={l.market}>Markets</Link>
        <Link href={l.index}>Index</Link>
        <Link href={l.positions}>Positions</Link>
      </nav>
      <Cta className={k.navCta}>{COPY.cta}</Cta>
    </header>
  );
}

export function Footer({ className }: { className?: string }) {
  const l = useLinks();
  return (
    <footer className={`${k.foot} ${className ?? ""}`}>
      <Lockup height={26} wcase="title" />
      <nav className={k.footLinks} aria-label="More">
        <Link href={l.market}>Markets</Link>
        <Link href={l.index}>Index</Link>
        <Link href={l.positions}>Positions</Link>
        <Link href="/privacy">Privacy</Link>
      </nav>
      <p>{COPY.foot}</p>
    </footer>
  );
}

/** One price a day draws as steps, the way the app's chart does. `band` adds the month's floor and ceiling. */
export function PriceLine({ values, className, band, area = true, dot = true, w = 640, h = 240 }: { values: number[]; className?: string; band?: { floor: number; cap: number }; area?: boolean; dot?: boolean; w?: number; h?: number }) {
  const vs = values.length > 1 ? values : [1, 1];
  const lo = Math.min(...vs, band?.floor ?? Infinity);
  const hi = Math.max(...vs, band?.cap ?? -Infinity);
  const pad = (hi - lo) * 0.12 || 0.5;
  const y = (v: number) => h - ((v - (lo - pad)) / (hi + pad - (lo - pad))) * h;
  const x = (i: number) => (i / (vs.length - 1)) * w;
  let d = `M0,${y(vs[0]).toFixed(1)}`;
  vs.forEach((v, i) => {
    if (i === 0) return;
    d += ` H${x(i).toFixed(1)} V${y(v).toFixed(1)}`;
  });
  const end = { x: w, y: y(vs[vs.length - 1]) };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={`${k.line} ${className ?? ""}`} aria-hidden="true" preserveAspectRatio="none">
      {band && (
        <>
          <line x1="0" x2={w} y1={y(band.cap)} y2={y(band.cap)} className={k.bandLine} />
          <line x1="0" x2={w} y1={y(band.floor)} y2={y(band.floor)} className={k.bandLine} />
        </>
      )}
      {area && <path d={`${d} V${h} H0 Z`} className={k.area} />}
      <path d={d} className={k.stroke} vectorEffect="non-scaling-stroke" />
      {dot && <circle cx={end.x} cy={end.y} r="5" className={k.dot} />}
    </svg>
  );
}

const SLICE_TONES = {
  day: { rind: "#2b2926", light: ["#efebe3", "#e3ded4", "#f6f3ee", "#d8d2c6", "#ece7de"], mid: ["#bab2a5", "#a59d90", "#c9c2b6"], line: ["#6d675e", "#4f4b45", "#857e72"], core: ["#fbf9f5", "#d9d4ca"] },
  night: { rind: "#0b0b0c", light: ["#2a2826", "#34322f", "#242321", "#3a3835", "#2e2c29"], mid: ["#55524c", "#4a4742", "#625e57"], line: ["#e2dbcf", "#c4bdb0", "#f1ebe1"], core: ["#8f897f", "#3a3733"] },
};
// band widths, as steps of scale: wide pale bands broken by fine lines, the way agate grows
const STEPS = [0.034, 0.011, 0.05, 0.009, 0.026, 0.058, 0.013, 0.04, 0.008, 0.03, 0.021, 0.066, 0.012, 0.044, 0.009, 0.034, 0.05, 0.013, 0.028, 0.055];
const RINGS = (() => {
  const out: { s: number; kind: "light" | "mid" | "line"; i: number }[] = [];
  let sc = 0.965;
  for (let i = 0; sc > 0.2; i++) {
    const st = STEPS[i % STEPS.length];
    out.push({ s: sc, kind: st < 0.016 ? "line" : i % 3 === 2 ? "mid" : "light", i });
    sc -= st;
  }
  return out;
})();

/** An agate slice in the logo's own outline: a dark rind, pale bands broken by fine lines, a crystalline core, and
 *  light through it when `lit`. Code-built and plain vector (no SVG filters: they cost seconds of paint), so it
 *  costs nothing and stays the brand's shape. */
export function AgateSlice({ className, tone = "day", lit = true, style }: { className?: string; tone?: "day" | "night"; lit?: boolean; style?: CSSProperties }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const t = SLICE_TONES[tone];
  const ring = (sc: number, dx: number, dy: number, fill: string, key: string | number) => (
    <g key={key} transform={`translate(${474 + dx} ${472 + dy}) scale(${sc}) translate(-474 -472)`}>
      <path d={STONE_OUTER} transform="translate(0,944) scale(0.1,-0.1)" fill={fill} />
    </g>
  );
  return (
    <svg viewBox="0 0 948 944" className={`${k.slice} ${className ?? ""}`} style={style} aria-hidden="true">
      <defs>
        <radialGradient id={`q${id}`} cx="0.48" cy="0.45" r="0.6">
          <stop offset="0" stopColor={t.core[0]} />
          <stop offset="1" stopColor={t.core[1]} />
        </radialGradient>
        <radialGradient id={`l${id}`} cx="0.5" cy="0.46" r="0.55">
          <stop offset="0" stopColor="#fff" stopOpacity={lit ? 0.7 : 0.2} />
          <stop offset="0.55" stopColor="#fff" stopOpacity={lit ? 0.16 : 0.04} />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`c${id}`}>
          <path d={STONE_OUTER} transform="translate(0,944) scale(0.1,-0.1)" />
        </clipPath>
      </defs>
      <g clipPath={`url(#c${id})`}>
        <rect width="948" height="944" fill={t.rind} />
        <g>
          {RINGS.map((r) => ring(r.s, Math.sin(r.i * 0.7) * 7, Math.cos(r.i * 0.5) * 5, t[r.kind][r.i % t[r.kind].length], r.i))}
          {ring(0.19, 3, -2, `url(#q${id})`, "core")}
        </g>
        <rect width="948" height="944" fill={`url(#l${id})`} style={{ mixBlendMode: "soft-light" }} />
      </g>
    </svg>
  );
}

export { Stone };

/** The market screen as a product shot: what Simple shows, at a size that still reads. */
export function MiniApp({ live, className }: { live: Live; className?: string }) {
  return (
    <div className={`${k.app} ${className ?? ""}`} aria-hidden="true">
      <div className={k.appBar}>
        <Lockup height={20} wcase="title" />
        <span className={k.appTabs}>
          <b>Markets</b>
          <span>Positions</span>
          <span>Index</span>
        </span>
      </div>
      <div className={k.appBody}>
        <div className={k.appMain}>
          <div className={k.appHead}>
            <div>
              <span className={k.appLabel}>H100 index</span>
              <span className={k.appBig}>
                <P v={live.price} />
              </span>
            </div>
            <div>
              <span className={k.appLabel}>{live.month} market</span>
              <span className={k.appBig}>
                <P v={live.last} />
              </span>
            </div>
          </div>
          <PriceLine values={live.history} className={k.appChart} />
        </div>
        <div className={k.appTicket}>
          <span className={k.appLabel}>{live.month} H100</span>
          <div className={k.appSides}>
            <span className={k.appLong}>
              Long <P v={live.long} />
            </span>
            <span className={k.appShort}>
              Short <P v={live.short} />
            </span>
          </div>
          <span className={k.appRow}>
            <span>Pay me daily</span>
            <span className={k.appCheck} />
          </span>
          <span className={k.appBtn}>Go Long</span>
        </div>
      </div>
    </div>
  );
}

/** The same market on a phone: price, line, the two sides. */
export function PhoneApp({ live, className }: { live: Live; className?: string }) {
  return (
    <div className={`${k.phone} ${className ?? ""}`} aria-hidden="true">
      <div className={k.phoneScreen}>
        <span className={k.phoneTime}>9:41</span>
        <span className={k.appLabel}>H100, {live.month}</span>
        <span className={k.phoneBig}>
          <P v={live.last || live.price} />
        </span>
        <Change v={live.change} />
        <PriceLine values={live.history.slice(-45)} className={k.phoneChart} area={false} />
        <div className={k.phoneSides}>
          <span className={k.appLong}>
            Long <P v={live.long} />
          </span>
          <span className={k.appShort}>
            Short <P v={live.short} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** The judged page's number keys: 1 to 0 pick a page, arrows step through them. Only with Mock controls (a hosted
 *  page never swaps its hero), and never over a key the page used itself (the AI tabs' arrows) or a field's. */
export function useLandingKeys() {
  const { config, setConfig } = useMock();
  useEffect(() => {
    if (!MOCK_CONTROLS) return;
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable || el.closest("[role=tablist]"))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = LANDINGS.findIndex(([key]) => key === config.landing);
      let next = -1;
      if (/^[0-9]$/.test(e.key)) next = e.key === "0" ? 9 : Number(e.key) - 1;
      else if (e.key === "ArrowRight") next = (i + 1) % LANDINGS.length;
      else if (e.key === "ArrowLeft") next = (i - 1 + LANDINGS.length) % LANDINGS.length;
      if (next < 0 || next >= LANDINGS.length) return;
      setConfig({ landing: LANDINGS[next][0] });
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [config.landing, setConfig]);
}
