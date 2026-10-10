"use client";
// Hero 4, "The month" (Apple Card's one object, its colour flooding the page): what you actually trade on Agate, one
// GPU's month, made into a card you could hold. Brushed white metal, engraved with the month, its band and today's
// price; it leans toward the pointer and catches the light. The page takes its colour from the card's blue.
import { useRef, type CSSProperties, type PointerEvent } from "react";
import { Lockup } from "@/components/brand/Logo";
import { CORE, Cta, Nav, Rotator, k, useEntered, useHero, useSide, usd } from "./kit";
import s from "./h04.module.css";

export function H04Card() {
  const r = useHero();
  const i = useSide(r.sides.length);
  const on = useEntered(150);
  const card = useRef<HTMLDivElement>(null);
  const m = r.m;
  const year = m ? m.month.slice(0, 4) : "";
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const el = card.current;
    if (!el || e.pointerType === "touch") return;
    const b = el.getBoundingClientRect();
    const x = (e.clientX - b.left) / b.width, y = (e.clientY - b.top) / b.height;
    el.style.setProperty("--rx", `${((0.5 - y) * 12).toFixed(2)}deg`);
    el.style.setProperty("--ry", `${((x - 0.5) * 16).toFixed(2)}deg`);
    el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
  };
  const leave = () => {
    const el = card.current;
    if (!el) return;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
    el.style.setProperty("--mx", "30%");
    el.style.setProperty("--my", "20%");
  };
  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav />
      <div className={s.body}>
        <Rotator sides={r.sides} index={i} className={s.h1} qClass={s.q} />
        <p className={s.core}>{CORE}</p>
        <div className={s.scene} onPointerMove={move} onPointerLeave={leave} data-on={on ? "" : undefined}>
          <div ref={card} className={s.card} style={{ "--rx": "0deg", "--ry": "0deg", "--mx": "30%", "--my": "20%" } as CSSProperties}>
            <div className={s.face}>
              <div className={s.top}>
                <span className={s.gpu}>H100</span>
                <span className={s.mark}>
                  <Lockup height={22} wcase="title" />
                </span>
              </div>
              <div className={s.mid}>
                <span className={s.price}>{usd(m?.long ?? r.h.price)}</span>
                <span className={s.per}>an hour, if you lock it in today</span>
              </div>
              <div className={s.bottom}>
                <span className={s.month}>
                  {m?.name ?? "November"} {year}
                </span>
                <span className={s.band}>{m ? `Settles between ${usd(m.floor)} and ${usd(m.cap)}` : ""}</span>
              </div>
            </div>
            <span className={s.sheen} aria-hidden />
          </div>
          <span className={s.shadow} aria-hidden />
        </div>
        <Cta className={s.cta} />
      </div>
    </section>
  );
}
