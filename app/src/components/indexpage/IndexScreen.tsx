"use client";
// The Index page, first cut (Oct 3): where "5 of 5 clouds" on the trade screen leads. Holds the supporting data
// the trade screen no longer shows: today's readings and the price beside traded ones. Method, daily proof on
// Monad and history come when this page is designed properly.
import { useEffect, useMemo } from "react";
import { useMock } from "@/lib/mock/store";
import { groundFor } from "@/lib/mock/config";
import { useDataStatus, useMarkets, useScreenMarket } from "@/lib/data/hooks";
import { dateText, statusLine, timeText } from "@/lib/data/derive";
import { usd } from "@/lib/format";
import { MarketStrip, NavBar, Notice } from "@/components/shell/Shell";
import { PriceMap } from "@/components/trade/PriceMap";
import { Beside } from "@/components/trade/Insight";
import { NoData } from "@/components/trade/States";
import s from "./index.module.css";
import { BottomDock } from "@/components/shell/Dock";
import { useThemeColor } from "@/lib/ui/hooks";

export function IndexScreen() {
  const { config } = useMock();
  // the shared markets read (a neutral stand-in until it answers)
  const read = useScreenMarket(config.gpu);
  const market = read.market;
  // before the index's first final price: when it lands instead of a price
  const first = !read.missing && market.priceDate === null ? market.nextUpdateAt : null;
  // the read: on its way (skeletons), failed with nothing to show (the line and a retry), or the status line
  const loading = read.loading;
  const nodata = read.missing && !loading;
  const st = useDataStatus();
  const { markets } = useMarkets();
  const dark = config.theme === "dark";
  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config.theme]);
  useThemeColor(config.theme);
  return (
    <div className={`${s.screen} ${dark ? "tone-dark" : "tone-light"} ${loading ? "is-loading" : ""}`} data-phone={config.phone} aria-busy={loading || undefined}>
      <Notice status={statusLine(st, !!markets)} />
      <NavBar active="index" />
      <MarketStrip />
      <main className={s.main}>
        <header className={s.head}>
          <span className={s.label}>{first ? `${market.gpu} index` : `Today's ${market.gpu} index`}</span>
          {nodata ? (
            <NoData start />
          ) : (
            <span className={`${s.price} font-display ag-skel`}>
              {first ? dateText(first) : usd(market.price)}
            </span>
          )}
          <span className={s.sub}>
            {first
              ? `The first daily price is published about ${timeText(market.nextCloseAt)} and turns final about ${timeText(first)} on ${dateText(first)}. It is set once a day from the clouds' own price pages and written onchain on Monad.`
              : "Set once a day from the clouds' own price pages and written onchain on Monad: published about 01:00 UTC, final about 07:00 UTC after a six-hour window for checks."}
          </span>
        </header>
        {/* nothing read: the header says so; there are no readings to list or compare */}
        {!nodata && (
          <>
            <section id="today" className={s.section}>
              <h2>Today's readings</h2>
              {loading ? <div className={`${s.skelBlock} ag-skel`} aria-hidden="true" /> : <PriceMap market={market} />}
            </section>
            <section className={s.section}>
              <h2>Beside other prices</h2>
              {loading ? <div className={`${s.skelBlock} ag-skel`} aria-hidden="true" /> : <Beside market={market} />}
            </section>
          </>
        )}
        <p className={s.next}>Still to come on this page: how the index is made, each day's proof on Monad, and the full history.</p>
      </main>
      {config.phone === "new" && <BottomDock active="index" />}
    </div>
  );
}
