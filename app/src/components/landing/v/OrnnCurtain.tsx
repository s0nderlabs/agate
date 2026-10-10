"use client";
// Ornn's grammar in agate's own light: a dark stage with a curtain of light (stone and quartz tones, not Ornn's
// copper), the headline low on the left, the index number owning the right half under one thick rule, its time right
// under it. Below, the chart is real data (Ornn's weak spot: a decorative chart).
import { Close, Doors, How, Proof } from "../blocks";
import { COPY, Change, Cta, Footer, IndexLink, LNav, P, PriceLine, useLive } from "../kit";
import s from "./curtain.module.css";

export function OrnnCurtain() {
  const live = useLive();
  return (
    <div className={`tone-dark ${s.page}`}>
      <section className={s.hero}>
        <div className={s.curtain} aria-hidden="true" />
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
            <span className={s.when}>A new price each day, final about 07:00 UTC</span>
          </div>
        </div>
      </section>
      <section className={s.chartSec}>
        <div className={s.chartBox}>
          <PriceLine values={live.history} className={s.chart} band={live.floor ? { floor: live.floor, cap: live.cap } : undefined} />
          <div className={s.axis}>
            <span>90 days ago</span>
            <span>Today</span>
          </div>
        </div>
        <div className={s.chartCopy}>
          <h2 className={`${s.chartTitle} font-display`}>H100, {live.month}</h2>
          <p>The dashed lines are {live.month}'s floor and ceiling. Long or Short, every trade settles between them, so both sides are paid for in full.</p>
          <p className={s.sides}>
            Long at <P v={live.long} />, Short at <P v={live.short} />
          </p>
        </div>
      </section>
      <How c={s} />
      <Doors c={s} />
      <Proof c={s} live={live} />
      <Close c={s} />
      <Footer className={s.foot} />
    </div>
  );
}
