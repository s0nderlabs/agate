"use client";
// Hero 2, "The counter" (Kalshi's rolling price, Ramp's odometer, made physical): warm paper, a centred serif headline,
// and a machined counter whose drums roll to each GPU's price of the day in turn. The price is the object.
import { useEffect, useState } from "react";
import { stillMode } from "@/components/lab/data";
import { CORE, Cta, Nav, Roll, Rotator, k, useHero, useSide, usd } from "./kit";
import s from "./h02.module.css";

export function H02Counter() {
  const r = useHero();
  const i = useSide(r.sides.length);
  const priced = r.gpus.filter((g) => g.price > 0);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (stillMode() || priced.length < 2) return;
    const t = window.setInterval(() => setN((x) => (x + 1) % priced.length), 3400);
    return () => window.clearInterval(t);
  }, [priced.length]);
  const g = priced[n % Math.max(1, priced.length)];
  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav />
      <div className={s.body}>
        <Rotator sides={r.sides} index={i} className={s.h1} qClass={s.q} />
        <p className={s.core}>{CORE}</p>
        <div className={s.machine} aria-live="polite">
          <div className={s.housing}>{g ? <Roll text={usd(g.price)} className={s.digits} drum={s.drum} delay={300} /> : null}</div>
          <div className={s.plate}>
            {priced.map((x, j) => (
              <span key={x.gpu} className={s.tab} data-on={j === n % priced.length ? "" : undefined}>
                {x.gpu}
              </span>
            ))}
          </div>
          <p className={s.caption}>An hour of {g?.gpu ?? "H100"} today, read from what the clouds charge.</p>
        </div>
        <Cta className={s.cta} />
      </div>
    </section>
  );
}
