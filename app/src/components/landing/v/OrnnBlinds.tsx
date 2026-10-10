"use client";
// Ornn's grammar on a light ground (the open territory): paper with soft daylight falling through blinds, the
// headline on the left, the index number on the right under one thick ink rule, its time beneath. Every section
// opens on the same thick rule, the way Ornn's do, and the GPUs read like a price board.
import { Close, Doors, How, Proof, Why } from "../blocks";
import { COPY, Change, Cta, Footer, GpuPrice, IndexLink, LNav, P, useLive } from "../kit";
import s from "./blinds.module.css";

export function OrnnBlinds() {
  const live = useLive();
  return (
    <div className={s.page}>
      <section className={s.hero}>
        <div className={s.light} aria-hidden="true" />
        <LNav float />
        <div className={s.heroGrid}>
          <div className={s.left}>
            <h1 className={s.title}>{COPY.title}</h1>
            <p className={s.lead}>{COPY.lead}</p>
            <div className={s.acts}>
              <Cta />
              <IndexLink />
            </div>
          </div>
          <div className={s.right}>
            <span className={s.numLabel}>H100 index, one GPU-hour</span>
            <span className={`${s.big} font-display`}>
              <P v={live.price} />
            </span>
            <Change v={live.change} />
          </div>
        </div>
      </section>
      <section className={s.board} aria-label="Every GPU's price today">
        {live.gpus.map((g) => (
          <div key={g.g} className={s.cell}>
            <span className={s.cellName}>{g.g}</span>
            <span className={`${s.cellPrice} font-display`}>
              <GpuPrice v={g.price} />
            </span>
            <span className={s.cellNote}>{g.tradable ? `Long or Short ${live.month}` : "Price only, for now"}</span>
          </div>
        ))}
      </section>
      <Why c={s} />
      <How c={s} />
      <Doors c={s} />
      <Proof c={s} live={live} />
      <Close c={s} />
      <Footer />
    </div>
  );
}
