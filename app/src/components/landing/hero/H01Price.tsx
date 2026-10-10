"use client";
// Hero 1, "The price" (Ornn's live number, Robinhood's dark): warm black, the headline on the left, and the one thing
// Agate makes, the price of an H100 hour, set as the biggest thing on the page on a thick rule. Its digits roll in.
// Under it, where that price comes from: what each cloud charges today on one scale, the price in the middle of them.
import type { CSSProperties } from "react";
import { CORE, Cta, Nav, Roll, Rotator, k, moveText, useEntered, useHero, useSide, usd } from "./kit";
import s from "./h01.module.css";

export function H01Price() {
  const r = useHero();
  const i = useSide(r.sides.length);
  const on = useEntered(900);
  const clouds = r.h.clouds;
  const lo = clouds[0]?.price ?? 0, hi = clouds[clouds.length - 1]?.price ?? 0;
  const pad = (hi - lo) * 0.06 || 0.1;
  const at = (p: number) => `${(((p - (lo - pad)) / (hi + pad - (lo - pad))) * 100).toFixed(2)}%`;
  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav dark />
      <div className={s.body}>
        <div className={s.copy}>
          <Rotator sides={r.sides} index={i} className={s.h1} qClass={s.q} />
          <p className={s.core}>{CORE}</p>
          <Cta />
        </div>
        <div className={s.price}>
          <div className={s.rule}>
            <span>H100, an hour today</span>
            <span className={r.h.change > 0 ? s.up : r.h.change < 0 ? s.down : ""}>{moveText(r.h.change)} since yesterday</span>
          </div>
          <div className={s.num}>{r.h.price > 0 ? <Roll text={usd(r.h.price)} delay={250} /> : <span>&nbsp;</span>}</div>
          {clouds.length > 1 && (
            <div className={s.scale} data-on={on ? "" : undefined} aria-label={`What ${clouds.length} clouds charge for an H100 hour today, from ${usd(lo)} to ${usd(hi)}; Agate's price is ${usd(r.h.price)}`}>
              <div className={s.track}>
                {clouds.map((c, n) => (
                  <span key={c.name} className={s.tick} style={{ left: at(c.price), "--n": n } as CSSProperties} />
                ))}
                <span className={s.mark} style={{ left: at(r.h.price) }} />
              </div>
              <div className={s.ends}>
                <span>
                  {clouds[0].name} <b>{usd(lo)}</b>
                </span>
                <span>
                  {clouds[clouds.length - 1].name} <b>{usd(hi)}</b>
                </span>
              </div>
            </div>
          )}
          <p className={s.foot}>The middle of what {clouds.length || "the"} clouds charge, read every morning.</p>
        </div>
      </div>
    </section>
  );
}
