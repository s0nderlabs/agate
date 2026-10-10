"use client";
// Public's grammar: a light editorial page, a big serif headline with the facts and one button under it, then the
// product on a laptop and a phone in a dark, spotlit stage; the GPUs as a big serif row.
import { Close, Doors, Gpus, How, Proof, Why } from "../blocks";
import { COPY, Cta, Footer, LNav, MiniApp, PhoneApp, Stone, useLive } from "../kit";
import s from "./public.module.css";

export function PublicStage() {
  const live = useLive();
  return (
    <div className={s.page}>
      <LNav />
      <section className={s.hero}>
        <h1 className={`${s.title} font-display`}>
          {COPY.titleLines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </h1>
        <div className={s.heroRow}>
          <ul className={s.facts}>
            {COPY.facts.map((f) => (
              <li key={f}>
                <Stone size={18} />
                {f}
              </li>
            ))}
          </ul>
          <Cta />
        </div>
      </section>
      <section className={s.stage} aria-label="The app">
        <div className={s.spot} />
        <div className={s.laptop}>
          <MiniApp live={live} />
          <div className={s.base} />
        </div>
        <PhoneApp live={live} className={s.phone} />
      </section>
      <Gpus c={s} live={live} />
      <Why c={s} />
      <How c={s} />
      <Doors c={s} />
      <div className={`tone-dark ${s.dark}`}>
        <Proof c={s} live={live} />
      </div>
      <Close c={s} />
      <Footer />
    </div>
  );
}
