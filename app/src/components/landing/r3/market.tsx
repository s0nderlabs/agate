"use client";
// Shared parts for the two market-grammar variants. Each part speaks the app's own language (rows, hairlines, panels, the real app),
// and every number in them is live from the testnet.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { stillMode } from "@/components/lab/data";
import { AppFrame, Phone, usd, type R3 } from "./kit";
import s from "./market.module.css";

/** Every GPU's open price and its move since the day before, sliding slowly across the page. */
export function Ticker({ r, className = "" }: { r: R3; className?: string }) {
  const [still, setStill] = useState(false);
  useEffect(() => setStill(stillMode()), []);
  const items = r.gpus.filter((g) => g.price > 0);
  if (!items.length) return null;
  const one = items.map((g) => {
    const d = Math.round(g.change * 100) / 100;
    const cls = d > 0 ? s.tickUp : d < 0 ? s.tickDown : s.tickFlat;
    return (
      <span key={g.gpu} className={s.tickItem}>
        <span className={s.tickGpu}>{g.gpu}</span>
        <b>{usd(g.price)}</b>
        <span className={cls}>{d > 0 ? `+${d.toFixed(2)}` : d < 0 ? `−${Math.abs(d).toFixed(2)}` : "0.00"}</span>
      </span>
    );
  });
  return (
    <div className={`${s.ticker} ${className}`} aria-label={items.map((g) => `${g.gpu} ${usd(g.price)} an hour`).join(", ")}>
      <div className={s.tickTrack} style={still ? { animation: "none" } : undefined} aria-hidden>
        {one}
        {one}
        {one}
        {one}
      </div>
    </div>
  );
}

/** The real market page on a dark set with one soft key light, a phone running the app in front of it. */
export function Stage({ className = "", phone = true }: { className?: string; phone?: boolean }) {
  return (
    <div className={`${s.stage} ${className}`} data-rv="media">
      <div className={s.stageScreen}>
        <AppFrame crop={{ x: 0, y: 0, w: 1440, h: 900 }} title="Agate's market page, live" />
      </div>
      {phone && (
        <div className={s.stagePhone} style={{ width: "20%" }}>
          <Phone width={250} style={{ width: "100%", "--pw": "250px" } as CSSProperties} />
        </div>
      )}
      <div className={s.stageFloor} />
    </div>
  );
}

/** A statement that lights up word by word as it scrolls through the screen. */
export function Statement({ children, className = "" }: { children: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const words = children.split(/\s+/);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const spans = Array.from(el.querySelectorAll<HTMLElement>("[data-word]"));
    const light = (n: number) => spans.forEach((sp, i) => sp.classList.toggle(s.wordOn, i < n));
    if (stillMode() || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      light(spans.length);
      return;
    }
    let q = false;
    const tick = () => {
      q = false;
      const r = el.getBoundingClientRect();
      const vh = innerHeight;
      const p = Math.max(0, Math.min(1, (vh * 0.85 - r.top) / (vh * 0.55 + r.height * 0.5)));
      light(Math.round(p * spans.length));
    };
    const on = () => {
      if (!q) {
        q = true;
        requestAnimationFrame(tick);
      }
    };
    tick();
    addEventListener("scroll", on, { passive: true });
    addEventListener("resize", on);
    return () => {
      removeEventListener("scroll", on);
      removeEventListener("resize", on);
    };
  }, []);
  return (
    <div className={s.statementWrap}>
      <p ref={ref} className={`${s.statement} ${className}`} aria-label={children}>
        {words.map((w, i) => (
          <span key={i} data-word className={s.word} aria-hidden>
            {w}
            {i < words.length - 1 ? " " : ""}
          </span>
        ))}
      </p>
    </div>
  );
}

/** A real app screen standing on a lace plinth, beside a column that opens with a thick rule. */
export function Split({ screen, title, body, foot, flip = false, bare = false }: { screen: ReactNode; title: string; body: ReactNode; foot?: ReactNode; flip?: boolean; bare?: boolean }) {
  return (
    <div className={`${s.split} ${flip ? s.splitFlip : ""}`}>
      <div className={s.plinth} data-rv="media">
        <div className={bare ? s.plinthBare : s.plinthScreen}>{screen}</div>
      </div>
      <div className={s.ruleCol} data-rv="fade">
        <h2 className={s.ruleTitle}>{title}</h2>
        <p className={s.ruleBody}>{body}</p>
        {foot && <div className={s.ruleFoot}>{foot}</div>}
      </div>
    </div>
  );
}

