"use client";
// Apple Card's grammar: a soft wash of color, one bold centered statement and one button, and one object rising out
// of the bottom: here your position, made a physical card with the agate's bands in it. After that, one idea per
// screen, each with one number.
import { Close, Doors, Proof } from "../blocks";
import { AgateSlice, COPY, Cta, Footer, LNav, P, Stone, useLive } from "../kit";
import s from "./card.module.css";

export function OneCard() {
  const live = useLive();
  return (
    <div className={s.page}>
      <section className={s.wash}>
        <LNav />
        <div className={s.hero}>
          <Stone size={56} />
          <h1 className={s.title}>
            <span>The price of compute.</span>
            <span>Made tradable.</span>
          </h1>
          <Cta />
        </div>
        <div className={s.cardStage}>
          <div className={s.card} aria-label={`A Long position on H100 ${live.month}`}>
            <AgateSlice className={s.cardArt} />
            <div className={s.cardTop}>
              <span className={s.cardName}>H100 · {live.month}</span>
              <span className={s.cardSide}>Long</span>
            </div>
            <div className={s.cardBottom}>
              <span className={s.cardBig}>720 GPU-hours</span>
              <span>
                Bought at <P v={live.long} />
              </span>
            </div>
          </div>
        </div>
      </section>
      <section className={s.beat}>
        <span className={s.beatNum}>2×</span>
        <h2 className={s.beatTitle}>{COPY.why.title}</h2>
        <p className={s.beatText}>{COPY.why.text}</p>
      </section>
      {COPY.how.map((h, i) => (
        <section key={h.t} className={`${s.beat} ${i % 2 ? s.beatAlt : ""}`}>
          <span className={s.beatNum}>{[<P key="p" v={live.price} />, live.month.slice(0, 3), "100%", "Daily"][i]}</span>
          <h2 className={s.beatTitle}>{h.t}</h2>
          <p className={s.beatText}>{h.d}</p>
        </section>
      ))}
      <Doors c={s} />
      <Proof c={s} live={live} />
      <Close c={s} />
      <Footer />
    </div>
  );
}
