"use client";
// Agate's own: the stone in daylight (the Oct 3 proposal). A light page, an agate slice lit from behind as the one
// object, today's price on a small plaque beside it like a museum label; then one dark band where the same stone
// sits at night beside how it works.
import { Close, Doors, Proof, Why } from "../blocks";
import { AgateSlice, COPY, Change, Cta, Footer, IndexLink, LNav, P, useLive } from "../kit";
import s from "./stone.module.css";

export function StoneDaylight() {
  const live = useLive();
  return (
    <div className={s.page}>
      <LNav />
      <section className={s.hero}>
        <div className={s.copy}>
          <h1 className={`${s.title} font-display`}>{COPY.title}</h1>
          <p className={s.lead}>{COPY.lead}</p>
          <div className={s.acts}>
            <Cta />
            <IndexLink />
          </div>
        </div>
        <div className={s.object}>
          <div className={s.glow} aria-hidden="true" />
          <AgateSlice className={s.slice} />
          <div className={s.plaque}>
            <span>H100, one GPU-hour{live.date ? `, ${live.date}` : ""}</span>
            <span className={`${s.plaqueNum} font-display`}>
              <P v={live.price} />
            </span>
            <Change v={live.change} />
          </div>
        </div>
      </section>
      <Why c={s} />
      <section className={`tone-dark ${s.band}`}>
        <div className={s.bandInner}>
          <AgateSlice className={s.nightSlice} tone="night" lit={false} />
          <div>
            <h2 className={`${s.bandTitle} font-display`}>How it works</h2>
            <ol className={s.steps}>
              {COPY.how.map((h, i) => (
                <li key={h.t}>
                  <span className={`${s.stepNum} font-display`}>{i + 1}</span>
                  <div>
                    <h3>{h.t}</h3>
                    <p>{h.d}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>
      <Doors c={s} />
      <Proof c={s} live={live} />
      <Close c={s} />
      <Footer />
    </div>
  );
}
