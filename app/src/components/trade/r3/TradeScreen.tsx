"use client";
// ROUND 3 SNAPSHOT (Oct 3 2026), frozen so it can be judged against the latest; do not edit. The trade screen: Ornn-style chrome on top, the market header, chart on the left, the trade panel on the
// right. Simple mode shows where the price comes from below the chart; Pro adds the book, positions and fills.
import { useEffect, useMemo, useState } from "react";
import { useMock } from "@/lib/mock/store";
import { getMarket, GPUS } from "@/lib/mock/data";
import { indexHistory, monthChangePct, novCandles } from "@/lib/mock/market";
import { usd } from "@/lib/format";
import { useTrade } from "@/components/markets/useTrade";
import { monthName } from "@/components/markets/PriceChart";
import { MarketStrip, NavBar, Notice, Ticker } from "@/components/shell/Shell";
import type { Gpu } from "@/lib/mock/types";
import { LineChart, type Range } from "./LineChart";
import { CandleChart } from "./CandleChart";
import { TradePanel } from "./TradePanel";
import { OrderBook, ProBottom, SimpleBottom } from "./ProParts";
import s from "./trade.module.css";

export function TradeScreen() {
  const { config, setConfig } = useMock();
  const market = useMemo(() => getMarket(config.gpu, config.data), [config.gpu, config.data]);
  const days = useMemo(() => indexHistory(config.gpu, market.price, config.data), [config.gpu, market.price, config.data]);
  const trade = useTrade(market);
  const [range, setRange] = useState<Range>("3M");
  const [showBand, setShowBand] = useState(false);
  // what the chart shows: the daily index (one fix a day, a step line) or the traded month (hourly, line or candles)
  const [series, setSeries] = useState<"index" | "month">("index");
  const [kind, setKind] = useState<"candles" | "line">("candles");
  const [hours, setHours] = useState(54);
  const candles = useMemo(() => novCandles(config.gpu, market), [config.gpu, market]);
  const pro = config.mode === "pro";
  const dark = config.theme === "dark";
  const loading = config.data === "loading";
  const prev = days[days.length - 2].price;
  const delta = market.price - prev;
  const live = market.sources.filter((x) => x.live).length;
  const last = days[days.length - 1];

  useEffect(() => {
    document.documentElement.style.background = dark ? (config.dark === "black" ? "#0f0f10" : "#141413") : "#f6f5f1";
  }, [dark, config.dark]);

  const nov = trade.n.series;
  const monthLast = nov.quote?.last ?? 0;
  const monthDelta = Math.round(monthLast * monthChangePct(config.gpu)) / 100;
  // the ticker cannot switch GPU, so with it the header carries the GPU tabs again (as in round 2)
  const gpuTabs =
    config.row === "ticker" ? (
      <div className={s.gpuTabs} role="tablist" aria-label="GPU">
        {GPUS.map((g) => (
          <button key={g} role="tab" aria-selected={config.gpu === g} onClick={() => setConfig({ gpu: g as Gpu })}>
            {g}
          </button>
        ))}
      </div>
    ) : null;
  return (
    <div className={`${s.screen} ${dark ? "tone-dark" : "tone-light"} ${loading ? "is-loading" : ""}`} data-style={config.style} data-corners={config.corners} data-dark={config.dark}>
      {config.row === "ticker" && <Ticker />}
      <Notice />
      <NavBar />
      {config.row !== "ticker" && <MarketStrip />}
      <main className={s.main}>
        {config.head === "one" ? (
          <section className={s.headOne}>
            <div className={s.headTop}>
              <div>
                <h1 className={s.title}>{market.gpu} SXM</h1>
                <p className={s.updated}>
                  Index price, updated Oct 3, 2026 at 06:00 UTC
                  {last.status === "carried" && <span className={s.carriedNote}>Carried from yesterday, unverified</span>}
                </p>
              </div>
              {gpuTabs}
            </div>
            <div className={s.priceRow}>
              <span className={`${s.bigPrice} font-display ag-skel`}>{usd(market.price)}</span>
              <span className={s.per}>per {market.gpu} hour</span>
              <span className={`${s.delta} ${delta > 0 ? s.up : delta < 0 ? s.down : ""}`}>
                {Math.abs(delta) < 0.005 ? "Same as yesterday" : `${delta > 0 ? "+" : "−"}${usd(Math.abs(delta))} since yesterday`}
              </span>
              <span className={s.status}>
                <i data-ok={live >= 5} aria-hidden="true" />
                {live} of 5 clouds reporting
              </span>
            </div>
          </section>
        ) : (
        <section className={s.head} aria-label={`${market.gpu} prices`}>
          {gpuTabs && <div className={s.headGpu}>{gpuTabs}</div>}
          <div className={s.priceBlock}>
            <span className={s.pLabel}>Today's {market.gpu} index</span>
            <span className={`${s.bigPrice} font-display ag-skel`}>{usd(market.price)}</span>
            <span className={s.pSub}>
              <em className={delta > 0 ? s.up : delta < 0 ? s.down : undefined}>{Math.abs(delta) < 0.005 ? "Same as yesterday" : `${delta > 0 ? "+" : "−"}${usd(Math.abs(delta))} since yesterday`}</em>
              <span className={s.status}>
                <i data-ok={live >= 5} aria-hidden="true" />
                {live} of 5 clouds{last.status === "carried" ? ", carried from yesterday, unverified" : ""}
              </span>
            </span>
          </div>
          <div className={s.priceBlock}>
            <span className={s.pLabel}>{monthName(nov.month)} market</span>
            <span className={`${s.bigPrice} font-display ag-skel`}>{usd(monthLast)}</span>
            <span className={s.pSub}>
              <em className={monthDelta > 0 ? s.up : monthDelta < 0 ? s.down : undefined}>{`${monthDelta >= 0 ? "+" : "−"}${usd(Math.abs(monthDelta))} today`}</em>
              <span>what traders expect {monthName(nov.month)} to average</span>
            </span>
          </div>
          <BandBar floor={nov.floor} cap={nov.cap} now={monthLast} month={monthName(nov.month)} />
        </section>
        )}

        <div className={s.grid} data-pro={pro}>
          <section className={`${s.panel} ${s.chartPanel}`} aria-label="Price chart">
            <div className={s.chartBar}>
              <div className={s.barLeft}>
                <div className={s.seriesTabs} role="tablist" aria-label="Chart">
                  <button role="tab" aria-selected={series === "index"} onClick={() => setSeries("index")}>
                    Index
                  </button>
                  <button role="tab" aria-selected={series === "month"} onClick={() => setSeries("month")}>
                    {monthName(nov.month)} market
                  </button>
                </div>
                {series === "month" && (
                  <div className={s.ranges} role="group" aria-label="Chart type">
                    <button aria-pressed={kind === "candles"} onClick={() => setKind("candles")}>
                      Candles
                    </button>
                    <button aria-pressed={kind === "line"} onClick={() => setKind("line")}>
                      Line
                    </button>
                  </div>
                )}
              </div>
              {series === "index" ? (
                <div className={s.barRight}>
                  <label className={s.bandToggle}>
                    <input type="checkbox" checked={showBand} onChange={(e) => setShowBand(e.target.checked)} />
                    <span className={s.check} aria-hidden="true" />
                    {monthName(nov.month)}'s floor and ceiling
                  </label>
                  <div className={s.ranges} role="group" aria-label="Range">
                    {(["1W", "1M", "3M", "ALL"] as Range[]).map((r) => (
                      <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
                        {r === "ALL" ? "All" : r}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className={s.ranges} role="group" aria-label="Range">
                  {(
                    [
                      [24, "1D"],
                      [54, "Since listing"],
                    ] as [number, string][]
                  ).map(([h, label]) => (
                    <button key={h} aria-pressed={hours === h} onClick={() => setHours(h)}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className={`${s.chartBody} ag-skel`}>
              {series === "index" ? (
                <LineChart days={days} range={range} band={showBand ? { floor: nov.floor, cap: nov.cap, label: monthName(nov.month).slice(0, 3) } : null} height={pro ? "100%" : "clamp(240px, 34vh, 420px)"} />
              ) : (
                <CandleChart candles={candles} hours={hours} kind={kind} height={pro ? "100%" : "clamp(240px, 34vh, 420px)"} />
              )}
            </div>
            <p className={s.fine}>
              {series === "index"
                ? "One price a day, so it moves in steps. Lighter line: example history before our record starts Sep 30. Hollow dots: carried days, unverified."
                : `The ${monthName(nov.month)} token trading on Kuru, hourly, since it listed Oct 1. Mostly quoted by our market-maker bot on testnet.`}
            </p>
          </section>

          {pro && (
            <section className={`${s.panel} ${s.bookPanel}`} aria-label="Order book">
              <OrderBook market={market} />
            </section>
          )}

          <aside className={`${s.panel} ${s.ticketPanel}`} aria-label="Trade">
            <TradePanel market={market} trade={trade} pro={pro} />
          </aside>

          <section className={`${s.panel} ${s.bottomPanel}`}>{pro ? <ProBottom market={market} /> : <SimpleBottom market={market} />}</section>
        </div>
      </main>
    </div>
  );
}

/** November's band: the floor and ceiling every Long and Short settles between, with where the market sits now. */
function BandBar({ floor, cap, now, month }: { floor: number; cap: number; now: number; month: string }) {
  const pos = Math.max(0, Math.min(100, ((now - floor) / (cap - floor)) * 100));
  return (
    <div className={s.bandBlock}>
      <span className={s.pLabel}>{month} settles between</span>
      <div className={s.bandTrack} role="img" aria-label={`${month} pays between ${usd(floor)} and ${usd(cap)}; the market is at ${usd(now)}`}>
        <span className={s.bandFill} style={{ width: `${pos}%` }} />
        <span className={s.bandNow} style={{ left: `${pos}%` }}>
          <b>{usd(now)}</b>
        </span>
      </div>
      <div className={s.bandEnds}>
        <span>
          Floor <b>{usd(floor)}</b>
        </span>
        <span>
          Ceiling <b>{usd(cap)}</b>
        </span>
      </div>
    </div>
  );
}
