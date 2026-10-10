"use client";
// Public's product grammar, turned up: a dark room, one light from above, and the live H100 price standing in it as
// the object (a big light number, a small colored change, a thin line). The sides sit under it with their prices
// inside the buttons; the clouds that make the price follow as one big serif list.
import Link from "next/link";
import { Close, Clouds, Doors, How, Proof } from "../blocks";
import { COPY, Change, Footer, LNav, P, PriceLine, useLinks, useLive } from "../kit";
import s from "./spot.module.css";

export function PublicSpot() {
  const live = useLive();
  const l = useLinks();
  return (
    <div className={s.page}>
      <div className={`tone-dark ${s.room}`}>
        <LNav />
        <div className={s.beam} aria-hidden="true" />
        <section className={s.hero}>
          <h1 className={`${s.title} font-display`}>{COPY.title}</h1>
          <p className={s.lead}>{COPY.lead}</p>
          <div className={s.object}>
            <span className={s.objLabel}>One H100 hour, today</span>
            <span className={`${s.big} font-display`}>
              <P v={live.price} />
            </span>
            <Change v={live.change} />
          </div>
          <PriceLine values={live.history} className={s.line} />
          <div className={s.sides}>
            <Link href={l.market} className={s.long}>
              Long {live.month} at <P v={live.long} />
            </Link>
            <Link href={l.market} className={s.short}>
              Short {live.month} at <P v={live.short} />
            </Link>
          </div>
        </section>
      </div>
      <section className={s.cloudsWrap}>
        <h2 className={`${s.cloudsTitle} font-display`}>Where today's price comes from</h2>
        <p className={s.cloudsText}>Each cloud's own on-demand H100 price. The middle one sets the day, so no single cloud can move it.</p>
        <Clouds c={s} live={live} />
      </section>
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
