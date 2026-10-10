"use client";
// SF Compute's and Computable's grammar: the proof comes first. Paper, editorial type, today's price shown as a
// receipt (each cloud's read, the middle one marked, the date it went onchain), then a worked example: one Long, three
// ways November could end, the money each way. The math is the page's own (gain = (average − price) × hours).
import { Doors, How, Proof } from "../blocks";
import { COPY, Cta, Footer, IndexLink, LNav, P, useLive } from "../kit";
import s from "./ledger.module.css";

const HOURS = 720;

export function Ledger() {
  const live = useLive();
  const p = live.long || live.price;
  const ends = [Math.round((p * 0.85) * 100) / 100, p, Math.round((p * 1.2) * 100) / 100];
  const money = (a: number) => Math.round((Math.min(Math.max(a, live.floor || 0), live.cap || a) - p) * HOURS);
  const signed = (n: number) => (n === 0 ? "$0" : `${n > 0 ? "+" : "−"}$${Math.abs(n).toLocaleString("en-US")}`);
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
        <figure className={s.receipt} aria-label="How today's H100 price was set">
          <figcaption className={s.rHead}>
            <span>H100 index{live.date ? `, ${live.date}` : ""}</span>
            <span>Onchain about 07:00 UTC</span>
          </figcaption>
          <ol className={s.rows}>
            {live.clouds.map((c) => (
              <li key={c.name} className={c.mid ? s.mid : undefined}>
                <span>{c.name}</span>
                <span className={s.dots} aria-hidden="true" />
                <span>
                  <P v={c.price} />
                </span>
              </li>
            ))}
          </ol>
          <div className={s.total}>
            <span>The middle price sets the day</span>
            <span className={`${s.totalNum} font-display`}>
              <P v={live.price} />
            </span>
          </div>
        </figure>
      </section>
      <section className={s.example}>
        <h2 className={`${s.exTitle} font-display`}>
          Say you go Long {HOURS} GPU-hours of {live.month} at <P v={p} />.
        </h2>
        <p className={s.exLead}>That is about one GPU for the whole month. Here is what you get back, three ways {live.month} could end.</p>
        <ol className={s.outcomes}>
          {ends.map((a, i) => (
            <li key={i} className={s.outcome}>
              <span className={s.oLabel}>{["If it averages less", "If it stays put", "If it averages more"][i]}</span>
              <span className={`${s.oAvg} font-display`}>
                <P v={a} />
              </span>
              <span className={`${s.oMoney} ${money(a) > 0 ? s.up : money(a) < 0 ? s.down : ""}`}>{signed(money(a))}</span>
            </li>
          ))}
        </ol>
        <p className={s.exNote}>
          The most you can lose is <b>{signed(-Math.round((p - (live.floor || 0)) * HOURS))}</b>, if {live.month} averages the floor or below. The most you can make is{" "}
          <b>{signed(Math.round(((live.cap || p) - p) * HOURS))}</b>, at the ceiling or above. No fees on testnet.
        </p>
      </section>
      <How c={s} />
      <Doors c={s} />
      <Proof c={s} live={live} />
      <section className={s.close}>
        <h2 className={`${s.closeTitle} font-display`}>{COPY.close.title}</h2>
        <p className={s.closeText}>{COPY.close.text}</p>
        <Cta />
      </section>
      <Footer />
    </div>
  );
}
