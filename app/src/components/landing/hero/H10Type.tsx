"use client";
// Hero 10, "The sentence" (Teenage Engineering's and Linear's type as the image): warm paper, one enormous flush-left
// sentence that carries the live price inside it, a full-width rule, and the four sides of the headline set out as four
// columns under it, each lit in turn.
import type { CSSProperties } from "react";
import { CORE, Cta, Nav, Roll, k, useEntered, useHero, useSide, usd } from "./kit";
import s from "./h10.module.css";

export function H10Type() {
  const r = useHero();
  const i = useSide(r.sides.length, 3600);
  const on = useEntered(100);
  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav />
      <div className={s.body}>
        <h1 className={s.h1} data-on={on ? "" : undefined} aria-label={`An hour of H100 costs ${usd(r.h.price)} today. Trade it.`}>
          <span className={s.ln}>
            <span style={{ "--l": 0 } as CSSProperties}>An hour of H100</span>
          </span>
          <span className={s.ln}>
            <span style={{ "--l": 1 } as CSSProperties}>
              costs <span className={s.price}>{r.h.price > 0 ? <Roll text={usd(r.h.price)} delay={500} /> : " "}</span> today.
            </span>
          </span>
          <span className={s.ln}>
            <span style={{ "--l": 2 } as CSSProperties} className={s.dim}>
              Trade it.
            </span>
          </span>
        </h1>
        <div className={s.foot}>
          <div className={s.lead}>
            <p>{CORE}</p>
            <Cta />
          </div>
          <ol className={s.sides}>
            {r.sides.map((x, n) => (
              <li key={x.key} data-on={n === i ? "" : undefined} style={{ "--t": "3600ms" } as CSSProperties}>
                <span className={s.bar} aria-hidden />
                <span className={s.sq}>{x.q}</span>
                <span className={s.sa}>{x.a}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
