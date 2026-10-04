"use client";
// The Index page, first cut (Oct 3): where "5 of 5 clouds" on the trade screen leads. Holds the supporting data
// the trade screen no longer shows: today's readings and the price beside traded ones. Method, daily proof on
// Monad and history come when this page is designed properly.
import { useEffect, useMemo } from "react";
import { useMock } from "@/lib/mock/store";
import { getMarket } from "@/lib/mock/data";
import { usd } from "@/lib/format";
import { MarketStrip, NavBar, Notice } from "@/components/shell/Shell";
import { PriceMap } from "@/components/trade/PriceMap";
import { Beside } from "@/components/trade/Insight";
import s from "./index.module.css";

export function IndexScreen() {
  const { config } = useMock();
  const market = useMemo(() => getMarket(config.gpu, config.data), [config.gpu, config.data]);
  const dark = config.theme === "dark";
  useEffect(() => {
    document.documentElement.style.background = dark ? (config.dark === "black" ? "#0f0f10" : "#141413") : "#f6f5f1";
  }, [dark, config.dark]);
  return (
    <div className={`${s.screen} ${dark ? "tone-dark" : "tone-light"}`} data-style={config.style} data-corners={config.corners} data-dark={config.dark}>
      <Notice />
      <NavBar active="index" />
      <MarketStrip />
      <main className={s.main}>
        <header className={s.head}>
          <span className={s.label}>Today's {market.gpu} index</span>
          <span className={`${s.price} font-display`}>{usd(market.price)}</span>
          <span className={s.sub}>Set once a day from the clouds' own price pages and written onchain on Monad: published about 01:00 UTC, final about 07:00 UTC after a six-hour window for checks.</span>
        </header>
        <section id="today" className={s.section}>
          <h2>Today's readings</h2>
          <PriceMap market={market} />
        </section>
        <section className={s.section}>
          <h2>Beside other prices</h2>
          <Beside market={market} />
        </section>
        <p className={s.next}>Still to come on this page: how the index is made, each day's proof on Monad, and the full history.</p>
      </main>
    </div>
  );
}
