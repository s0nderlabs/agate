"use client";
// Landing round 2 (the Oct 7 asks): one core idea, "the price of compute, made tradable", told simply (what, why, how),
// with a headline that changes for each kind of person: who pays for GPUs, who rents them out, who trades, who builds
// with AI. Every number is live from the testnet (next month's Long and Short prices, today's index, each cloud).
// No test dollars anywhere. The parts here are shared by the five variants in this folder.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Lockup } from "@/components/brand/Logo";
import { stillMode, useLabData, type LabGpu } from "@/components/lab/data";
import { usd } from "@/lib/format";
import { useLinkQuery } from "@/lib/mock/store";
import s from "./r2.module.css";

/** The live numbers every variant tells its story with: H100 today and its next month, plus all six GPUs. */
export function useR2() {
  const { gpus, ready } = useLabData();
  const h = gpus.find((g) => g.gpu === "H100")!;
  const m = h.month;
  const open = gpus.reduce((a, g) => a + (g.month?.open ?? 0), 0);
  const lo = h.clouds[0], hi = h.clouds[h.clouds.length - 1];
  return { ready, gpus, h, m, open, lo, hi, month: m?.name ?? "next month" };
}
export type R2 = ReturnType<typeof useR2>;

export function useHref() {
  const q = useLinkQuery();
  return (path: string) => (path === "/" ? `/${q}` : `${path}${q}`);
}

export function Go({ children = "Get started", soft = false, href = "/" }: { children?: ReactNode; soft?: boolean; href?: string }) {
  const to = useHref();
  return (
    <Link href={to(href)} className={`ag-btn ${soft ? "ag-btn--soft" : "ag-btn--primary"} ag-btn--lg ${s.go}`}>
      {children}
    </Link>
  );
}

export function Nav({ dark = false }: { dark?: boolean }) {
  const to = useHref();
  return (
    <header className={`${s.nav} ${dark ? "tone-dark" : ""}`}>
      <Link href={to("/")} className={s.brand} aria-label="Agate">
        <Lockup height={30} wcase="title" />
      </Link>
      <nav className={s.links} aria-label="Agate">
        <Link href={to("/")}>Markets</Link>
        <Link href={to("/gpu-index")}>Index</Link>
        <Link href={to("/positions")}>Positions</Link>
      </nav>
      <Go>Get started</Go>
    </header>
  );
}

export function Foot() {
  const to = useHref();
  return (
    <footer className={s.foot}>
      <Lockup height={26} wcase="title" />
      <nav className={s.footLinks} aria-label="More">
        <Link href={to("/")}>Markets</Link>
        <Link href={to("/gpu-index")}>Index</Link>
        <Link href={to("/positions")}>Positions</Link>
        <Link href="/privacy">Privacy</Link>
      </nav>
      <p>Agate runs on Monad testnet.</p>
    </footer>
  );
}

/** Who the headline speaks to, in turn. The first two carry next month's live price. */
export function sides(r: R2) {
  const m = r.m;
  return [
    { key: "pay", who: "Paying for GPUs?", say: m ? `Lock in ${usd(m.long)} an hour for ${m.name}.` : "Lock in what you pay." },
    { key: "earn", who: "Renting out GPUs?", say: m ? `Lock in ${usd(m.short)} an hour for ${m.name}.` : "Lock in what you earn." },
    { key: "trade", who: "Trading?", say: "Go long or short on GPU prices." },
    { key: "ai", who: "Building with AI?", say: "Let your AI trade it, within your limits." },
  ];
}

/** The changing headline: the question line and the answer swap every few seconds; a still frame shows the first. */
export function Rotator({ r, size = "xl", align = "start", onChange, index }: { r: R2; size?: "xl" | "lg"; align?: "start" | "center"; onChange?: (i: number) => void; index?: number }) {
  const list = sides(r);
  const [i, setI] = useState(0);
  const at = index ?? i;
  useEffect(() => {
    if (index !== undefined || stillMode()) return;
    const t = window.setInterval(() => setI((x) => (x + 1) % list.length), 3200);
    return () => window.clearInterval(t);
  }, [index, list.length]);
  useEffect(() => {
    onChange?.(at);
  }, [at, onChange]);
  const cur = list[at];
  return (
    <div className={`${s.rot} ${size === "lg" ? s.rotLg : ""} ${align === "center" ? s.rotCenter : ""}`} aria-live="off">
      <span key={`w${at}`} className={s.rotWho}>
        {cur.who}
      </span>
      <h1 key={`s${at}`} className={s.rotSay}>
        {cur.say}
      </h1>
      <span className={s.srOnly}>{list.map((x) => `${x.who} ${x.say}`).join(" ")}</span>
    </div>
  );
}

