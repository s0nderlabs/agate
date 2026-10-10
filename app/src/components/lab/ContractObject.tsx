"use client";
// "One month of H100, as one object" (asset lab, round 2): the November market made into a single thing you can read
// at a glance. The track is the month's band (it settles between its floor and cap), the marks are today's index and
// what a Long and a Short cost right now, and the thirty cells under it are the month's days, each paying a thirtieth.
// After Apple Card's interest wheel: one real component of the product, promoted to the hero object.
import { useEffect, useRef, useState } from "react";
import { usd } from "@/lib/format";
import type { LabGpu } from "./data";
import { stillMode } from "./data";
import s from "./lab.module.css";

/** `focus` lights one part (the Long price, the Short price, or the thirty days); without it the card shows all. */
export function ContractObject({ g, focus = null }: { g: LabGpu; focus?: "long" | "short" | "daily" | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const [day, setDay] = useState(0);
  // the card renders nothing until the month is read, so the reveal waits for it (else the ref is still empty)
  const ready = !!g.month;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const still = stillMode();
    if (still) {
      setOn(true);
      setDay(12);
      return;
    }
    let timer = 0;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        setOn(true);
        window.clearInterval(timer);
        timer = window.setInterval(() => setDay((d) => (d + 1) % 31), 260);
      } else window.clearInterval(timer);
    }, { threshold: 0.35 });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearInterval(timer);
    };
  }, [ready]);
  const m = g.month;
  if (!m) return null;
  const span = m.cap - m.floor || 1;
  const at = (v: number) => `${Math.max(0, Math.min(1, (v - m.floor) / span)) * 100}%`;
  const year = m.month.slice(0, 4);
  return (
    <div ref={ref} className={`${s.contract} ${on ? s.contractOn : ""}`} data-focus={focus ?? undefined}>
      <div className={s.contractHead}>
        <div>
          <span className={s.contractName}>
            {g.gpu} {m.name} {year}
          </span>
          <span className={s.contractSub}>Settles on the average of {m.name}&apos;s {m.days} index prices</span>
        </div>
        <div className={s.contractOpen}>
          <b>{Math.round(m.open).toLocaleString("en-US")}</b>
          <span>GPU-hours open</span>
        </div>
      </div>

      <div className={s.bandWrap}>
        <div className={s.bandTrack}>
          <i className={s.bandFill} style={{ width: on ? at(g.price) : "0%" }} />
          <i className={s.bandNow} style={{ left: on ? at(g.price) : "0%" }} />
        </div>
        <span className={s.bandPill} data-side="long" style={{ left: on ? at(m.long) : "0%" }}>
          Long {usd(m.long)}
        </span>
        <span className={s.bandPill} data-side="short" style={{ left: on ? at(m.short) : "0%" }}>
          Short {usd(m.short)}
        </span>
        <div className={s.bandEnds}>
          <span>
            <b>{usd(m.floor)}</b> floor
          </span>
          <span>
            Index today <b>{usd(g.price)}</b>
          </span>
          <span>
            cap <b>{usd(m.cap)}</b>
          </span>
        </div>
      </div>

      <div className={s.days} style={{ "--days": m.days, "--half": Math.ceil(m.days / 2), "--third": Math.ceil(m.days / 3) } as React.CSSProperties} aria-label={`${m.name}'s ${m.days} days, each paying one ${m.days}th`}>
        {Array.from({ length: m.days }, (_, i) => (
          <i key={i} className={i < day ? s.dayPaid : s.day}>
            {i + 1}
          </i>
        ))}
      </div>
      <div className={s.contractFoot}>
        <span>Each day pays a {m.days}th, every morning, if you choose pay me daily</span>
        <span>Most you can lose: what you put in</span>
      </div>
    </div>
  );
}
