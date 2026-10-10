"use client";
// Hero 5, "Six prices in glass" (Wealthsimple's frosted candles, Robinhood Legend's chrome): today's price of each of the
// six GPUs as a column of frosted glass, cheapest to dearest, rising when the page opens, a softbox drifting across them.
// The asset lab's glass columns (the strongest one), given the whole first screen.
import { GlassColumns } from "@/components/lab/GlassColumns";
import { CORE, Cta, Nav, Rotator, k, useHero, useSide } from "./kit";
import s from "./h05.module.css";

export function H05Glass() {
  const r = useHero();
  const i = useSide(r.sides.length);
  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav />
      <div className={s.body}>
        <div className={s.copy}>
          <Rotator sides={r.sides} index={i} className={s.h1} qClass={s.q} />
          <div className={s.side}>
            <p className={s.core}>{CORE} One open price for an hour of each GPU, read every day from the clouds that rent it.</p>
            <Cta />
          </div>
        </div>
        <div className={s.glass}>{r.ready && <GlassColumns data={r.gpus} dark={false} />}</div>
      </div>
    </section>
  );
}
