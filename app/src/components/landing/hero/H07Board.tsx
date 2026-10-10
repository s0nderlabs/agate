"use client";
// Hero 7, "The board" (Robinhood's "Ready when you are": three watchlist rows cropped giant): black, the headline on
// the left, and the market itself on the right, every GPU's open price as a row so large the board runs off the page,
// drifting slowly upward like a departures board that never stops.
import type { CSSProperties } from "react";
import { CORE, Cta, Nav, Rotator, k, moveText, useHero, useSide, useStill, usd } from "./kit";
import s from "./h07.module.css";

export function H07Board() {
  const r = useHero();
  const i = useSide(r.sides.length);
  const still = useStill();
  const rows = r.gpus.filter((g) => g.price > 0);
  const row = (key: string, hidden: boolean) =>
    rows.map((g, n) => (
      <div key={`${key}${g.gpu}`} className={s.row} aria-hidden={hidden || undefined} style={{ "--n": n } as CSSProperties}>
        <span className={s.gpu}>{g.gpu}</span>
        <span className={s.price}>{usd(g.price)}</span>
        <span className={g.change > 0 ? s.up : g.change < 0 ? s.down : s.flat}>{Math.round(g.change * 100) === 0 ? "0.00" : moveText(g.change)}</span>
      </div>
    ));
  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav dark />
      <div className={s.body}>
        <div className={s.copy}>
          <Rotator sides={r.sides} index={i} className={s.h1} qClass={s.q} />
          <p className={s.core}>{CORE}</p>
          <Cta />
        </div>
        <div className={s.board} aria-label={rows.map((g) => `${g.gpu} ${usd(g.price)} an hour`).join(", ")}>
          <div className={s.track} style={still ? { animation: "none" } : undefined}>
            {row("a", false)}
            {row("b", true)}
          </div>
        </div>
      </div>
    </section>
  );
}
