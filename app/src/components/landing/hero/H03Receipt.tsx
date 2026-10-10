"use client";
// Hero 3, "The receipt" (Coinbase's "Trade successful" with its fee chip pulled out over the edge): a cool studio, the
// headline on the left, and on the right the one screen that proves it, the confirmation of a trade, which changes
// with the headline: a renter going Long, an owner going Short, a trader, an AI that asked first.
import type { CSSProperties } from "react";
import { CORE, Cta, Nav, Rotator, k, useEntered, useHero, useSide, usd } from "./kit";
import s from "./h03.module.css";

const HOURS = 200;

export function H03Receipt() {
  const r = useHero();
  const i = useSide(r.sides.length, 4600);
  const on = useEntered(200);
  const m = r.m;
  const long = m?.long ?? r.h.price, short = m?.short ?? r.h.price;
  const month = r.month;
  const cards = [
    { title: "You're Long", what: `${HOURS} GPU-hours of H100, ${month}`, at: long, chipA: `Price locked for ${month}`, chipB: "Backed in full" },
    { title: "You're Short", what: `${HOURS} GPU-hours of H100, ${month}`, at: short, chipA: `Income locked for ${month}`, chipB: "Backed in full" },
    { title: "You're Long", what: `${HOURS} GPU-hours of H100, ${month}`, at: long, chipA: "Close any time", chipB: "Backed in full" },
    { title: "Claude went Long", what: `${HOURS} GPU-hours of H100, ${month}`, at: long, chipA: "Approved with your passkey", chipB: "Within your limits" },
  ];
  return (
    <section className={`${k.hero} ${s.hero}`}>
      <Nav />
      <div className={s.body}>
        <div className={s.copy}>
          <Rotator sides={r.sides} index={i} className={s.h1} qClass={s.q} />
          <p className={s.core}>{CORE}</p>
          <Cta />
        </div>
        <div className={s.stage} data-on={on ? "" : undefined}>
          <div className={s.card}>
            <svg className={s.check} viewBox="0 0 80 80" aria-hidden>
              <circle cx="40" cy="40" r="40" />
              <path d="M25 41.5l10 10 20-22" pathLength={1} />
            </svg>
            <div className={s.lines}>
              {cards.map((c, n) => (
                <div key={n} className={s.swap} data-on={n === i ? "" : undefined} aria-hidden={n !== i}>
                  <b className={s.title}>{c.title}</b>
                  <span className={s.what}>{c.what}</span>
                  <dl className={s.rows}>
                    <div>
                      <dt>Locked at</dt>
                      <dd>{usd(c.at)} an hour</dd>
                    </div>
                    <div>
                      <dt>For {HOURS} GPU-hours</dt>
                      <dd>{usd(c.at * HOURS)}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
          </div>
          {cards.map((c, n) => (
            <span key={`a${n}`} className={`${s.chip} ${s.chipA}`} data-on={n === i && on ? "" : undefined} style={{ "--k": 0 } as CSSProperties}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <rect x="3.5" y="7" width="9" height="6.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M5.5 7V5.2a2.5 2.5 0 015 0V7" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
              {c.chipA}
            </span>
          ))}
          {cards.map((c, n) => (
            <span key={`b${n}`} className={`${s.chip} ${s.chipB}`} data-on={n === i && on ? "" : undefined} style={{ "--k": 1 } as CSSProperties}>
              <i className={s.ok} aria-hidden />
              {c.chipB}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
