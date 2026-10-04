"use client";
// Variant C, Ornn's grammar on paper: a statement on the left, one giant number on the right under a
// thick rule with its timestamp, a wide quiet chart, and the trade box as a drawer.
import { useEffect, useState } from "react";
import { useMock } from "@/lib/mock/store";
import type { Market } from "@/lib/mock/types";
import { usd } from "@/lib/format";
import { AppNav, Compare, GpuSwitch, SourceStrip, TradeTicket, carriedNote, priceChange, reportingLine } from "./Parts";
import { PriceChart, monthName } from "./PriceChart";
import { useTrade } from "./useTrade";
import s from "./VariantStatement.module.css";

export function VariantStatement({ market }: { market: Market }) {
  const { config } = useMock();
  const trade = useTrade(market);
  const [drawer, setDrawer] = useState(false);
  const nov = trade.n.series;
  const m = monthName(nov.month);
  const ch = priceChange(market);
  const carried = carriedNote(market);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`${s.root} ${config.data === "loading" ? "is-loading" : ""}`}>
      <AppNav />
      <section className={s.split}>
        <div className={s.statement}>
          <GpuSwitch />
          <h1 className={s.h1}>The open price of an {market.gpu} hour.</h1>
          <p className={s.lede}>
            Five clouds post what an hour of {market.gpu} costs. The middle price goes onchain every day, and each month trades as one token you can go long or short.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <button className="ag-btn ag-btn--primary ag-btn--lg" onClick={() => setDrawer(true)}>
              Trade {m}
            </button>
            <a className="ag-btn ag-btn--ghost ag-btn--lg" href="#sources">
              How the price is made
            </a>
          </div>
        </div>
        <div className={s.figure}>
          <div className={s.rule} />
          <div className={s.meta}>
            <span>{market.gpu} index price</span>
            <span>Final Oct 3, 07:00 UTC</span>
          </div>
          <b className={`${s.big} font-display ag-skel`}>{usd(market.price)}</b>
          <div className={s.sub}>
            <span style={{ color: carried ? "var(--mute)" : ch.cls === "text-down" ? "var(--down)" : ch.cls ? "var(--up)" : undefined }}>{carried ?? ch.text}</span>
            <span>{reportingLine(market)}</span>
          </div>
          <dl className={s.band}>
            <div>
              <dt>{m} floor</dt>
              <dd className="font-display">{usd(nov.floor)}</dd>
            </div>
            <div>
              <dt>{m} trades at</dt>
              <dd className="font-display">{usd(nov.quote?.last ?? 0)}</dd>
            </div>
            <div>
              <dt>{m} ceiling</dt>
              <dd className="font-display">{usd(nov.cap)}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className={s.ribbon}>
        <PriceChart market={market} series={nov} height="clamp(240px, 30vw, 400px)" />
        <p className={s.note}>History before Sep 30 is example data. Our own record starts Sep 30.</p>
      </section>

      <section id="sources" className={s.cols}>
        <div className="grid gap-3 content-start min-w-0">
          <h2 className={s.h2}>Where it comes from</h2>
          <SourceStrip market={market} />
        </div>
        <div className="grid gap-3 content-start min-w-0">
          <h2 className={s.h2}>Beside other prices</h2>
          <Compare market={market} big={38} />
        </div>
      </section>

      <div className={s.scrim} data-open={drawer} onClick={() => setDrawer(false)} />
      <aside className={`${s.drawer} tone-light`} data-open={drawer} inert={!drawer} aria-label="Trade">
        <div className={s.drawerHead}>
          <div>
            <b>
              {market.gpu}, {m} 2026
            </b>
            <span>Pays the month's average price</span>
          </div>
          <button className="ag-btn ag-btn--soft" onClick={() => setDrawer(false)}>
            Close
          </button>
        </div>
        <div className={s.drawerPrice}>
          <b className="font-display">{usd(trade.n.price)}</b>
          <span>per GPU-hour, the market's price for {m}</span>
        </div>
        <TradeTicket market={market} trade={trade} />
      </aside>
    </div>
  );
}
