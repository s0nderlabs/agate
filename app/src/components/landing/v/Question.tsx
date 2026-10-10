"use client";
// Kalshi's and Polymarket's grammar: the market is the hero. A question, today's number, the month's floor and
// ceiling drawn on the line with a plain-words flag, and the price inside each button. Then the other markets as
// cards, and the settlement rule as a designed card, not a footnote.
import Link from "next/link";
import { Doors, How, Proof } from "../blocks";
import { COPY, Cta, Footer, GpuPrice, LNav, P, PriceLine, useLinkQueryHref, useLive } from "../kit";
import s from "./question.module.css";

export function Question() {
  const live = useLive();
  const href = useLinkQueryHref();
  return (
    <div className={s.page}>
      <LNav />
      <section className={s.hero}>
        <div className={s.copy}>
          <h1 className={`${s.title} font-display`}>{COPY.title}</h1>
          <p className={s.lead}>{COPY.lead}</p>
          <ul className={s.facts}>
            {COPY.facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
        <article className={s.market} aria-label={`H100 ${live.month} market`}>
          <h2 className={s.q}>What will an H100 hour cost in {live.month}?</h2>
          <div className={s.now}>
            <span className={`${s.big} font-display`}>
              <P v={live.last} />
            </span>
            <span className={s.nowText}>
              The market's price for {live.month} now. Today's index is <P v={live.price} />.
            </span>
          </div>
          <div className={s.chartWrap}>
            <PriceLine values={live.history.slice(-60)} className={s.chart} band={live.floor ? { floor: live.floor, cap: live.cap } : undefined} />
            <span className={s.flag}>
              Settles between <P v={live.floor} /> and <P v={live.cap} />
            </span>
          </div>
          <div className={s.sides}>
            <Link href={href("/")} className={s.long}>
              Long at <P v={live.long} />
            </Link>
            <Link href={href("/")} className={s.short}>
              Short at <P v={live.short} />
            </Link>
          </div>
        </article>
      </section>
      <section className={s.more}>
        <h2 className={`${s.moreTitle} font-display`}>Every GPU, every day</h2>
        <ul className={s.cards}>
          {live.gpus.map((g) => (
            <li key={g.g}>
              <Link href={href(g.tradable ? "/" : "/gpu-index")} className={s.card}>
                <span className={s.cardName}>{g.g}</span>
                <span className={`${s.cardPrice} font-display`}>
                  <GpuPrice v={g.price} />
                </span>
                <span className={s.cardNote}>{g.tradable ? `Trade ${live.month}` : "Price only, for now"}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section className={s.rule}>
        <h2 className={`${s.ruleTitle} font-display`}>How {live.month} settles</h2>
        <div className={s.ruleCard}>
          <p className={s.ruleText}>
            {live.month} settles on the average of its daily H100 prices, every day of the month. Each day's price is the middle of five clouds' on-demand prices, read every hour and written onchain about 07:00 UTC.
          </p>
          <dl className={s.ruleRows}>
            <div>
              <dt>Source</dt>
              <dd>Agate's open index</dd>
            </div>
            <div>
              <dt>Floor and ceiling</dt>
              <dd>
                <P v={live.floor} /> and <P v={live.cap} />
              </dd>
            </div>
            <div>
              <dt>Hold to the end</dt>
              <dd>Collect what it pays once the month ends</dd>
            </div>
          </dl>
        </div>
      </section>
      <How c={s} />
      <Doors c={s} />
      <Proof c={s} live={live} />
      <section className={s.close}>
        <h2 className={`${s.closeTitle} font-display`}>{COPY.close.title}</h2>
        <Cta />
      </section>
      <Footer />
    </div>
  );
}
