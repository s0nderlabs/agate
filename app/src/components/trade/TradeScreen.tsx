"use client";
// The trade screen: the market row on top, then a full-height trade panel on the right and, beside it, the two
// prices with the month's figures over the chart (Hyperliquid, Coinbase Advanced). Pro adds the November book,
// your positions and open orders, and an order ticket with limits.
import { useEffect, useMemo, useState } from "react";
import { useMock } from "@/lib/mock/store";
import { groundFor } from "@/lib/mock/config";
import { getMarket } from "@/lib/mock/data";
import { indexHistory, monthChangePct, novCandles } from "@/lib/mock/market";
import { usd } from "@/lib/format";
import { useTrade } from "@/components/markets/useTrade";
import { monthName } from "@/components/markets/PriceChart";
import { MarketStrip, NavBar, Notice } from "@/components/shell/Shell";
import { LineChart, type Range } from "./LineChart";
import { CandleChart } from "./CandleChart";
import { TradePanel } from "./TradePanel";
import { AccountBox, OrderBook, ProBottom, RecentTrades } from "./ProParts";
import { SourcesPop } from "./SourcesPop";
import { HeadStats, InfoIcon } from "./MarketStats";
import { OrderTicket, type OpenOrder } from "./OrderTicket";
import s from "./trade.module.css";

