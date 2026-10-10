"use client";
// "Your AI trades, you hold the limit" (asset lab, round 2): one real flow, told by the product's own pieces. The AI
// asks over Agate's connection (the tool names are the real ones), its pocket shows the limit it works within, the trade
// goes over it, and the person's approval sheet decides. Live price, the app's own words.
// After Public's agent pipeline (prompt, agent card, account card, wired) and Kraken's agent CLI card.
import { useEffect, useRef, useState } from "react";
import { usd } from "@/lib/format";
import type { LabGpu } from "./data";
import { stillMode } from "./data";
import s from "./lab.module.css";

const HOURS = 200;
const CAP = 500;
const BUDGET = 2000;
const STEPS = 6;

export function AgentFlow({ g }: { g: LabGpu }) {
  const ref = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stillMode()) {
      setStep(STEPS - 1);
      return;
    }
    let timer = 0;
    const io = new IntersectionObserver(([e]) => {
      window.clearInterval(timer);
      if (e.isIntersecting) timer = window.setInterval(() => setStep((x) => (x + 1) % (STEPS + 1)), 1700);
    }, { threshold: 0.35 });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearInterval(timer);
    };
  }, []);
  const m = g.month;
  if (!m) return null;
  const cost = Math.round(HOURS * m.long);
  const at = (n: number) => (step >= n ? s.on : "");
  return (
    <div ref={ref} className={s.flow} data-step={step}>
      <div className={`${s.node} ${at(0)}`}>
        <span className={s.nodeWho}>Claude</span>
        <p className={s.say}>
          Go Long {HOURS} GPU-hours of {g.gpu} {m.name}. Pay me daily.
        </p>
        <div className={`${s.call} ${at(1)}`}>
          <code>quote</code>
          <span>
            {usd(m.long)} an hour, {usd(cost, 0)}
          </span>
        </div>
        <div className={`${s.call} ${at(2)}`}>
          <code>request_approval</code>
          <span>over its limit</span>
        </div>
      </div>

      <i className={`${s.wire} ${at(2)}`} aria-hidden />

      <div className={`${s.node} ${at(2)}`}>
        <span className={s.nodeWho}>Claude&apos;s pocket</span>
        <dl className={s.limits}>
          <div>
            <dt>Budget</dt>
            <dd>{usd(BUDGET, 0)}</dd>
          </div>
          <div>
            <dt>Most on one trade</dt>
            <dd>{usd(CAP, 0)}</dd>
          </div>
          <div className={step >= 2 ? s.over : ""}>
            <dt>This trade</dt>
            <dd>{usd(cost, 0)}</dd>
          </div>
        </dl>
        <span className={s.nodeNote}>Payouts go to your main account</span>
      </div>

      <i className={`${s.wire} ${at(3)}`} aria-hidden />

      <div className={`${s.node} ${s.sheet} ${at(3)}`}>
        <span className={s.nodeWho}>{step >= 5 ? "Done" : step >= 4 ? "Placing your order" : "An AI wants to go over its limit"}</span>
        <p className={s.sheetLine}>
          Long {HOURS} GPU-hours, {g.gpu} {m.name}
        </p>
        <p className={s.sheetLine}>
          {usd(m.long)} an hour, {usd(cost, 0)}, paid daily
        </p>
        <span className={`${s.approve} ${step >= 4 ? s.approved : ""}`}>{step >= 5 ? "Approved" : step >= 4 ? "From your account on Monad, about 6 seconds" : "Approve with passkey"}</span>
      </div>
    </div>
  );
}