/** Today's clouds for one GPU, cheapest first, the middle one marked: it is the day's price. */
export function CloudTable({ r, className = "" }: { r: R3; className?: string }) {
  const list = r.h.clouds;
  if (!list.length) return <div className={s.tr}>Reading the clouds…</div>;
  const mid = Math.floor((list.length - 1) / 2);
  return (
    <div className={`${s.table} ${className}`} data-rv="set">
      {list.map((c, i) => (
        <div key={c.name} className={`${s.tr} ${i === mid ? s.trMid : ""}`}>
          <span>{c.name}</span>
          <span>
            {i === mid && <span className={s.trTag}>Agate</span>}
            {usd(c.price)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Where a month can settle (its floor and cap), with today's price on the band. */
export function Band({ r }: { r: R3 }) {
  const m = r.m;
  if (!m || !(m.cap > m.floor)) return null;
  const at = Math.max(0, Math.min(100, ((r.h.price - m.floor) / (m.cap - m.floor)) * 100));
  return (
    <div className={s.band} data-rv="fade" aria-label={`${m.name} settles between ${usd(m.floor)} and ${usd(m.cap)}; today ${usd(r.h.price)}`}>
      <div className={s.bandNow}>{usd(r.h.price)}</div>
      <div className={s.bandTrack}>
        <span className={s.bandDot} style={{ left: `${at}%` }} />
      </div>
      <div className={s.bandEnds}>
        <span>{usd(m.floor)}</span>
        <span>{usd(m.cap)}</span>
      </div>
    </div>
  );
}

/** A month as its days, Monday first: each one settles on that day's price. */
export function MonthGrid({ r }: { r: R3 }) {
  const m = r.m;
  if (!m) return null;
  const [y, mo] = m.month.split("-").map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const first = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7;
  return (
    <div className={s.cal} data-rv="fade" aria-label={`${m.name}: ${days} days, each settling on its own price`}>
      {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
        <span key={i} className={s.calHead}>
          {d}
        </span>
      ))}
      {Array.from({ length: first }, (_, i) => (
        <span key={`g${i}`} className={`${s.day} ${s.dayGap}`} />
      ))}
      {Array.from({ length: days }, (_, i) => (
        <span key={i} className={s.day}>
          {i + 1}
        </span>
      ))}
    </div>
  );
}

/** Your AI at work, as the app shows it: what it tried, the limit it hit, and your approval. The $500 limit is an
 *  example setting; the trade uses today's live price. */
export function AgentCard({ r, className = "" }: { r: R3; className?: string }) {
  const hours = 200;
  const long = r.m?.long ?? 0;
  return (
    <div className={`${s.agent} ${className}`}>
      <div className={s.agentSide}>
        <span className={s.agentName}>
          <i className={s.agentLive} />
          Claude
        </span>
        <span className={s.agentRow}>
          Trades from <b>its own pocket</b>
        </span>
        <span className={s.agentRow}>
          Asks you past <b>$500</b>
        </span>
      </div>
      <div className={s.agentMain}>
        <span className={s.agentHead}>Today</span>
        <ol className={s.steps} data-rv="set">
          <li>
            <span className={`${s.stepMark} ${s.stepDone}`} aria-hidden />
            <span>
              Going Long <b>{hours} GPU-hours</b> of H100 {r.month}
              {long ? ` at ${usd(long)}` : ""}.
            </span>
          </li>
          <li>
            <span className={`${s.stepMark} ${s.stepWait}`} aria-hidden />
            <span>{long ? `That is $${Math.round(hours * long).toLocaleString("en-US")}, past its $500 limit. Asking you first.` : "That is past its $500 limit. Asking you first."}</span>
          </li>
          <li>
            <span className={`${s.stepMark} ${s.stepDone}`} aria-hidden />
            <span className={s.stepOk}>Approved with your passkey.</span>
          </li>
        </ol>
      </div>
    </div>
  );
}

export { s as market };
