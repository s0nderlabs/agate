"use client";
// Variant A, Public's grammar: a light editorial page led by one serif sentence, the product staged
// on a dark spotlit stage (chart as the screen, the trade box as the object in front of it).
import { useMock } from "@/lib/mock/store";
import { GPUS } from "@/lib/mock/data";
import type { Gpu, Market } from "@/lib/mock/types";
import { usd } from "@/lib/format";
import { AppNav, Compare, SourceStrip, TradeTicket, carriedNote, priceChange, reportingLine } from "./Parts";
import { PriceChart, monthName } from "./PriceChart";
import { useTrade } from "./useTrade";
import s from "./VariantEditorial.module.css";

export function VariantEditorial({ market }: { market: Market }) {
  const { config, setConfig } = useMock();
  const trade = useTrade(market);
  const nov = trade.n.series;
  const ch = priceChange(market);
  const carried = carriedNote(market);
  const loading = config.data === "loading";
  return (
    <div className={`${s.root} ${loading ? "is-loading" : ""}`}>
      <AppNav />
      <section className={s.hero}>
        <div className={s.assets} role="group" aria-label="GPU">
          {GPUS.map((g) => (
            <button key={g} aria-pressed={config.gpu === g} onClick={() => setConfig({ gpu: g as Gpu })}>
              {g}
            </button>
          ))}
        </div>
        <h1 className={s.display}>
          An hour of {market.gpu} costs <span className="ag-skel">{usd(market.price)}</span> today.
        </h1>
        <div className={s.heroRow}>
          <ul className={s.chips}>
            <li>
              <i className={s.dot} />
              {reportingLine(market)}
            </li>
            <li style={{ color: ch.cls === "text-down" ? "var(--down)" : ch.cls ? "var(--up)" : undefined }}>{carried ?? ch.text}</li>
            <li>
              {monthName(nov.month)} trades at {usd(nov.quote?.last ?? 0)}
            </li>
          </ul>
          <a className="ag-btn ag-btn--primary ag-btn--lg" href="#trade">
            Trade {monthName(nov.month)}
          </a>
        </div>
      </section>

      <section id="trade" className={`${s.stage} tone-dark`}>
        <div className={s.stageGrid}>
          <div className={s.screen}>
            <div className={s.screenHead}>
              <b>Today, and what {monthName(nov.month)} pays</b>
              <span>The shaded band is {monthName(nov.month)}'s floor and ceiling.</span>
            </div>
            <div className={s.chartFill}>
              <PriceChart market={market} series={nov} height="fill" />
            </div>
            <p className={s.note}>History before Sep 30 is example data. Our own record starts Sep 30.</p>
          </div>
          <div className={`${s.ticket} tone-light`}>
            <TradeTicket market={market} trade={trade} />
          </div>
        </div>
      </section>

      <section className={s.columns}>
        <div className={s.col}>
          <h2 className={s.h2}>Where the price comes from</h2>
          <p className={s.lede}>Five clouds post an on-demand {market.gpu} price every day. We read each page, and the middle price becomes the index.</p>
          <SourceStrip market={market} />
        </div>
        <div className={s.col}>
          <h2 className={s.h2}>Three prices for the same hour</h2>
          <p className={s.lede}>Ours is posted and onchain. The other two are traded prices we show for context.</p>
          <Compare market={market} big={40} />
        </div>
      </section>
    </div>
  );
}
