"use client";
// The story below the chips hero (Oct 9).
// One pinned stage, one camera. The scroll moves it, nothing plays on its own:
//   1. the dive: the camera falls into the chip trading now on the hero's board, and lands on a real H100's die
//   2. the H100: the die pulls back to its whole package and tilts up into view (56 rendered frames, scrubbed);
//      "An hour of an H100", today's price
//   3. the clouds: the chip shrinks into one tile among the clouds that rent it, each with its own price; they rise and
//      fall to their prices, and a line settles in the middle: Agate's one open price (the median, written onchain)
//   4. the jump: the camera dives into one cloud's price, a billboard: Nebius's H100 went from $3.85 to $4.50 overnight
//   5. the sides: back out to the price line; above it Long, below it Short, a switch that flips as you scroll (pay,
//      earn, trade), and the most you can lose
//   6. every day: further out, the month, a chip a day, each day paying its share
//   7. your AI: into the month's last chip, which opens into an AI asking to go over its limit (docs, AI pockets: inside
//      its limits a pocket trades on its own; anything over the cap comes to you to approve)
//   8. the close: all the way out onto the board of chips again; one line, one button. Then the footer.
// Smooth: the camera follows the scroll with a short lag (native scrolling stays, keyboard and touch included); it
// draws only while it is catching up. Reduced motion: no zooms, the scenes cross-fade in place. A render check can stop
// the camera anywhere with ?still=1&at=<screens>. A screen reader reads the words in order; Tab to a link brings its
// scene on screen.
// Oct 10: with `site`, only the hero and the dive. The pin lets go once the H100 has pulled back to its package and
// the turn's words have come in beside it (or under it); then the stage scrolls up with the page like any section, and
// the market page follows in the page's own flow (Site.tsx).
import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Lockup } from "@/components/brand/Logo";
import { usd0 } from "@/lib/format";
import { useMock } from "@/lib/mock/store";
import { heroTile, heroView } from "../hero/H24Chips";
import { useHero, useHref, usd } from "../hero/kit";
import { FRAME_DIE, FRAME_H, FRAME_N, FRAME_W, Frames } from "./frames";
import s from "./story.module.css";

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
/** smootherstep: the camera's one curve, a slow start, a long settle */
const ease = (x: number) => x * x * x * (x * (6 * x - 15) + 10);
const out3 = (x: number) => 1 - (1 - x) ** 3;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const logLerp = (a: number, b: number, t: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);

type RGB = [number, number, number];
type Ground = "paper" | "night" | "studio" | "hero";
const GROUNDS: Record<"light" | "dark", Record<Ground, RGB>> = {
  light: { paper: [246, 245, 241], night: [18, 18, 20], studio: [11, 11, 12], hero: [246, 245, 241] },
  dark: { paper: [28, 28, 31], night: [16, 16, 18], studio: [10, 10, 11], hero: [20, 20, 19] },
};
const INK_ON_LIGHT: RGB = [23, 23, 26], INK_ON_DARK: RGB = [242, 240, 234];
/** where the ground changes, in screens of scroll: each change rides a camera move */
const GROUND_AT: [number, Ground][] = [
  [0.38, "hero"], [0.72, "studio"], [3.5, "studio"], [3.75, "paper"], [5.8, "paper"], [6.05, "night"], [7.4, "night"],
  [7.65, "paper"], [9.95, "paper"], [10.2, "night"], [11.55, "night"], [11.8, "paper"], [13.15, "paper"], [13.45, "hero"],
];
/** the story's length, in screens of scroll after the hero's own */
const END = 14.2;
/** the site's dive: how long it holds the screen (AirPods holds its cutaway 2.5 screens, MacBook Pro its chip 4) */
export const SITE_END = 2.75;
/** the site's ground: the hero, then the dark studio the H100 sits in, kept as the page goes on */
const GROUND_SITE: [number, Ground][] = [[0.38, "hero"], [0.72, "studio"]];

/** a cloud's H100 price, cheapest first, when the live read has not come in */
export const CLOUDS_THEN = [
  { name: "Civo", price: 2.99 },
  { name: "Verda", price: 3.79 },
  { name: "Lambda", price: 3.99 },
  { name: "Nebius", price: 4.5 },
  { name: "CoreWeave", price: 6.16 },
];
/** the jump (Nebius's own price page, read by the index): an H100 hour, the evening before and the morning after. A
 *  posted list price: flat, then one step */
/** Nebius's Oct 1 repricing, and where anyone can check it: the Internet Archive's copy of its price list that day, whose
 *  H100 row reads "On-demand $3.85" and "Effective October 1, 2026: $4.50" (checked Oct 10) */
export const JUMP = {
  cloud: "Nebius",
  from: 3.85,
  to: 4.5,
  before: "Sep 30",
  after: "Oct 1",
  proof: "https://web.archive.org/web/20261001030509/https://nebius.com/prices",
};
/** a Long's daily share when the month has not come in (docs, Pay me daily: (that day's price - the floor) / the
 *  month's days, on 100 GPU-hours: $6.80 at $3.99 with a $1.95 floor and 30 days) */
const DAILY = 6.8;
/** the AI in scene 7: its pocket's limits (docs, AI pockets: budget, cap per trade, trades a day, end date) */
export const POCKET = { budget: 1000, cap: 250, perDay: 3 };

const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const lum = (c: RGB) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const rgb = (c: RGB) => `${c[0] | 0} ${c[1] | 0} ${c[2] | 0}`;

function groundAt(t: number, tone: "light" | "dark", GROUND_AT: [number, Ground][]): RGB {
  const G = GROUNDS[tone];
  if (t <= GROUND_AT[0][0]) return G[GROUND_AT[0][1]];
  for (let i = 1; i < GROUND_AT.length; i++) {
    const [t1, g1] = GROUND_AT[i];
    if (t <= t1) {
      const [t0, g0] = GROUND_AT[i - 1];
      return mix(G[g0], G[g1], ease(seg(t, t0, t1)));
    }
  }
  return G[GROUND_AT[GROUND_AT.length - 1][1]];
}

/** A chip as the hero's board draws it, in one ink: the die, its core and its four graphics clusters. */
function Die({ className = "", style, refEl }: { className?: string; style?: React.CSSProperties; refEl?: (e: SVGSVGElement | null) => void }) {
  return (
    <svg ref={refEl} className={`${s.die} ${className}`} viewBox="0 0 100 127" style={style} aria-hidden>
      <rect className={s.body} x="1" y="1" width="98" height="125" rx="2.5" />
      <g className={s.core}>
        <rect x="8" y="9" width="84" height="109" rx="1" fill="none" />
        <path d="M29 9V60M50 9V60M71 9V60M29 67V118M50 67V118M71 67V118M8 60H92M8 67H92" />
      </g>
      <g className={`${s.core} ${s.off}`}>
        <rect x="8" y="9" width="84" height="109" rx="1" fill="none" />
        <path d="M29 9V60M50 9V60M71 9V60M29 67V118M50 67V118M71 67V118M8 60H92M8 67H92" />
      </g>
    </svg>
  );
}
const DIE_ASPECT = 100 / 127;

/** the board's chips as a mask (one ink, the board's own pitch) */
const FIELD_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 136 141"><rect x="18" y="7" width="100" height="127" rx="3" fill="none" stroke="black" stroke-width="2"/><rect x="26" y="16" width="84" height="109" rx="1" fill="none" stroke="black" stroke-width="1" stroke-opacity=".45"/></svg>',
)}")`;
const FIELD_ASPECT = 141 / 136;

type Data = {
  clouds: { name: string; price: number }[];
  index: number;
  jumpIx: number;
  tone: "light" | "dark";
  firstDow: number;
  month: string;
  days: number;
  daily: number;
};
type Rect = readonly [number, number, number, number];

