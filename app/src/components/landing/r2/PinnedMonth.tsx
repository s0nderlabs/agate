"use client";
// How it works, as one object (Plasma's pinned Spend / Earn / Send, with next month's market in place of their phone):
// the November card stays put while three steps scroll past; each step lights its part of the card (the Long price,
// the Short price, the thirty days). On a phone the steps become pills above the card.
import { useEffect, useRef, useState } from "react";
import { ContractObject } from "@/components/lab/ContractObject";
import { usd } from "@/lib/format";
import type { R2 } from "./parts";
import s from "./r2.module.css";

type Focus = "long" | "short" | "daily";

export function PinnedMonth({ r }: { r: R2 }) {
  const m = r.m;
  const [focus, setFocus] = useState<Focus>("long");
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const steps: { key: Focus; pill: string; h: string; p: string }[] = [
    { key: "long", pill: "Paying for GPUs", h: "Lock in what you pay.", p: m ? `Go Long at ${usd(m.long)} an hour. If ${m.name}'s price rises, your Long rises with it.` : "" },
    { key: "short", pill: "Renting out GPUs", h: "Lock in what you earn.", p: m ? `Go Short at ${usd(m.short)} an hour. If the price falls, your Short gains.` : "" },
    { key: "daily", pill: "Paid daily", h: "Get paid every day.", p: m ? `${m.name} settles one day at a time. Choose daily pay and each day's share lands the next morning.` : "" },
  ];
  useEffect(() => {
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) if (e.isIntersecting) setFocus((e.target as HTMLElement).dataset.key as Focus);
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);
  if (!m) return null;
  return (
    <section className={s.pinned} aria-label="How it works">
      <div className={s.pinSteps}>
        {steps.map((st, i) => (
          <div key={st.key} ref={(el) => void (refs.current[i] = el)} data-key={st.key} className={`${s.pinStep} ${focus === st.key ? s.pinOn : ""}`}>
            <h2>{st.h}</h2>
            <p>{st.p}</p>
          </div>
        ))}
      </div>
      <div className={s.pinStage}>
        <div className={s.pinPills} role="tablist" aria-label="How it works">
          {steps.map((st) => (
            <button key={st.key} role="tab" aria-selected={focus === st.key} className={focus === st.key ? s.pillOn : s.pill} onClick={() => setFocus(st.key)}>
              {st.pill}
            </button>
          ))}
        </div>
        <ContractObject g={r.h} focus={focus} />
        <p className={s.pinNow}>{steps.find((x) => x.key === focus)?.p}</p>
      </div>
    </section>
  );
}
