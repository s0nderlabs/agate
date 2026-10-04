"use client";
// The trade screen (round 4): Ornn-style chrome on top, the two prices and what they mean, chart on the left,
// the trade panel on the right. Simple mode shows where the price comes from below the chart; Pro adds the
// book, positions and fills. Round 3 is frozen in ./r3 for judging.
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
import { PriceMap } from "./PriceMap";
import { SourcesPop } from "./SourcesPop";
import { HeadStats, InfoIcon, MarketStats, StatItems } from "./MarketStats";
import { OrderTicket, type OpenOrder } from "./OrderTicket";
import Link from "next/link";
import { useLinkQuery } from "@/lib/mock/store";
import s from "./trade.module.css";

export function TradeScreen() {
  const { config, setConfig } = useMock();
  const linkQuery = useLinkQuery();
  const market = useMemo(() => getMarket(config.gpu, config.data, config.book), [config.gpu, config.data, config.book]);
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
  const pro = config.mode === "pro";
  // "From the top": the prices and the month's stats sit over the chart only, and the trade panel runs the full
  // height on the right (Hyperliquid, Coinbase Advanced). The round-2 single-price header keeps the old frame.
  const sideHead = config.tpanel === "top" && config.head !== "one";
  const dark = config.theme === "dark";
  const loading = config.data === "loading";
  const prev = days[days.length - 2].price;
  const delta = market.price - prev;
  const live = market.sources.filter((x) => x.live).length;
  const last = days[days.length - 1];

  useEffect(() => {
    document.documentElement.style.background = dark ? (config.dark === "black" ? "#0f0f10" : "#141413") : "#f6f5f1";
  }, [dark, config.dark]);
  // sheets (sign in, review) render outside this screen, so the chosen corners go on <html> too
  useEffect(() => {
    const h = document.documentElement;
    h.dataset.corners = config.corners;
    h.dataset.appCorners = "";
    return () => {
      delete h.dataset.corners;
      delete h.dataset.appCorners;
    };
  }, [config.corners]);

  const nov = trade.n.series;
  const monthLast = nov.quote?.last ?? 0;
  const monthDelta = Math.round(monthLast * monthChangePct(config.gpu)) / 100;
  const hasCarried = days.some((d) => d.status === "carried");
  // where today's index comes from, as the chosen sources control (link to the Index page, popover, or plain)
  const srcText = `${live} of 5 clouds${last.status === "carried" ? ", carried from yesterday, unverified" : ""}`;
  const sourcesCtl =
    config.ctx === "link" ? (
      <Link className={s.srcLink} href={`/index${linkQuery}#today`}>
        <i data-ok={live >= 5} aria-hidden="true" />
        {srcText}
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </Link>
    ) : config.ctx === "pop" ? (
      <SourcesPop market={market} label={srcText} ok={live >= 5} />
    ) : (
      <span className={s.status}>
        <i data-ok={live >= 5} aria-hidden="true" />
        {srcText}
      </span>
    );
  // November against today's index: the one-line meaning that replaced the "What it means" paragraph
  const prem = market.price ? monthLast / market.price - 1 : 0;
  const premText = Math.abs(prem) < 0.0005 ? "Level with the index" : `${Math.abs(prem * 100).toFixed(1)}% ${prem > 0 ? "above" : "below"} the index`;
  // the insight behind that number, opened from it on hover or tap (it lost its own stat in the references' header)
  const month = monthName(nov.month);
  const insight =
    Math.abs(prem) < 0.0005
      ? `Traders expect ${month} to cost about the same as today's index (${usd(monthLast)} against ${usd(market.price)}). Think it will average more? Long gains. Less? Short gains.`
      : `Traders expect ${month} to cost ${Math.abs(prem * 100).toFixed(1)}% ${prem > 0 ? "more" : "less"} than today's index (${usd(monthLast)} against ${usd(market.price)}). Think it will average above ${usd(monthLast)}? Long gains. Below? Short gains.`;
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
        {sideHead ? null : config.head === "one" ? (
          <section className={s.headOne}>
            <div className={s.headTop}>
              <div>
                <h1 className={s.title}>{market.gpu} SXM</h1>
                <p className={s.updated}>
                  Index price, final Oct 3, 2026 at 07:00 UTC
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
        ) : config.horder === "board" ? (
          // Scoreboard: the two prices as heroes (label, price, one note line), then the month's figures as one
          // quiet strip. Every label sits on one top line; no paragraph, no boxes, no dividers.
          <section className={s.board} aria-label={`${market.gpu} prices`}>
            {gpuTabs && <div className={s.headGpu}>{gpuTabs}</div>}
            <div className={s.bRow}>
            <div className={s.bHero}>
              <span className={s.pLabel}>Today's {market.gpu} index</span>
              <span className={`${s.bigPrice} font-display ag-skel`}>{usd(market.price)}</span>
              <span className={s.pSub}>
                <em className={delta > 0 ? s.up : delta < 0 ? s.down : undefined}>{Math.abs(delta) < 0.005 ? "Same as yesterday" : `${delta > 0 ? "+" : "−"}${usd(Math.abs(delta))} since yesterday`}</em>
                {sourcesCtl}
              </span>
            </div>
            <div className={s.bHero}>
              <span className={s.pLabel}>{monthName(nov.month)} market</span>
              <span className={`${s.bigPrice} font-display ag-skel`}>{usd(monthLast)}</span>
              <span className={s.pSub}>
                <em className={monthDelta > 0 ? s.up : monthDelta < 0 ? s.down : undefined}>{`${monthDelta >= 0 ? "+" : "−"}${usd(Math.abs(monthDelta))} today`}</em>
                <span>{premText}</span>
              </span>
            </div>
            <dl className={s.peers} aria-label={`${monthName(nov.month)} market`}>
              {config.stats === "on" && <StatItems market={market} units />}
              <div>
                <dt>Settles between</dt>
                <dd>
                  {usd(nov.floor)} – {usd(nov.cap)}
                </dd>
              </div>
            </dl>
            </div>
            {config.ctx === "top" && (
              <div className={s.mapCell}>
                <PriceMap market={market} />
              </div>
            )}
          </section>
        ) : (
        <section className={s.head} data-map={config.ctx === "top"} data-stats={config.stats === "on"} data-order={config.horder} aria-label={`${market.gpu} prices`}>
          {gpuTabs && <div className={s.headGpu}>{gpuTabs}</div>}
          <div className={s.priceBlock}>
            <span className={s.pLabel}>Today's {market.gpu} index</span>
            <span className={`${s.bigPrice} font-display ag-skel`}>{usd(market.price)}</span>
            <span className={s.pSub}>
              <em className={delta > 0 ? s.up : delta < 0 ? s.down : undefined}>{Math.abs(delta) < 0.005 ? "Same as yesterday" : `${delta > 0 ? "+" : "−"}${usd(Math.abs(delta))} since yesterday`}</em>
              {config.ctx === "link" ? (
                <Link className={s.srcLink} href={`/index${linkQuery}#today`}>
                  <i data-ok={live >= 5} aria-hidden="true" />
                  {live} of 5 clouds{last.status === "carried" ? ", carried from yesterday, unverified" : ""}
                  <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                    <path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </Link>
              ) : config.ctx === "pop" ? (
                <SourcesPop market={market} label={`${live} of 5 clouds${last.status === "carried" ? ", carried from yesterday, unverified" : ""}`} ok={live >= 5} />
              ) : (
                <span className={s.status}>
                  <i data-ok={live >= 5} aria-hidden="true" />
                  {live} of 5 clouds{last.status === "carried" ? ", carried from yesterday, unverified" : ""}
                </span>
              )}
            </span>
          </div>
          <div className={s.priceBlock}>
            <span className={s.pLabel}>{monthName(nov.month)} market</span>
            <span className={`${s.bigPrice} font-display ag-skel`}>{usd(monthLast)}</span>
            <span className={s.pSub}>
              <em className={monthDelta > 0 ? s.up : monthDelta < 0 ? s.down : undefined}>{`${monthDelta >= 0 ? "+" : "−"}${usd(Math.abs(monthDelta))} today`}</em>
              <span>on Kuru</span>
            </span>
          </div>
          <Outlook index={market.price} month={monthName(nov.month)} expected={monthLast} floor={nov.floor} cap={nov.cap} />
          {config.stats === "on" && (
            <div className={s.statsCell}>
              <MarketStats market={market} />
            </div>
          )}
          {config.ctx === "top" && (
            <div className={s.mapCell}>
              <PriceMap market={market} />
            </div>
          )}
        </section>
        )}

        <div className={s.grid} data-pro={pro} data-bottom={pro || config.ctx === "bottom"} data-top={sideHead}>
          {sideHead && (
            <section className={`${s.panel} ${s.headPanel}`} aria-label={`${market.gpu} prices`}>
              {gpuTabs && <div className={s.headGpu}>{gpuTabs}</div>}
              <div className={s.hsRow}>
                <div className={s.priceBlock}>
                  <span className={s.pLabel}>Today's {market.gpu} index</span>
                  <span className={`${s.bigPrice} font-display ag-skel`}>{usd(market.price)}</span>
                  <span className={s.pSub}>
                    <em className={delta > 0 ? s.up : delta < 0 ? s.down : undefined}>{Math.abs(delta) < 0.005 ? "Same as yesterday" : `${delta > 0 ? "+" : "−"}${usd(Math.abs(delta))} since yesterday`}</em>
                    {sourcesCtl}
                  </span>
                </div>
                <div className={s.priceBlock}>
                  <span className={s.pLabel}>{monthName(nov.month)} market</span>
                  <span className={`${s.bigPrice} font-display ag-skel`}>{usd(monthLast)}</span>
                  <span className={s.pSub}>
                    <em className={monthDelta > 0 ? s.up : monthDelta < 0 ? s.down : undefined}>{`${monthDelta >= 0 ? "+" : "−"}${usd(Math.abs(monthDelta))} today`}</em>
                    {config.hstats === "refs" ? (
                      <span className={s.tipWrap}>
                        <button type="button" className={s.tipBtn} data-hint={config.hint} aria-describedby="nov-insight">
                          {premText}
                          {config.hint === "icon" && <InfoIcon />}
                        </button>
                        <span role="tooltip" id="nov-insight" className={s.tip}>
                          {insight}
                        </span>
                      </span>
                    ) : (
                      <span>on Kuru</span>
                    )}
                  </span>
                </div>
                {config.stats === "on" &&
                  (config.hstats !== "row" ? (
                    <HeadStats market={market} hint={config.hint} look={config.hstats === "refs" ? "refs" : config.hstats === "charts" ? "charts" : config.hstats === "rich" ? "lines" : "plain"} />
                  ) : (
                    <dl className={s.hsStats} aria-label={`${monthName(nov.month)} market`}>
                      <StatItems market={market} />
                    </dl>
                  ))}
              </div>
              {config.ctx === "top" && (
                <div className={s.mapCell}>
                  <PriceMap market={market} />
                </div>
              )}
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
              <OrderBook market={market} mode={config.book} onPick={config.ticket === "order" ? (price) => setPicked((p) => ({ price, n: (p?.n ?? 0) + 1 })) : undefined} />
            </section>
          )}

          <aside className={`${s.panel} ${s.ticketPanel}`} aria-label="Trade">
            {pro && config.ticket === "order" ? (
              <OrderTicket key={market.gpu} market={market} trade={trade} picked={picked} onPlace={(o) => setOrders((list) => [o, ...list])} />
            ) : (
              <TradePanel market={market} trade={trade} pro={pro} />
            )}
          </aside>

          {(pro || config.ctx === "bottom") && <section className={`${s.panel} ${s.bottomPanel}`}>{pro ? <ProBottom market={market} sources={config.ctx === "bottom"} orders={config.ticket === "order" ? orders : undefined} onCancel={(id) => setOrders((list) => list.filter((o) => o.id !== id))} /> : <SimpleBottom market={market} />}</section>}
        </div>
      </main>
    </div>
  );
}

/** What the two prices mean together, in a sentence: where traders expect the month to land against today,
 * and the floor and ceiling every trade settles between. Replaces round 3's band bar, which took a third of the
 * header to place one dot between two numbers. */
function Outlook({ index, month, expected, floor, cap }: { index: number; month: string; expected: number; floor: number; cap: number }) {
  const prem = expected / index - 1;
  const pct = Math.abs(prem * 100).toFixed(1);
  const flat = Math.abs(prem) < 0.0005;
  return (
    <div className={s.outlook}>
      <span className={s.pLabel}>What it means</span>
      <p className={s.olMain}>
        {flat ? (
          <>Traders expect {month} to cost about the same as today.</>
        ) : (
          <>
            Traders expect {month} to cost{" "}
            <b className={prem > 0 ? s.up : s.down}>
              {pct}% {prem > 0 ? "more" : "less"}
            </b>{" "}
            than today.
          </>
        )}
      </p>
      <p className={s.olSub}>
        However it moves, {month} settles between {usd(floor)} and {usd(cap)} an hour, so every trade has a known worst case.
      </p>
    </div>
  );
}