export function Story({ hero, site = false, turnAt = "beside", turn }: { hero: ReactNode; site?: boolean; turnAt?: "beside" | "under"; turn?: ReactNode }) {
  const { config } = useMock();
  const tone = config.theme === "dark" ? "dark" : "light";
  const r = useHero();
  const to = useHref();
  const clouds = useMemo(() => {
    const live = (r.h.clouds ?? []).filter((c) => c.price > 0);
    return (live.length >= 3 ? live : CLOUDS_THEN).slice(0, 7);
  }, [r.h.clouds]);
  const index = r.h.price > 0 ? r.h.price : clouds[Math.floor(clouds.length / 2)].price;
  const month = r.m?.name ?? "November";
  const mon = month.slice(0, 3);
  const lockAt = r.m && r.m.long > 0 ? r.m.long : index;
  // the month's length and a Long's share of a day on 100 GPU-hours, from the month itself when it is in
  const days = r.m && r.m.days > 0 ? r.m.days : 30;
  const daily = r.m && r.m.floor > 0 && index > r.m.floor ? ((index - r.m.floor) / days) * 100 : DAILY;
  // the jump's cloud among the tiles (the dearest when it is not on the panel)
  const jumpAt = clouds.findIndex((c) => c.name.toLowerCase().includes(JUMP.cloud.toLowerCase()));
  const jumpIx = jumpAt >= 0 ? jumpAt : clouds.length - 1;
  // the month's days, laid out as a calendar (UTC)
  const firstDow = useMemo(() => {
    const ym = r.m?.month ?? "2026-11";
    const [y, m] = ym.split("-").map(Number);
    return new Date(Date.UTC(y, (m || 11) - 1, 1)).getUTCDay();
  }, [r.m?.month]);

  const track = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const heroL = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLCanvasElement>(null);
  const R = useRef<Record<string, HTMLElement | SVGElement | null>>({});
  const rf = (k: string) => (e: HTMLElement | SVGElement | null) => {
    R.current[k] = e;
  };
  // what the camera reads each frame; a change re-measures and redraws, the camera itself runs once
  const data = useRef<Data>({ clouds, index, jumpIx, tone, firstDow, month, days, daily });
  const onData = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    data.current = { clouds, index, jumpIx, tone, firstDow, month, days, daily };
    onData.current();
  }, [clouds, index, jumpIx, tone, firstDow, month, days, daily]);

  useEffect(() => {
    const tr = track.current, st = stage.current, hl = heroL.current, cv = chip.current;
    if (!tr || !st || !hl || !cv) return;
    const ctx = cv.getContext("2d");
    const E = R.current;
    const q = new URLSearchParams(window.location.search);
    const still = q.get("still") === "1";
    const rm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = st.clientWidth, H = st.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1), top = 0;
    let y = 0, ys = 0, raf = 0, last = -1, dirty = true, painted = false, alive = true;
    // the chip the dive falls into: followed until the hero has settled, then held for the whole dive
    let tile: Rect | null = null, tileReady = false;
    // what the frame needs from the layout, measured once per size, font or data change (never inside a frame)
    const M = { tagH: 46, tagNum: 34, Zj: 9, bbOff: 0, swW: 112, swH: 258, cw: 460, ch: 320, pw: 160, ph: 60, copyBot: 0, copyRight: 0, pitchB: 34, pitchF: 40 };
    const lineCache = new Map<HTMLElement, HTMLElement[]>();
    const shown = new WeakMap<object, string>();
    const said = new WeakMap<object, string>();
    let groundKey = "", hlKey = "", histKey = "", jHid: boolean | null = null;
    // (the hero's layer gets the will-change hint only on a dive that starts from the top: a hinted layer keeps the
    // raster scale it was made at, and one remade deep in the zoom, on the way back up from display:none, would keep a
    // scale too big to finish and show only scattered tiles, even back at rest)
    let hlFromTop = true;

    const narrowNow = () => W < 760 || W / H < 0.9;
    const gutPx = () => Math.min(112, Math.max(20, 0.065 * W));
    // the die where the dive lands: the first frame's die, as tall as the screen allows (also the widest a frame is drawn)
    const kLand = () => Math.min(H / FRAME_H, (0.9 * W) / FRAME_DIE[2]);

    const frames = new Frames(
      () => {
        // (a still check draws at once: a background tab runs no animation frames)
        if (still) render(ys);
        else if (ys > 0.15 && ys < 3.95) {
          dirty = true;
          kick();
        }
      },
      () => FRAME_W * kLand() * dpr,
    );
    // the files come in once the hero has had the page to itself, or as soon as the story starts
    const idle = typeof window.requestIdleCallback === "function";
    const idleId = idle ? window.requestIdleCallback(() => frames.load(), { timeout: 5000 }) : window.setTimeout(() => frames.load(), 3000);

    const show = (el: HTMLElement | SVGElement | null | undefined, o: number, tf = "", keep = false) => {
      if (!el) return;
      const key = `${o.toFixed(3)} ${tf}`;
      if (shown.get(el) === key) return;
      shown.set(el, key);
      const sty = (el as HTMLElement).style;
      sty.opacity = o.toFixed(3);
      // (words keep their place for a screen reader; only drawings leave the page when unseen)
      sty.visibility = !keep && o <= 0.001 ? "hidden" : "visible";
      sty.transform = tf;
    };
    const say = (el: HTMLElement | SVGElement | null | undefined, v: string) => {
      if (el && said.get(el) !== v) {
        said.set(el, v);
        el.textContent = v;
      }
    };
    // words in, then out: a rise and a fade, the lines a beat apart
    const copy = (el: HTMLElement | SVGElement | null | undefined, t: number, a: number, b: number, c: number, d: number) => {
      if (!el) return;
      const host = el as HTMLElement;
      const i = seg(t, a, b), o = seg(t, c, d), v = i * (1 - o);
      // (its own placement first: centred on the screen, or on its middle; a phone keeps every block up top)
      const place = host.dataset.at === "center" ? "translate(-50%, -50%) " : host.dataset.at === "mid" && !narrowNow() ? "translateY(-50%) " : host.dataset.at === "under" ? "translateX(-50%) " : "";
      show(host, v, `${place}translate3d(0, ${((1 - out3(i)) * 26 - out3(o) * 22).toFixed(2)}px, 0)`, true);
      const pe = v > 0.6 ? "auto" : "none";
      if (host.style.pointerEvents !== pe) host.style.pointerEvents = pe;
      if (v <= 0.001) return;
      let lines = lineCache.get(host);
      if (!lines) {
        lines = [...host.querySelectorAll<HTMLElement>("[data-l]")];
        lineCache.set(host, lines);
      }
      lines.forEach((ln, k) => {
        const li = seg(t, a + k * 0.045, b + k * 0.045);
        show(ln, 0.15 + 0.85 * li, `translate3d(0, ${((1 - out3(li)) * 14).toFixed(2)}px, 0)`, true);
      });
    };

    // the layout's own numbers: tag and billboard metrics, the switch, the card, Agate's label, the words above the
    // clouds (the dollar scale keeps clear of them)
    const sizes = () => {
      const D = data.current;
      const jTag = E[`l${D.jumpIx}`] as HTMLElement | null, jNum = jTag?.querySelector("b") ?? null;
      const big = E.nw as HTMLElement | null, bb = E.bb as HTMLElement | null;
      if (jTag) M.tagH = jTag.offsetHeight;
      if (jNum) M.tagNum = jNum.offsetTop + jNum.offsetHeight / 2;
      if (jNum && big) M.Zj = parseFloat(getComputedStyle(big).fontSize) / Math.max(1, parseFloat(getComputedStyle(jNum).fontSize));
      if (big && bb) M.bbOff = big.offsetTop + big.offsetHeight / 2 - bb.offsetHeight / 2;
      const sw = E.sw as HTMLElement | null, knob = E.knob as HTMLElement | null;
      if (sw) [M.swW, M.swH] = [sw.offsetWidth || 112, sw.offsetHeight || 258];
      if (knob) knob.style.top = `${(M.swH - (knob.offsetHeight || M.swW * 0.82)) / 2}px`;
      const cd = E.card as HTMLElement | null, p3 = E.p3 as HTMLElement | null;
      if (cd) [M.cw, M.ch] = [cd.offsetWidth || 460, cd.offsetHeight || 320];
      if (p3) [M.pw, M.ph] = [p3.offsetWidth || 160, p3.offsetHeight || 60];
      let bot = 0, right = 0;
      const sl = st.getBoundingClientRect().left;
      const rg = document.createRange();
      for (const k of ["c3a", "c3b"]) {
        const c = E[k] as HTMLElement | null;
        if (!c) continue;
        bot = Math.max(bot, c.offsetTop + c.offsetHeight);
        const tw = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          if (!n.textContent?.trim()) continue;
          rg.selectNodeContents(n);
          right = Math.max(right, rg.getBoundingClientRect().right - sl);
        }
      }
      [M.copyBot, M.copyRight] = [bot, right];
      lineCache.clear();
      jHid = null;
    };

    const measure = () => {
      W = st.clientWidth;
      H = st.clientHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      top = tr.getBoundingClientRect().top + window.scrollY;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      painted = false;
      tile = null;
      tileReady = false;
      // the boards: a still mask (painted once), moved by transform; the drifting one is a pitch taller than the screen
      const nar = narrowNow();
      M.pitchB = nar ? 34 : Math.max(30, Math.min(48, W / 34));
      M.pitchF = nar ? 40 : Math.max(34, Math.min(56, W / 30));
      const bf = E.bgf as HTMLElement | null, fl = E.field as HTMLElement | null;
      if (bf) {
        const sz = `${M.pitchB}px ${M.pitchB * FIELD_ASPECT}px`;
        bf.style.setProperty("mask-size", sz);
        bf.style.setProperty("-webkit-mask-size", sz);
        bf.style.height = `${Math.ceil(H + M.pitchB * FIELD_ASPECT) + 2}px`;
      }
      if (fl) {
        const sz = `${M.pitchF}px ${M.pitchF * FIELD_ASPECT}px`;
        fl.style.setProperty("mask-size", sz);
        fl.style.setProperty("-webkit-mask-size", sz);
      }
      sizes();
      dirty = true;
    };

    // the chip's film onto the canvas: frame f, centred at (cx, cy), at scale k (screen px per frame px), clipped; two
    // frames cross-fade exactly (the canvas holds only the chip), and the frame's edges fade into the ground
    const drawChip = (f: number, cx: number, cy: number, k: number, alpha: number, clip: Rect | null) => {
      if (!ctx || alpha <= 0.002) return;
      const fr = frames.at(f);
      if (!fr) return;
      const w = FRAME_W * k, h = FRAME_H * k, x = cx - w / 2, yy = cy - h / 2;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (clip) {
        ctx.beginPath();
        ctx.rect(clip[0], clip[1], clip[2], clip[3]);
        ctx.clip();
      }
      if (fr[1] && fr[2] > 0.01) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = alpha * (1 - fr[2]);
        ctx.drawImage(fr[0], x, yy, w, h);
        ctx.globalAlpha = alpha * fr[2];
        ctx.drawImage(fr[1], x, yy, w, h);
      } else {
        ctx.globalAlpha = alpha;
        ctx.drawImage(fr[0], x, yy, w, h);
      }
      // (the first frames are opaque to their edges: wide soft sides, thin top and bottom, clear of the die)
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 1;
      const fx = w * 0.16, fy = h * 0.045;
      const edge = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, "rgba(0,0,0,1)");
        g.addColorStop(0.45, "rgba(0,0,0,.4)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(rx, ry, rw, rh);
      };
      edge(x, 0, x + fx, 0, x, yy, fx, h);
      edge(x + w, 0, x + w - fx, 0, x + w - fx, yy, fx, h);
      edge(0, yy, 0, yy + fy, x, yy, w, fy);
      edge(0, yy + h, 0, yy + h - fy, x, yy + h - fy, w, fy);
      ctx.restore();
      painted = true;
    };

    const render = (t: number) => {
      const D = data.current;
      const narrow = narrowNow();
      const g = groundAt(t, D.tone, site ? GROUND_SITE : GROUND_AT);
      const light = lum(g) > 0.5;
      const ink = mix(INK_ON_DARK, INK_ON_LIGHT, clamp01((lum(g) - 0.3) / 0.4));
      const card: RGB = light ? [255, 255, 253] : mix(g, ink, 0.075);
      const gk = `${rgb(g)}|${rgb(ink)}|${rgb(card)}`;
      if (gk !== groundKey) {
        // (on the track, so the strip under a phone's collapsing toolbar is the same ground)
        groundKey = gk;
        tr.style.setProperty("--sg", rgb(g));
        tr.style.setProperty("--si", rgb(ink));
        tr.style.setProperty("--sc", rgb(card));
      }
      if (ctx && painted) {
        ctx.clearRect(0, 0, cv.width, cv.height);
        painted = false;
      }
      if (t > 0.05) frames.load();

      // ---------------------------------------------------------------- 1. the dive
      const p1 = seg(t, 0, 1), e1 = rm ? 0 : ease(p1);
      // (the hero's tape holds still while the camera is off the top)
      heroView.hold = p1 > 0;
      const k0 = kLand();
      const dieH = FRAME_DIE[3] * k0;
      if (p1 <= 0) [tile, tileReady] = [null, false];
      else if (!tile || !tileReady) {
        const ok = heroView.sc > 0 && heroView.k >= 0;
        tile = ok ? heroTile(heroView.k, heroView.r) : [W * 0.62, H * 0.42, 26, 33];
        tileReady = ok && heroView.ready;
      }
      const [tx, ty, tw, th] = tile ?? [W * 0.62, H * 0.42, 26, 33];
      const tcx = tx + tw / 2, tcy = ty + th / 2;
      const Sf = Math.max(1, dieH / Math.max(4, th));
      const sc1 = logLerp(1, Sf, e1);
      const ax = rm ? W / 2 : lerp(tcx, W / 2, e1), ay = rm ? H / 2 : lerp(tcy, H / 2, e1);
      const hk = p1 <= 0 ? "top" : p1 >= 1 ? "gone" : `${rm ? "" : `translate3d(${ax}px, ${ay}px, 0) scale(${sc1}) translate3d(${-tcx}px, ${-tcy}px, 0)`}|${(1 - seg(p1, rm ? 0.2 : 0.42, rm ? 0.7 : 0.8)).toFixed(3)}|${p1 > 0.4}`;
      if (hk !== hlKey) {
        hlKey = hk;
        if (hk === "top") hlFromTop = true;
        else if (hk === "gone") hlFromTop = false;
        const wc = hk !== "top" && hk !== "gone" && hlFromTop ? "transform, opacity" : "auto";
        if (hl.style.willChange !== wc) hl.style.willChange = wc;
        const [tf, op] = hk === "top" ? ["", "1"] : hk === "gone" ? ["", "0"] : hk.split("|");
        hl.style.transform = tf;
        hl.style.opacity = op;
        hl.style.display = hk === "gone" ? "none" : "";
        // (once the camera leaves the top, the hero takes no clicks; well into the dive, no focus either)
        hl.style.pointerEvents = hk === "top" ? "" : "none";
        hl.inert = hk === "gone" || (hk !== "top" && p1 > 0.4);
      }
      if (t < 1 && !rm) {
        // the real die over the hero's chip, the same camera; its mask opens onto the package as it lands
        const kd = (th * sc1) / FRAME_DIE[3];
        const dw = FRAME_DIE[2] * kd, dh = FRAME_DIE[3] * kd;
        const m = ease(seg(p1, 0.8, 1));
        const clip: Rect = [lerp(ax - dw / 2, 0, m), lerp(ay - dh / 2, 0, m), lerp(dw, W, m), lerp(dh, H, m)];
        drawChip(0, ax, ay, kd, seg(p1, 0.22, 0.5), m >= 1 ? null : clip);
      }

      // ---------------------------------------------------------------- 2. the H100
      const qv = seg(t, 1, site ? 2.3 : 2.8);
      const under = site && turnAt === "under";
      const kEnd = (narrow ? Math.min(H / FRAME_H, W / 1150) : Math.min(H / FRAME_H, W / FRAME_W) * 0.98) * (under ? (narrow ? 0.9 : 0.58) : 1);
      // (reduced motion: the chip rests where the words leave it room, at its last size, from the start)
      const kq = rm ? kEnd : lerp(k0, kEnd, ease(seg(qv, 0.04, 0.6)));
      const aside = rm ? 1 : site ? ease(seg(t, 2.1, 2.55)) : ease(seg(t, 2.45, 2.95));
      const drift = rm || site ? 0 : Math.max(0, t - 2.9) * H * 0.045;
      // (the site's turn: beside, the H100 steps right for the words, or down on a phone; under, it rises for them)
      const ccx = W / 2 + (narrow || under ? 0 : aside * W * 0.17);
      const ccy = H / 2 + (under ? -aside * H * (narrow ? 0.2 : 0.21) : narrow ? aside * H * (site ? 0.24 : 0.17) : 0) - drift;
      // (3. the chip shrinks into the middle cloud's tile)
      const n = D.clouds.length, mid = Math.floor(n / 2);
      const tH = narrow ? Math.min(H * 0.12, (W - 40) / n / DIE_ASPECT / 1.45) : Math.min(H * 0.27, (W * 0.66) / n / DIE_ASPECT / 1.4);
      const tW = tH * DIE_ASPECT, gap = tW * (narrow ? 0.42 : 0.5);
      const rowW = n * tW + (n - 1) * gap;
      const rowX = narrow ? (W - rowW) / 2 : W * 0.5 - rowW / 2 + W * 0.12;
      const rowY = narrow ? H * 0.6 : H * 0.55;
      const tileX = (i: number) => rowX + i * (tW + gap);
      const e3 = rm ? 0 : ease(seg(t, 3.2, 3.85));
      if (t >= (rm ? 0.6 : 1) && t < 3.9) {
        const kT = tH / (FRAME_H * 0.5);
        const k3 = logLerp(kq, kT, e3);
        const cx3 = lerp(ccx, tileX(mid) + tW / 2, e3), cy3 = lerp(ccy, rowY, e3);
        drawChip(qv * (FRAME_N - 1), cx3, cy3, k3, (rm ? seg(t, 0.6, 1) : 1) * (1 - seg(t, rm ? 3.3 : 3.5, 3.8)), null);
      }
      if (site) {
        // (the words stay: they leave with the stage, scrolled away by the page)
        copy(E.c2, t, 2.2, 2.6, 99, 100);
        return;
      }
      copy(E.c2, t, 2.5, 2.9, 3.15, 3.35);
      show(E.bar, seg(t, 0.85, 1.05));
      const bpe = t > 0.95 ? "auto" : "none";
      const barEl = E.bar as HTMLElement | null;
      if (barEl && barEl.style.pointerEvents !== bpe) barEl.style.pointerEvents = bpe;

      // ---------------------------------------------------------------- 3. the clouds, one open price
      const prices = D.clouds.map((c) => c.price);
      const lo = Math.min(...prices, D.index), hi = Math.max(...prices, D.index);
      const span = Math.max(0.5, hi - lo);
      const yTop = narrow ? H * 0.42 : H * 0.28, yBot = H * 0.8;
      const yOf = (v: number) => lerp(yBot, yTop, (v - (lo - span * 0.08)) / (span * 1.16));
      const climb = (i: number) => (rm ? seg(t, 4.4, 4.95) : ease(seg(t, 4.4 + i * 0.05, 4.95 + i * 0.05)));
      const lineIn = rm ? seg(t, 4.95, 5.35) : ease(seg(t, 4.95, 5.35));
      const tileCy = (i: number) => lerp(rowY, yOf(prices[i]), climb(i));
      // a price tag hangs away from Agate's line: above a tile priced over it (room allowing under the top bar), else below
      const above = prices.map((p) => p > D.index + 0.005 && yOf(p) - tH / 2 - M.tagH - 10 > 84);
      const tagY = (i: number) => (above[i] ? tileCy(i) - tH / 2 - M.tagH - 10 : tileCy(i) + tH / 2 + 12);
      // the camera on the clouds: out from the chip, then (4.) into the jump's price
      const g3 = E.g3 as HTMLElement | null;
      let gz = 1, gcx = 0, gcy = 0, gmx = 0, gmy = 0;
      if (t < 3.85) {
        const Zs = Math.max(1, (FRAME_H * 0.5 * kq) / tH);
        gz = rm ? 1 : logLerp(Zs, 1, e3);
        gmx = tileX(mid) + tW / 2;
        gmy = rowY;
        // (from the chip's own place, so the tile it shrinks into is under it the whole way)
        gcx = lerp(ccx, gmx, e3);
        gcy = lerp(ccy, gmy, e3);
      }
      const e4 = rm ? 0 : ease(seg(t, 5.6, 6.15));
      // (the jump's cloud's own price, and how much the camera must close in for it to be the billboard's number)
      const Zj = M.Zj;
      const jx = tileX(D.jumpIx) + tW / 2;
      const jy = tagY(D.jumpIx) + M.tagNum;
      if (t >= 5.6) {
        gz = rm ? 1 : logLerp(1, Zj, e4);
        gmx = jx;
        gmy = jy;
        gcx = lerp(jx, W / 2, e4);
        gcy = lerp(jy, H * 0.52, e4);
      }
      const g3o = seg(t, rm ? 3.4 : 3.45, 3.75) * (1 - seg(t, rm ? 5.6 : 6.04, rm ? 5.9 : 6.16));
      const jh = t > 6.03 && !rm;
      if (jh !== jHid) {
        jHid = jh;
        D.clouds.forEach((_, i) => {
          const b = (E[`l${i}`] as HTMLElement | null)?.querySelector("b");
          if (b) b.style.opacity = jh && i === D.jumpIx ? "0" : "";
        });
      }
      // (the cloud's name goes as the camera closes in on its price: the billboard says it again)
      show((E[`l${D.jumpIx}`] as HTMLElement | null)?.querySelector("span"), rm ? 1 : 1 - seg(t, 5.68, 5.92), "", true);
      if (g3) show(g3, g3o, gz === 1 ? "" : `translate3d(${gcx}px, ${gcy}px, 0) scale(${gz}) translate3d(${-gmx}px, ${-gmy}px, 0)`);
      if (g3o > 0) {
        for (let i = 0; i < n; i++) {
          const d = E[`t${i}`] as SVGSVGElement | null, tg = E[`l${i}`] as HTMLElement | null;
          const y0 = tileCy(i) - tH / 2;
          if (d) {
            d.style.width = `${tW}px`;
            d.style.height = `${tH}px`;
            d.style.transform = `translate3d(${tileX(i)}px, ${y0}px, 0)`;
            // the middle cloud's chip, the one Agate's price sits on, powers on with the line
            d.style.setProperty("--on", (i === mid ? lineIn * 0.92 : 0.06 * lineIn).toFixed(3));
          }
          if (tg) tg.style.transform = `translate3d(${tileX(i) + tW / 2}px, ${tagY(i)}px, 0) translateX(-50%)`;
        }
        const lineY = yOf(D.index);
        const lx0 = narrow ? 16 : rowX - tW * 0.8, lx1 = narrow ? W - 16 : W - W * 0.06;
        const rl = E.rule3 as HTMLElement | null;
        if (rl) {
          rl.style.width = `${lx1 - lx0}px`;
          show(rl, lineIn, `translate3d(${lx0}px, ${lineY}px, 0) scaleX(${lineIn})`);
        }
        // Agate's price at the line's left end, above it, where the cheaper clouds sit below; nudged up past any tile
        // that reaches over the line there (a phone has no room beside the line: it sits under the chart, centred)
        let pBot = lineY - 12;
        for (let i = 0; i < n; i++) if (tileX(i) < lx0 + M.pw && tileX(i) + tW > lx0) pBot = Math.min(pBot, tileCy(i) - tH / 2 - 10);
        show(E.p3, seg(t, 5.15, 5.4), narrow ? `translate3d(${(W - M.pw) / 2}px, ${yBot + 64}px, 0)` : `translate3d(${lx0}px, ${pBot - M.ph}px, 0)`);
        // the dollar scale behind them, kept clear of the words above
        [3, 4, 5, 6, 7].forEach((v, k) => {
          const ax2 = E[`ax${k}`] as HTMLElement | null, rr = E[`ar${k}`] as HTMLElement | null;
          const yv = yOf(v);
          const inRange = v >= lo - span * 0.05 && v <= hi + span * 0.05;
          const o = inRange ? seg(t, 4.45, 4.85) * 0.9 : 0;
          const under = yv < M.copyBot + 16;
          const axX = narrow ? 16 : rowX - tW * 0.8 - 44;
          // (a step whose label would sit in the words goes, rule and all)
          const ov = under && axX < M.copyRight + 16 ? 0 : o;
          if (ax2) show(ax2, ov, `translate3d(${axX}px, ${yv - 10}px, 0)`);
          if (rr) {
            const x0 = narrow ? 16 : rowX - tW * 0.8, x1 = narrow ? W - 16 : W - W * 0.06;
            rr.style.width = `${x1 - x0}px`;
            show(rr, ov, `translate3d(${x0}px, ${yv}px, 0)`);
          }
        });
      }
      copy(E.c3a, t, 3.75, 4.05, 4.85, 5.0);
      copy(E.c3b, t, 5.0, 5.25, 5.6, 5.8);

      // ---------------------------------------------------------------- 4. the jump
      const bb = E.bb as HTMLElement | null;
      const e5 = rm ? 0 : ease(seg(t, 7.2, 7.8));
      // (5. the price becomes the last point of its line)
      const hairY = H * 0.6;
      const P = { x: narrow ? W * 0.42 : W * 0.4, y: hairY };
      if (bb && t > 5.5 && t < 7.8) {
        const bbIn = rm ? seg(t, 5.7, 6.0) : t > 6.03 ? 1 : 0;
        // (the billboard is placed by its big number's centre: the number the camera closed in on)
        let bs = rm ? 1 : gz / Zj, bx = rm ? W / 2 : gcx, by = rm ? H * 0.52 : gcy;
        if (t >= 7.2) {
          bs = logLerp(1, 0.05, e5);
          bx = lerp(W / 2, P.x, e5);
          by = lerp(H * 0.52, P.y, e5);
        } else if (t > 6.15) {
          bx = W / 2;
          by = H * 0.52;
          bs = 1;
        }
        show(bb, bbIn * (1 - seg(t, rm ? 7.2 : 7.45, rm ? 7.5 : 7.7)), `translate3d(${bx}px, ${by - M.bbOff * bs}px, 0) translate(-50%, -50%) scale(${Math.max(0.0001, bs)})`);
        const drop = out3(seg(t, 6.22, 6.42));
        show(E.who, seg(t, 6.08, 6.25));
        show(E.old, drop * 0.6, `translate3d(0, ${((1 - drop) * -28).toFixed(2)}px, 0)`);
        show(E.strike, 1, `scaleX(${ease(seg(t, 6.4, 6.55)).toFixed(3)})`);
        show(E.wa, seg(t, 6.5, 6.68), `translate3d(0, ${((1 - out3(seg(t, 6.5, 6.68))) * 12).toFixed(2)}px, 0)`);
      } else show(bb, 0);
      copy(E.c4, t, 6.1, 6.35, 7.1, 7.3);

      // ---------------------------------------------------------------- 5. the sides
      const g5 = E.g5 as HTMLElement | null;
      const e6 = rm ? 0 : ease(seg(t, 9.8, 10.3));
      const g5o = seg(t, rm ? 7.2 : 7.35, rm ? 7.5 : 7.7) * (1 - seg(t, rm ? 9.8 : 9.85, 10.1));
      let z5 = 1, c5x = P.x, c5y = P.y;
      if (t < 7.85) z5 = rm ? 1 : logLerp(3, 1, e5);
      if (t > 9.8) {
        z5 = rm ? 1 : logLerp(1, 0.55, e6);
        c5x = lerp(P.x, W / 2, e6);
        c5y = lerp(P.y, H / 2, e6);
      }
      if (g5) show(g5, g5o, z5 === 1 ? "" : `translate3d(${c5x}px, ${c5y}px, 0) scale(${z5}) translate3d(${-P.x}px, ${-P.y}px, 0)`);
      if (g5o > 0) {
        const hr = E.hair as HTMLElement | null;
        if (hr) {
          hr.style.width = `${W}px`;
          hr.style.transform = `translate3d(0, ${hairY}px, 0)`;
        }
        const hist = E.hist as SVGSVGElement | null;
        const x0 = narrow ? W * 0.08 : W * 0.06;
        const hk2 = `${W}|${H}|${x0}|${P.x}`;
        if (hist && hk2 !== histKey) {
          histKey = hk2;
          hist.setAttribute("viewBox", `0 0 ${W} ${H}`);
          hist.style.width = `${W}px`;
          hist.style.height = `${H}px`;
          // a posted list price: flat at $3.85 for days, then one step to $4.50 overnight, today
          const yA = hairY + H * 0.2, xj = lerp(x0, P.x, 0.9);
          hist.querySelector("path")?.setAttribute("d", `M${x0.toFixed(1)} ${yA.toFixed(1)}L${xj.toFixed(1)} ${yA.toFixed(1)}L${xj.toFixed(1)} ${hairY.toFixed(1)}L${P.x.toFixed(1)} ${hairY.toFixed(1)}`);
          const dot = hist.querySelector("circle");
          dot?.setAttribute("cx", P.x.toFixed(1));
          dot?.setAttribute("cy", P.y.toFixed(1));
        }
        // the switch: up for Long, down for Short, back to the middle for "take a side"
        const swx = narrow ? W * 0.7 : W * 0.72;
        const sw = E.sw as HTMLElement | null, knob = E.knob as HTMLElement | null;
        if (sw && knob) {
          const { swW, swH } = M;
          show(sw, 1, `translate3d(${swx - swW / 2}px, ${hairY - swH / 2}px, 0)`);
          const travel = (swH - swW) / 2;
          const toUp = ease(seg(t, 7.85, 8.05)), toDown = ease(seg(t, 8.45, 8.7)), toMid = ease(seg(t, 9.1, 9.3));
          // (-1 up for Long, +1 down for Short, 0 in the middle)
          const pos = Math.max(-1, Math.min(1, -toUp + 2 * toDown - toMid));
          show(knob, 1, `translate3d(0, ${(travel * pos).toFixed(2)}px, 0)`);
          const longOn = clamp01(-pos), shortOn = clamp01(pos);
          show(E.tUp, 0.15 + longOn * 0.85);
          show(E.tDn, 0.15 + shortOn * 0.85);
          const up = E.tUp as HTMLElement | null, dn = E.tDn as HTMLElement | null;
          if (up) {
            up.style.top = "0";
            up.style.height = `${hairY}px`;
          }
          if (dn) {
            dn.style.top = `${hairY}px`;
            dn.style.height = `${H - hairY}px`;
          }
          show(E.sL, 0.35 + longOn * 0.65, `translate3d(${swx + swW / 2 + 18}px, ${hairY - swH / 2 + 10}px, 0)`);
          show(E.sS, 0.35 + shortOn * 0.65, `translate3d(${swx + swW / 2 + 18}px, ${hairY + swH / 2 - 34}px, 0)`);
          const step = t < 8.47 ? 0 : t < 9.12 ? 1 : 2;
          (E.steps as HTMLElement | null)?.querySelectorAll("i").forEach((el, k) => {
            const on = k === step ? "1" : "0";
            if (el.getAttribute("data-on") !== on) el.setAttribute("data-on", on);
          });
        }
      }
      copy(E.c5a, t, 7.8, 8.0, 8.38, 8.5);
      copy(E.c5b, t, 8.5, 8.68, 9.04, 9.16);
      copy(E.c5c, t, 9.16, 9.34, 9.8, 9.95);
      copy(E.steps, t, 7.85, 8.05, 9.8, 9.95);
      show(E.note5, seg(t, 7.95, 8.2) * (1 - seg(t, 9.8, 9.95)), "", true);

      // ---------------------------------------------------------------- 6. every day
      const g6 = E.g6 as HTMLElement | null;
      const e7 = rm ? 0 : ease(seg(t, 11.4, 11.95));
      const DAYS = D.days, cols = 7;
      const gridW = narrow ? Math.min(W - 40, H * 0.4) : Math.min(W * 0.4, H * 0.8);
      const cell = gridW / cols, dH = cell * 0.82, dW = dH * DIE_ASPECT;
      const rows = Math.ceil((D.firstDow + DAYS) / cols);
      const gx0 = narrow ? (W - gridW) / 2 : W * 0.88 - gridW, gy0 = narrow ? H * 0.42 : H / 2 - (rows * cell) / 2 + 16;
      const dayAt = (i: number) => {
        const k = i + D.firstDow;
        return [gx0 + (k % cols) * cell + (cell - dW) / 2, gy0 + Math.floor(k / cols) * cell + (cell - dH) / 2] as const;
      };
      const lit = seg(t, 10.35, 11.15) * DAYS;
      const today = Math.max(1, Math.min(DAYS, Math.ceil(lit)));
      const [lx, ly] = dayAt(DAYS - 1);
      const D6 = { x: lx + dW / 2, y: ly + dH / 2 };
      let z6 = 1, c6x = W / 2, c6y = H / 2, m6x = W / 2, m6y = H / 2;
      if (t < 10.35) z6 = rm ? 1 : logLerp(2.2, 1, e6);
      const cardC = { x: narrow ? W / 2 : Math.min(W * 0.7, W - gutPx() - M.cw / 2), y: narrow ? H * 0.64 : H / 2 };
      if (t >= 11.4) {
        z6 = rm ? 1 : logLerp(1, 7, e7);
        m6x = D6.x;
        m6y = D6.y;
        c6x = lerp(D6.x, cardC.x, e7);
        c6y = lerp(D6.y, cardC.y, e7);
      }
      const g6o = seg(t, rm ? 9.85 : 9.95, rm ? 10.15 : 10.25) * (1 - seg(t, rm ? 11.4 : 11.6, rm ? 11.7 : 11.85));
      if (g6) show(g6, g6o, z6 === 1 ? "" : `translate3d(${c6x}px, ${c6y}px, 0) scale(${z6}) translate3d(${-m6x}px, ${-m6y}px, 0)`);
      if (g6o > 0) {
        for (let i = 0; i < DAYS; i++) {
          const d = E[`d${i}`] as SVGSVGElement | null, nn = E[`n${i}`] as HTMLElement | null;
          const [x, yy] = dayAt(i);
          const on = clamp01(lit - i);
          if (d) {
            d.style.width = `${dW}px`;
            d.style.height = `${dH}px`;
            d.style.transform = `translate3d(${x}px, ${yy}px, 0)`;
            d.style.setProperty("--on", on.toFixed(3));
          }
          if (nn) {
            nn.style.width = `${dW}px`;
            nn.style.transform = `translate3d(${x}px, ${yy + dH / 2 - 10}px, 0)`;
            nn.style.color = `rgb(var(--${on > 0.5 ? "sg" : "si"}) / ${on > 0.5 ? 0.9 : 0.5})`;
          }
        }
        for (let k = 0; k < cols; k++) {
          const w = E[`w${k}`] as HTMLElement | null;
          if (w) {
            w.style.width = `${cell}px`;
            w.style.transform = `translate3d(${gx0 + k * cell}px, ${gy0 - 30}px, 0)`;
          }
        }
      }
      const rc = E.rc as HTMLElement | null;
      if (rc && t > 10.2 && t < 11.7) {
        const rx = narrow ? gx0 : W * 0.065 + 2, ry = narrow ? gy0 + rows * cell + 18 : H * 0.62;
        show(rc, seg(t, 10.4, 10.6) * (1 - seg(t, 11.35, 11.55)), `translate3d(${rx}px, ${ry + (1 - out3(seg(t, 10.4, 10.6))) * 18}px, 0)`);
        say(E.amt, `+${usd(D.daily)}`);
        say(E.dd, `${D.month.slice(0, 3)} ${today}`);
        say(E.tot, usd(D.daily * today));
      } else show(rc, 0);
      copy(E.c6, t, 10.2, 10.45, 11.35, 11.55);

      // ---------------------------------------------------------------- 7. your AI
      const cd = E.card as HTMLElement | null;
      const e8 = rm ? 0 : ease(seg(t, 13.0, 13.6));
      if (cd && t > 11.4 && t < 13.6) {
        const { cw, ch } = M;
        let cs = 1, cx = cardC.x, cy = cardC.y;
        if (t < 11.95) {
          // (the card grows out of the chip the camera fell into)
          cs = rm ? 1 : logLerp((dW * z6) / cw, 1, e7);
          cx = rm ? cardC.x : c6x;
          cy = rm ? cardC.y : c6y;
        }
        if (t > 13.0) {
          cs = rm ? 1 : logLerp(1, 0.08, e8);
          cx = lerp(cardC.x, W / 2, e8);
          cy = lerp(cardC.y, H / 2, e8);
        }
        show(cd, seg(t, rm ? 11.5 : 11.62, rm ? 11.8 : 11.85) * (1 - seg(t, rm ? 13.0 : 13.25, rm ? 13.3 : 13.5)), `translate3d(${cx - cw / 2}px, ${cy - ch / 2}px, 0) scale(${Math.max(0.0001, cs)})`);
        const a = ease(seg(t, 12.25, 12.6));
        const fill = E.fill as HTMLElement | null;
        const cp = `inset(0 ${((1 - a) * 100).toFixed(2)}% 0 0)`;
        if (fill && fill.style.clipPath !== cp) fill.style.clipPath = cp;
        show(E.yesA, 1 - seg(t, 12.6, 12.68));
        show(E.yesB, seg(t, 12.62, 12.72));
      } else show(cd, 0);
      copy(E.c7, t, 11.8, 12.05, 12.95, 13.15);

      // ---------------------------------------------------------------- behind it all: the board, drifting
      // (a still mask on a layer a pitch taller than the screen, moved on the compositor; it wraps every pitch)
      const bo = (rm ? 0 : 1) * seg(t, 3.7, 4.1) * (1 - seg(t, 13.1, 13.4));
      const pY = M.pitchB * FIELD_ASPECT, dy = (((t * H * 0.11) % pY) + pY) % pY;
      show(E.bgf, bo, bo > 0 ? `translate3d(0, ${(-dy).toFixed(1)}px, 0)` : "");

      // ---------------------------------------------------------------- 8. the close
      // (the board is twice the screen each way; the camera pulls out round the screen's centre)
      const fo = seg(t, 13.1, 13.45);
      show(E.field, fo, fo > 0 ? `translate3d(${W}px, ${H}px, 0) scale(${rm ? 1 : logLerp(5, 1, e8)}) translate3d(${-W}px, ${-H}px, 0)` : "");
      show(E.vig, fo);
      copy(E.c8, t, 13.45, 13.75, 99, 100);
    };

    // (the site's camera stops where its pin lets go: from there the stage scrolls away with the page as it is)
    const target = () => Math.min(site ? SITE_END : Infinity, (window.scrollY - top) / Math.max(1, H));
    const tick = (now: number) => {
      const dt = last < 0 ? 1 / 60 : Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      const k = rm || still ? 1 : 1 - Math.exp(-dt / 0.085);
      const before = ys;
      ys += (y - ys) * k;
      if (Math.abs(y - ys) < 0.0004) ys = y;
      if (ys !== before || dirty) render(ys);
      dirty = false;
      raf = ys !== y ? requestAnimationFrame(tick) : 0;
    };
    const kick = () => {
      if (!raf) {
        last = -1;
        raf = requestAnimationFrame(tick);
      }
    };
    const redraw = () => {
      dirty = true;
      if (still) render(ys);
      else kick();
    };
    const onScroll = () => {
      y = target();
      kick();
    };
    // a new read (clouds, the month, the theme): measure again and draw
    onData.current = () => {
      sizes();
      redraw();
    };
    // the hero drew: while the dive still follows it, draw again (a still check draws on every hero frame)
    heroView.onDraw = () => {
      if (still) render(ys);
      else if (ys > 0 && ys < 1 && !tileReady) redraw();
    };
    // Tab to a link in words that are not on screen brings their scene up
    const onFocus = (e: FocusEvent) => {
      const b = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-t]");
      if (!b || parseFloat(b.style.opacity || "0") > 0.5) return;
      window.scrollTo(0, top + Number(b.dataset.t) * H);
    };
    const ro = new ResizeObserver(() => {
      measure();
      y = ys = target();
      redraw();
    });
    ro.observe(st);
    measure();
    document.fonts?.ready.then(() => {
      if (!alive) return;
      sizes();
      redraw();
    });
    // (a render check: the camera stops at ?at= screens)
    const at = q.get("at");
    if (still && at !== null) {
      window.scrollTo(0, top + (Number(at) || 0) * H);
      frames.load();
    }
    y = ys = target();
    render(ys);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    st.addEventListener("focusin", onFocus);
    return () => {
      alive = false;
      frames.stop();
      if (idle) window.cancelIdleCallback(idleId);
      else window.clearTimeout(idleId);
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      st.removeEventListener("focusin", onFocus);
      onData.current = () => {};
      heroView.onDraw = null;
      heroView.hold = false;
    };
  }, []);

  const lines = (txt: string) =>
    txt.split("\n").map((l) => (
      <span key={l} data-l style={{ display: "block" }}>
        {l}
      </span>
    ));

  if (site)
    return (
      <div ref={track} className={s.track} data-tone={tone} data-site="" style={{ height: `${(SITE_END + 1) * 100}svh` }}>
        <div ref={stage} className={s.stage}>
          <div ref={heroL} className={s.heroL}>
            {hero}
          </div>
          <canvas ref={chip} className={s.chip} aria-hidden />
          <div className={s.scene}>
            <div ref={rf("c2")} className={`${s.copy} ${s.turn}`} data-at={turnAt === "under" ? "under" : "mid"} data-t="2.6">
              {turn}
            </div>
          </div>
        </div>
      </div>
    );

  return (
    <>
      <div ref={track} className={s.track} data-tone={tone} style={{ height: `${(END + 1) * 100}svh` }}>
        <div ref={stage} className={s.stage}>
          <div ref={heroL} className={s.heroL}>
            {hero}
          </div>
          <header ref={rf("bar")} className={s.bar}>
            <Link href={to("/")} aria-label="Agate">
              <Lockup height={26} wcase="title" />
            </Link>
            <Link href={to("/app")} className={s.barLink}>
              Open app
            </Link>
          </header>
          <div ref={rf("bgf")} className={s.bgField} style={{ maskImage: FIELD_MASK, WebkitMaskImage: FIELD_MASK }} aria-hidden />
          <canvas ref={chip} className={s.chip} aria-hidden />

          {/* 2. the H100 */}
          <div className={s.scene}>
            <div ref={rf("c2")} className={s.copy} data-at="mid" data-t="2.95">
              <h2 className={s.h}>{lines("An hour of\nan H100")}</h2>
              <b className={s.big} data-l>
                {usd(index)}
              </b>
              <p className={s.line} data-l>
                The going rate for one hour, from the clouds&apos; own price pages.
              </p>
            </div>
          </div>

          {/* 3. the clouds, one open price; 4. the jump starts in here */}
          <div className={s.scene}>
            <div ref={rf("g3")} className={s.group} aria-hidden>
              {[3, 4, 5, 6, 7].map((v, k) => (
                <div key={v}>
                  <div ref={rf(`ar${k}`)} className={`${s.rule} ${s.faint}`} />
                  <span ref={rf(`ax${k}`)} className={s.axis}>
                    ${v}
                  </span>
                </div>
              ))}
              {clouds.map((c, i) => (
                <div key={c.name}>
                  <Die refEl={rf(`t${i}`)} />
                  <div ref={rf(`l${i}`)} className={s.tag}>
                    <span>{c.name}</span>
                    <b>{usd(c.price)}</b>
                  </div>
                </div>
              ))}
              <div ref={rf("rule3")} className={s.rule} />
              <div ref={rf("p3")} className={s.price}>
                <span>Agate&apos;s open price</span>
                <b>{usd(index)}</b>
              </div>
            </div>
            <div ref={rf("c3a")} className={s.copy} data-at="top" data-t="4.4">
              <h2 className={s.h}>{lines("Every cloud asks\nits own price.")}</h2>
              <p className={s.sr}>{clouds.map((c) => `${c.name} ${usd(c.price)}`).join(", ")}, for an H100 hour.</p>
            </div>
            <div ref={rf("c3b")} className={s.copy} data-at="top" data-t="5.45">
              <h2 className={s.h}>{lines("One open price.")}</h2>
              <p className={s.line} data-l>
                The middle of every cloud&apos;s price, written onchain every day.
              </p>
              <Link href={to("/app/gpu-index")} className={s.link} data-l>
                See today&apos;s reads
              </Link>
            </div>
          </div>

          {/* 4. the jump */}
          <div className={s.scene}>
            <div ref={rf("bb")} className={s.board} aria-hidden>
              <span ref={rf("who")} className={s.who}>
                {JUMP.cloud}, an H100 hour
              </span>
              <span ref={rf("old")} className={s.was}>
                {usd(JUMP.from)}
                <i ref={rf("strike")} className={s.strike} />
              </span>
              <span ref={rf("nw")} className={s.nums}>
                {usd(JUMP.to)}
              </span>
              <span ref={rf("wa")} className={s.when}>
                <b>+{Math.round((JUMP.to / JUMP.from - 1) * 100)}%</b> from {JUMP.before} evening to {JUMP.after} morning
              </span>
            </div>
            <div ref={rf("c4")} className={s.copy} data-at="top" data-t="6.75">
              <h2 className={s.h}>{lines("GPU prices jump\novernight.")}</h2>
              <p className={s.sr}>
                {JUMP.cloud}&apos;s H100 hour went from {usd(JUMP.from)} on the evening of {JUMP.before} to {usd(JUMP.to)} the next morning, up{" "}
                {Math.round((JUMP.to / JUMP.from - 1) * 100)}%.
              </p>
              <p className={s.line} data-l>
                Until now there was no open way to lock them in.
              </p>
            </div>
          </div>

          {/* 5. the sides */}
          <div className={s.scene}>
            <div ref={rf("g5")} className={s.group} aria-hidden>
              <div ref={rf("tUp")} className={s.tint} />
              <div ref={rf("tDn")} className={s.tint} />
              <svg ref={rf("hist")} className={s.hist}>
                <path d="" />
                <circle r="6" cx="0" cy="0" />
              </svg>
              <div ref={rf("hair")} className={s.rule} />
              <div ref={rf("sw")} className={s.switch}>
                <div ref={rf("knob")} className={s.knob} />
              </div>
              <span ref={rf("sL")} className={s.side}>
                Long
              </span>
              <span ref={rf("sS")} className={s.side}>
                Short
              </span>
            </div>
            <div ref={rf("c5a")} className={s.copy} data-at="top" data-t="8.2">
              <h2 className={s.h}>{lines("Lock in\nwhat you pay.")}</h2>
              <p className={s.line} data-l>
                Renting GPUs? Go Long, and a rise in price pays you back.
              </p>
            </div>
            <div ref={rf("c5b")} className={s.copy} data-at="top" data-t="8.86">
              <h2 className={s.h}>{lines("Protect\nwhat you earn.")}</h2>
              <p className={s.line} data-l>
                Renting them out? Go Short, and a fall in price pays you back.
              </p>
            </div>
            <div ref={rf("c5c")} className={s.copy} data-at="top" data-t="9.55">
              <h2 className={s.h}>{lines("Or trade where\nit goes next.")}</h2>
              <p className={s.line} data-l>
                Lock {month} at {usd(lockAt)} an hour, or take the other side.
              </p>
            </div>
            <div ref={rf("steps")} className={s.copy} style={{ top: "auto", bottom: "clamp(84px, 14svh, 132px)" }} aria-hidden>
              <div className={s.steps}>
                <i data-on="1" />
                <i data-on="0" />
                <i data-on="0" />
              </div>
            </div>
            <p ref={rf("note5")} className={s.note}>
              The most you can lose is what you put in.
            </p>
          </div>

          {/* 6. every day */}
          <div className={s.scene}>
            <div ref={rf("g6")} className={s.group} aria-hidden>
              {["S", "M", "T", "W", "T", "F", "S"].map((d, k) => (
                <span key={k} ref={rf(`w${k}`)} className={s.wk}>
                  {d}
                </span>
              ))}
              {Array.from({ length: days }, (_, i) => (
                <div key={i}>
                  <Die refEl={rf(`d${i}`)} />
                  <span ref={rf(`n${i}`)} className={s.dayn}>
                    {i + 1}
                  </span>
                </div>
              ))}
            </div>
            <div ref={rf("c6")} className={s.copy} data-at="top" data-t="10.9">
              <h2 className={s.h}>{lines("Get paid\nevery day.")}</h2>
              <p className={s.line} data-l>
                Turn on Pay me daily and each day pays out as soon as its price is final.
              </p>
              <p className={s.sr}>On 100 GPU-hours Long, that is about {usd(daily)} a day.</p>
            </div>
            <div ref={rf("rc")} className={s.receipt} aria-hidden>
              <div className={s.row}>
                <span>Paid today</span>
                <span ref={rf("dd")}>{`${mon} 1`}</span>
              </div>
              <div ref={rf("amt")} className={s.amt}>
                {`+${usd(daily)}`}
              </div>
              <div className={s.row}>
                <span>100 GPU-hours, Long</span>
                <span>
                  This month <b ref={rf("tot")}>{usd(daily)}</b>
                </span>
              </div>
            </div>
          </div>

          {/* 7. your AI */}
          <div className={s.scene}>
            <div ref={rf("card")} className={s.card} aria-hidden>
              <div className={s.cardTop}>
                <span className={s.spark}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
                  </svg>
                </span>
                Your AI asks to go over its limit
              </div>
              <p className={s.ask}>
                Buy <b>100 GPU-hours</b> of H100 for {month} at <b>{usd(lockAt)}</b>
              </p>
              <p className={s.why}>
                That is {usd0(100 * lockAt)}, over its cap of {usd0(POCKET.cap)} a trade.
              </p>
              <div className={s.limits}>
                <span>Budget {usd0(POCKET.budget)}</span>
                <span>Up to {usd0(POCKET.cap)} a trade</span>
                <span>{POCKET.perDay} trades a day</span>
                <span>
                  Until {mon} {days}
                </span>
              </div>
              <div className={s.acts}>
                <span className={s.no}>Decline</span>
                <span className={s.yes}>
                  <span className={s.yesUnder}>Approve</span>
                  <span ref={rf("fill")} className={s.fill}>
                    <span ref={rf("yesA")}>Approve</span>
                  </span>
                  <span ref={rf("yesB")} className={s.done}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m5 12.5 4.5 4.5L19 7.5" />
                    </svg>
                    Approved
                  </span>
                </span>
              </div>
            </div>
            <div ref={rf("c7")} className={s.copy} data-at="top" data-t="12.5">
              <h2 className={s.h}>{lines("Your AI.\nYour limits.")}</h2>
              <p className={s.line} data-l>
                Connect any AI. It trades from its own pocket, inside the limits you set. Anything bigger, it asks you first.
              </p>
            </div>
          </div>

          {/* 8. the close */}
          <div className={s.scene}>
            <div ref={rf("field")} className={s.field} style={{ background: "rgb(var(--si) / .16)", maskImage: FIELD_MASK, WebkitMaskImage: FIELD_MASK }} aria-hidden />
            <div ref={rf("vig")} className={s.vignette} aria-hidden />
            <div ref={rf("c8")} className={s.copy} data-at="center" data-t="13.95">
              <h2 className={s.h}>{lines("Make your first trade\nin a minute.")}</h2>
              <div className={s.ctaRow} data-l>
                <Link href={to("/app")} className={s.cta}>
                  Start trading
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                    <path d="M3 8h10M9 4l4 4-4 4" />
                  </svg>
                </Link>
                <Link href={to("/docs")} className={s.ghost}>
                  Read the docs
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
      <footer className={s.foot} data-tone={tone}>
        <Lockup height={26} wcase="title" />
        <nav aria-label="Agate">
          <Link href={to("/app")}>Markets</Link>
          <Link href={to("/app/gpu-index")}>Index</Link>
          <Link href={to("/docs")}>Docs</Link>
          <Link href={to("/privacy")}>Privacy</Link>
        </nav>
        <p>The open price of compute. Live on Monad testnet.</p>
      </footer>
    </>
  );
}