/** The one line that never changes. */
export function Core({ center = false }: { center?: boolean }) {
  return <p className={`${s.core} ${center ? s.center : ""}`}>Agate makes the price of compute tradable.</p>;
}

/** Today's H100 price with its plain label. */
export function PriceChip({ r }: { r: R2 }) {
  return (
    <div className={s.chip}>
      <b>{r.h.price ? usd(r.h.price) : "$0.00"}</b>
      <span>An hour of an Nvidia H100 today</span>
    </div>
  );
}

/** Why: the price moves, and it differs by cloud. Nebius's Oct 1 2026 change is from its own price page. */
export function Jump({ r, compact = false }: { r: R2; compact?: boolean }) {
  return (
    <div className={`${s.jump} ${compact ? s.jumpCompact : ""}`}>
      <div className={s.jumpRow}>
        <span className={s.jumpFrom}>$3.85</span>
        <span className={s.jumpArrow} aria-hidden>
          →
        </span>
        <span className={s.jumpTo}>$4.50</span>
      </div>
      <p>Nebius raised its H100 hour 17% overnight on October 1.</p>
      {!compact && r.lo && r.hi && (
        <p>
          Today the same hour costs {usd(r.lo.price)} at {r.lo.name} and {usd(r.hi.price)} at {r.hi.name}.
        </p>
      )}
    </div>
  );
}

/** How, in three steps; each step's picture is live. */
export function Steps({ r }: { r: R2 }) {
  const m = r.m;
  return (
    <ol className={s.steps}>
      <li>
        <div className={s.stepArt}>
          <div className={s.dots}>
            {r.h.clouds.map((c) => (
              <span key={c.name} className={Math.abs(c.price - r.h.price) < 0.005 ? s.dotMid : ""}>
                {usd(c.price)}
              </span>
            ))}
          </div>
        </div>
        <h3>One open price a day</h3>
        <p>We read five clouds every day and put the middle price onchain.</p>
      </li>
      <li>
        <div className={s.stepArt}>
          <div className={s.sidesArt}>
            <span data-side="long">Long {m ? usd(m.long) : ""}</span>
            <span data-side="short">Short {m ? usd(m.short) : ""}</span>
          </div>
        </div>
        <h3>Go long or short</h3>
        <p>Pick a month. Long gains when GPUs cost more, Short when they cost less.</p>
      </li>
      <li>
        <div className={s.stepArt}>
          <div className={s.daysArt} aria-hidden>
            {Array.from({ length: 30 }, (_, i) => (
              <i key={i} className={i < 11 ? s.dayOn : ""} />
            ))}
          </div>
        </div>
        <h3>Get paid as the month goes</h3>
        <p>Each day settles on that day&apos;s price. You can be paid every morning.</p>
      </li>
    </ol>
  );
}

/** Who it is for, each with what Agate does for them. */
export function Who({ r }: { r: R2 }) {
  const m = r.m;
  return (
    <div className={s.who}>
      <div>
        <h3>Paying for GPUs</h3>
        <p>Go Long to lock in {m ? `${usd(m.long)} an hour` : "your price"}. If prices rise, Agate pays you the difference.</p>
      </div>
      <div>
        <h3>Renting out GPUs</h3>
        <p>Go Short to lock in {m ? `${usd(m.short)} an hour` : "your income"}. If prices fall, Agate pays you the difference.</p>
      </div>
      <div>
        <h3>Trading</h3>
        <p>Take a view on the price of compute, both ways, on an open market.</p>
      </div>
      <div>
        <h3>Building with AI</h3>
        <p>Your AI can trade from its own pocket, inside the limits you set.</p>
      </div>
    </div>
  );
}

export function Safe() {
  return (
    <div className={s.safe}>
      <h2>Only lose what you put in.</h2>
      <p>Every trade is fully backed. No margin calls, no liquidations.</p>
    </div>
  );
}

export function Close({ children }: { children?: ReactNode }) {
  return (
    <div className={s.close}>
      <h2>Make your first trade in a minute.</h2>
      <p>Sign in with email, Google or a passkey. No wallet needed.</p>
      <div className={s.row}>
        <Go />
      </div>
      {children}
    </div>
  );
}

/** One worked example in live numbers: what the month's Long or Short does when the price moves. */
export function example(r: R2, side: "long" | "short") {
  const m = r.m;
  if (!m) return null;
  if (side === "long") {
    const at = Math.min(m.cap, Math.round((m.long * 1.25) * 100) / 100);
    return { at, gain: at - m.long, lock: m.long };
  }
  const at = Math.max(m.floor, Math.round((m.short * 0.75) * 100) / 100);
  return { at, gain: m.short - at, lock: m.short };
}

export type { LabGpu };