export function TradeScreen() {
  const { config } = useMock();
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
  // Pro: a click on a book row picks that price for the ticket; resting limit orders show under Open orders
  const [picked, setPicked] = useState<{ price: number; n: number } | null>(null);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const held = orders.reduce((a, o) => a + o.hold, 0);
  const pro = config.mode === "pro";
  const dark = config.theme === "dark";
  const loading = config.data === "loading";
  const prev = days[days.length - 2].price;
  const delta = market.price - prev;
  const live = market.sources.filter((x) => x.live).length;
  const last = days[days.length - 1];

  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config.theme]);

  const nov = trade.n.series;
  const monthLast = nov.quote?.last ?? 0;
  const monthDelta = Math.round(monthLast * monthChangePct(config.gpu)) / 100;
  const hasCarried = days.some((d) => d.status === "carried");
  // where today's index comes from: "5 of 5 clouds" opens the sources and the comparison on click
  const srcText = `${live} of 5 clouds${last.status === "carried" ? ", carried from yesterday, unverified" : ""}`;
  // November against today's index, in one line under November's price
  const prem = market.price ? monthLast / market.price - 1 : 0;
  const premText = Math.abs(prem) < 0.0005 ? "Level with the index" : `${Math.abs(prem * 100).toFixed(1)}% ${prem > 0 ? "above" : "below"} the index`;
  // the insight behind that number, opened from it on hover or tap
  const month = monthName(nov.month);
  const insight =
    Math.abs(prem) < 0.0005
      ? `Traders expect ${month} to cost about the same as today's index (${usd(monthLast)} against ${usd(market.price)}). Think it will average more? Long gains. Less? Short gains.`
      : `Traders expect ${month} to cost ${Math.abs(prem * 100).toFixed(1)}% ${prem > 0 ? "more" : "less"} than today's index (${usd(monthLast)} against ${usd(market.price)}). Think it will average above ${usd(monthLast)}? Long gains. Below? Short gains.`;
  return (
    <div className={`${s.screen} ${dark ? "tone-dark" : "tone-light"} ${loading ? "is-loading" : ""}`} data-dfill={config.dfill}>
      <Notice />
      <NavBar />
      <MarketStrip />
      <main className={s.main}>
        <div className={s.grid} data-pro={pro}>
          {pro ? (
            // Pro: one line of figures, so the chart and the book get the height
            <section className={`${s.panel} ${s.headPanel}`} aria-label={`${market.gpu} prices`}>
              <dl className={s.hStrip}>
              <div className={s.hsCell}>
                <dt className={s.pLabel}>{market.gpu} index</dt>
                <dd className={s.hsVal}>
                  <b className="font-display ag-skel">{usd(market.price)}</b>
                  <em className={delta > 0 ? s.up : delta < 0 ? s.down : undefined}>{Math.abs(delta) < 0.005 ? "Unchanged" : `${delta > 0 ? "+" : "−"}${usd(Math.abs(delta))}`}</em>
                </dd>
              </div>
              <div className={s.hsCell}>
                <dt className={s.pLabel}>{month} market</dt>
                <dd className={s.hsVal}>
                  <b className="font-display ag-skel">{usd(monthLast)}</b>
                  <em className={monthDelta > 0 ? s.up : monthDelta < 0 ? s.down : undefined}>{`${monthDelta >= 0 ? "+" : "−"}${usd(Math.abs(monthDelta))}`}</em>
                </dd>
              </div>
              <div className={s.hsCell}>
                <dt className={s.pLabel}>
                  <button type="button" className={s.tipBtn} aria-describedby="nov-insight">
                    Against the index
                    <InfoIcon />
                  </button>
                  <span role="tooltip" id="nov-insight" className={s.tip}>
                    {insight}
                  </span>
                </dt>
                <dd className={s.hsVal}>{Math.abs(prem) < 0.0005 ? "Level" : `${prem > 0 ? "+" : "−"}${Math.abs(prem * 100).toFixed(1)}%`}</dd>
              </div>
              <div className={s.hsCell}>
                <dt className={s.pLabel}>Price sources</dt>
                <dd className={s.hsVal}>
                  <SourcesPop market={market} label={srcText} ok={live >= 5} />
                </dd>
              </div>
              <HeadStats market={market} row />
              </dl>
            </section>
          ) : (
          <section className={`${s.panel} ${s.headPanel}`} aria-label={`${market.gpu} prices`}>
            <div className={s.hsRow}>
              <div className={s.priceBlock}>
                <span className={s.pLabel}>Today's {market.gpu} index</span>
                <span className={`${s.bigPrice} font-display ag-skel`}>{usd(market.price)}</span>
                <span className={s.pSub}>
                  <em className={delta > 0 ? s.up : delta < 0 ? s.down : undefined}>{Math.abs(delta) < 0.005 ? "Same as yesterday" : `${delta > 0 ? "+" : "−"}${usd(Math.abs(delta))} since yesterday`}</em>
                  <SourcesPop market={market} label={srcText} ok={live >= 5} />
                </span>
              </div>
              <div className={s.priceBlock}>
                <span className={s.pLabel}>{month} market</span>
                <span className={`${s.bigPrice} font-display ag-skel`}>{usd(monthLast)}</span>
                <span className={s.pSub}>
                  <em className={monthDelta > 0 ? s.up : monthDelta < 0 ? s.down : undefined}>{`${monthDelta >= 0 ? "+" : "−"}${usd(Math.abs(monthDelta))} today`}</em>
                  <span className={s.tipWrap}>
                    <button type="button" className={s.tipBtn} aria-describedby="nov-insight">
                      {premText}
                      <InfoIcon />
                    </button>
                    <span role="tooltip" id="nov-insight" className={s.tip}>
                      {insight}
                    </span>
                  </span>
                </span>
              </div>
              <HeadStats market={market} />
            </div>
          </section>
          )}

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
                <LineChart days={days} range={range} band={showBand ? { floor: nov.floor, cap: nov.cap, label: monthName(nov.month).slice(0, 3) } : null} height="100%" />
              ) : (
                <CandleChart candles={candles} hours={hours} kind={kind} height="100%" />
              )}
            </div>
            {series === "index" ? (
              <div className={s.legend}>
                <span>One price a day, so it moves in steps.</span>
                <span>
                  <i className={s.lgLine} aria-hidden="true" />
                  Our record, from Sep 30
                </span>
                <span>
                  <i className={`${s.lgLine} ${s.lgExample}`} aria-hidden="true" />
                  Example history
                </span>
                {hasCarried && (
                  <span>
                    <i className={s.lgDot} aria-hidden="true" />
                    Carried day, unverified
                  </span>
                )}
              </div>
            ) : (
              <div className={s.legend}>
                <span>Hourly on Kuru since {monthName(nov.month)} listed Oct 1, mostly quoted by our market-maker bot on testnet.</span>
              </div>
            )}
          </section>

          {pro && (
            <section className={`${s.panel} ${s.bookPanel}`} aria-label="Order book">
              <OrderBook market={market} onPick={(price) => setPicked((p) => ({ price, n: (p?.n ?? 0) + 1 }))} />
              <RecentTrades market={market} />
            </section>
          )}

          <aside className={`${s.panel} ${s.ticketPanel}`} aria-label="Trade">
            {pro ? (
              <>
                <OrderTicket key={market.gpu} market={market} trade={trade} picked={picked} held={held} onPlace={(o) => setOrders((list) => [o, ...list])} />
                <AccountBox orders={orders} />
              </>
            ) : (
              <TradePanel market={market} trade={trade} held={held} />
            )}
          </aside>

          {pro && (
            <section className={`${s.panel} ${s.bottomPanel}`}>
              <ProBottom orders={orders} onCancel={(id) => setOrders((list) => list.filter((o) => o.id !== id))} />
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
