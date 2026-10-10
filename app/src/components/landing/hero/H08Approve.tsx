"use client";
// Hero 8, "Your AI asks first" (Mercury's bill, faded, with the AI's chips landing on the fields it read): a soft warm
// grey, the headline on the left, and on the right one trade request from your AI. Its details land on the faded form one
// by one, the last one says it is over your limit, and the passkey button approves it. Then it starts again.
import { useEffect, useState, type CSSProperties } from "react";
import { stillMode } from "@/components/lab/data";
import { CORE, Cta, Nav, Rotator, k, useHero, useSide, usd } from "./kit";
import s from "./h08.module.css";

const HOURS = 200;
const LIMIT = 500;
const LAST = 7;

export function H08Approve() {
  const r = useHero();
  const i = useSide(r.sides.length);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (stillMode()) {
      setStep(LAST);
      return;
    }
    let t = 0;
    const plan = [700, 650, 650, 650, 650, 900, 1300, 3400];
    const run = (n: number) => {
      t = window.setTimeout(() => {
        const next = n >= LAST ? 0 : n + 1;
        setStep(next);
        run(next);
      }, plan[n]);
    };
    run(0);
    return () => window.clearTimeout(t);
  }, []);
  const long = r.m?.long ?? r.h.price;
  const cost = long * HOURS;
  const fields = [
    { label: "From", chip: "Claude", dot: s.live },
    { label: "Trade", chip: `Long ${HOURS} GPU-hours` },
    { label: "Market", chip: `H100, ${r.month}` },
    { label: "Cost", chip: usd(Math.round(cost)).replace(/\.00$/, "") },
    { label: "Your limit", chip: `Over your $${LIMIT} limit`, dot: s.warn },
  ];
  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav />
      <div className={s.body}>
        <div className={s.copy}>
          <Rotator sides={r.sides} index={i} className={s.h1} qClass={s.q} />
          <p className={s.core}>{CORE}</p>
          <Cta />
        </div>
        <div className={s.stage} data-step={step} aria-label={`Claude asks to go Long ${HOURS} GPU-hours of H100 ${r.month}, ${usd(cost)}, over your $${LIMIT} limit; you approve with your passkey`}>
          <div className={s.sheet} aria-hidden>
            <span className={s.sheetTitle}>Trade request</span>
            {fields.map((f) => (
              <div key={f.label} className={s.field}>
                <span>{f.label}</span>
                <i />
              </div>
            ))}
          </div>
          {/* the chips ride a layer laid out exactly like the form (unblurred), so each lands on its own field */}
          <div className={s.lay} aria-hidden>
            <span className={s.laySpacer} />
            {fields.map((f, n) => (
              <div key={f.label} className={s.layRow}>
                <span className={s.chip} data-on={step > n ? "" : undefined} style={{ "--x": ["0px", "36px", "14px", "52px", "20px"][n] } as CSSProperties}>
                  {f.dot ? <i className={f.dot} /> : <Spark />}
                  {f.chip}
                </span>
              </div>
            ))}
          </div>
          <span className={s.approve} data-on={step >= 6 ? "" : undefined} data-done={step >= 7 ? "" : undefined} aria-hidden>
            <span className={s.approveIdle}>
              <Key /> Approve with passkey
            </span>
            <span className={s.approveDone}>
              <svg viewBox="0 0 16 16" width="18" height="18">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Approved
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}

function Spark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path d="M8 1.5l1.3 4.2 4.2 1.3-4.2 1.3L8 12.5 6.7 8.3 2.5 7l4.2-1.3z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function Key() {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden>
      <circle cx="5.5" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8.5 8h6M12.5 8v2.5M14.5 8v1.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
