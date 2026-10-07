"use client";
// The trade screen: the market row on top, then a full-height trade panel on the right and, beside it, the two
// prices with the month's figures over the chart (Hyperliquid, Coinbase Advanced). Pro adds the November book,
// your positions and open orders, and an order ticket with limits.
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "@/lib/account";
import { useMock, useOpenOrders } from "@/lib/mock/store";
import { groundFor } from "@/lib/mock/config";
import { isOld, useBook, useCandles, useDataStatus, useMarkets, useNow, useScreenMarket } from "@/lib/data/hooks";
import { cloudsText, dateText, headline, hoursSinceListing, monthChange, monthStateOf, NO_DAY, panelCount, staleState, statusLine, topOf } from "@/lib/data/derive";
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
import { OrderTicket } from "./OrderTicket";
import s from "./trade.module.css";
import { useLayoutEffect, useRef } from "react";
import { useFlow } from "@/components/markets/Flow";
import { BottomDock } from "@/components/shell/Dock";
import { useKeyboardInset, useMedia, useModalFocus, useThemeColor } from "@/lib/ui/hooks";
import type { Side } from "@/lib/mock/types";
import { Note } from "./Note";
import { TradeBar } from "./TradeBar";
import { indexStartsText, monthChartText, NoData, PriceOnlyTicket, StateBox, TicketWait } from "./States";

/** Simple | Pro at the head of the ticket, in the new phone and tablet layout. Switching swaps the ticket in place,
 * so the phone sheet stays open. The top bar keeps its own switch from 1024 px, and More keeps one at every width. */
function ModeSeg() {
  const { config, setConfig } = useMock();
  return (
    <div className={`ag-seg ${s.modeSeg}`} role="group" aria-label="Trading view">
      <button type="button" aria-pressed={config.mode === "simple"} onClick={() => setConfig({ mode: "simple" })}>
        Simple
      </button>
      <button type="button" aria-pressed={config.mode === "pro"} onClick={() => setConfig({ mode: "pro" })}>
        Pro
      </button>
    </div>
  );
}

export function TradeScreen() {
  const { config } = useMock();
  // one shared markets read (example or live, per Mock controls); a neutral stand-in until it answers
  const read = useScreenMarket(config.gpu);
  const market = read.market;
  // the logger's days before the index's first onchain day come first, drawn lighter (display only: never in the
  // price, its history or anything that settles)
  const prelaunch = market.prelaunch;
  const days = useMemo(() => (prelaunch?.length ? [...prelaunch, ...market.history] : market.history), [prelaunch, market.history]);
  // Simple keeps to one month, the next full one beside the index (Mock controls can show every open month, as before)
  const trade = useTrade(market, { one: config.mode !== "pro" && config.months === "one" });
  const [range, setRange] = useState<Range>("3M");
  const [showBand, setShowBand] = useState(false);
  // what the chart shows: the daily index (one fix a day, a step line) or the traded month (hourly, line or candles)
  const [series, setSeries] = useState<"index" | "month">("index");
  const [kind, setKind] = useState<"candles" | "line">("candles");
  // the month chart's range: the last day, the last week (the new candle sizes only), or everything since it listed
  const [span, setSpan] = useState<"day" | "week" | "all">("all");
  // Pro's own candle size; null follows the range (Mock controls "Candle size": follows the range, or always hourly)
  const [sizePick, setSizePick] = useState<1 | 4 | 24 | null>(null);
  const cq = useCandles(trade.n.series);
  const candles = cq.candles;
  // the candles' own read: on its way (skeletons where their numbers go) or failed with nothing read (said so)
  const candlesWait = cq.loading && !cq.error;
  const candlesFailed = cq.loading && cq.error;
  const now = useNow();
  // Pro: a click on a book row picks that price for the ticket; resting limit orders show under Open orders. Orders
  // are kept per data source, like the practice wallets (an example order never shows, or holds dollars, under live),
  // and outlive this screen, so a trip to Positions and back keeps them and the dollars they hold
  const [picked, setPicked] = useState<{ price: number; n: number } | null>(null);
  const { orders, setOrders } = useOpenOrders();
  const held = orders.reduce((a, o) => a + o.hold, 0);
  const pro = config.mode === "pro";
  const dark = config.theme === "dark";
  const loading = read.loading;
  // how the reads are doing (old prices, Monad unreachable, the indexer), for the Notice bar, the buttons and the bar
  const st = useDataStatus();
  const { markets } = useMarkets();
  // nothing read and nothing on its way: Monad unreachable before any data came in
  const nodata = read.missing && !loading;
  // (useDataStatus re-renders on a clock of its own while live, so old prices turn stale on time even mid-read)
  // the buttons wait once the prices are two minutes old (one failed read alone does not stop a practice order); time
  // the tab spent hidden does not count, since polling pauses there
  const stale = staleState({ error: st.error, stale: isOld(st.updatedAt) }, !read.missing);
  const prev = market.prevPrice;
  const delta = market.price - prev;
  const live = market.liveCount;
  const last = days[days.length - 1] ?? NO_DAY;

  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config.theme]);

  const nov = trade.n.series;
  const monthLast = nov.quote?.last ?? 0;
  // the month's book (empty while it is not listed): its top prices the trade bar, and an empty one is its own state
  const bq = useBook(nov);
  // the month's own situation: the ticket, the book, the trades and the month chart follow it
  const mstate = monthStateOf(market, nov, bq.loading ? null : bq.book);
  // the index before its first final price (only once data has answered; loading has its skeletons instead)
  const before = !read.missing && market.priceDate === null;
  // both header cells in words (label, value, the line under it), the month against the index and its insight
  const head = headline(market, nov, candlesFailed ? null : candles, now, st.indexerUp);
  // the month has traded: its change today, in its color
  const moved = market.tradable && nov.phase !== "upcoming" && !!nov.quote?.last && nov.quote.lastAt !== null;
  // the month's change over the last 24 hours, from its candles: a skeleton until they are read, "not available" when
  // they could not be (never +$0.00 made up from no candles)
  const monthDelta = monthChange(candles, now);
  const dayWait = moved && candlesWait;
  const dayFailed = moved && candlesFailed;
  const hasCarried = days.some((d) => d.status === "carried");
  // the "Example history" legend only when some day on the chart is one
  const hasExample = days.some((d) => d.example);
  // where our own record starts and when the month listed, for the chart legends
  const recordFrom = dateText(days.find((d) => !d.example && d.onchain !== false)?.date);
  const hasLogger = days.some((d) => d.onchain === false);
  const hasRecord = days.some((d) => !d.example && d.onchain !== false);
  const listedOn = dateText(nov.listedAt);
  // where today's index comes from: "5 of 5 clouds" opens the sources and the comparison on click; before the first
  // price, how many clouds are being read
  const srcText = before ? `${market.liveCount || panelCount(market)} clouds read today` : cloudsText(market);
  const srcOk = market.liveCount >= panelCount(market);
  // November against today's index (Pro's short form; the words come from headline)
  const prem = market.price && monthLast ? monthLast / market.price - 1 : 0;
  const month = monthName(nov.month);
  // a skeleton class while loading (added only then, so the normal markup is unchanged)
  const sk = (cls?: string) => (loading ? (cls ? `${cls} ag-skel` : "ag-skel") : cls);
  // the chart: a price-only GPU has no month tab; the band needs a floor and a ceiling
  const view = market.tradable ? series : "index";
  const bandOk = !loading && market.tradable && nov.cap > 0;
  const monthDraw = candles.length > 0;
  // nothing to draw: the month's line (candles that could not be read say trade history is unavailable, never "No
  // trades yet"); none while they are on their way (the plot is a skeleton then)
  const monthLine = !loading && !nodata && !candlesWait && !monthDraw ? monthChartText(nov, st.indexerUp && !candlesFailed) : null;
  const sinceListing = hoursSinceListing(nov, now) || candles.length;
  // the range picks the candle size (1D hourly, 1W 4-hourly, Since listing the largest size that still draws about
  // 24 candles: daily from 24 days listed, 4-hourly from 4 days, else hourly), the way Robinhood and Coinbase's simple
  // view pair them; Pro can override it while drawing candles. Before: hourly, with 1D or Since listing.
  const autoSize = config.candles === "auto";
  const spanNow = autoSize ? span : span === "week" ? "all" : span;
  const spanHours = spanNow === "day" ? 24 : spanNow === "week" ? 168 : sinceListing;
  const allSize = sinceListing >= 24 * 24 ? 24 : sinceListing >= 4 * 24 ? 4 : 1;
  const candleSize = !autoSize ? 1 : (pro && kind === "candles" && sizePick) || (spanNow === "day" ? 1 : spanNow === "week" ? 4 : allSize);
  // the last hour anything traded (the client repeats the close through quiet hours with no volume)
  const lastTradeAt = useMemo(() => {
    for (let i = candles.length - 1; i >= 0; i--) if (candles[i].v > 0) return Date.parse(candles[i].t) + 3_600_000;
    return null;
  }, [candles]);
  const quietFor = lastTradeAt === null ? null : Math.floor((now - lastTradeAt) / 3_600_000);
  const srcPop = loading ? (
    <span className="ag-skel" aria-hidden="true">
      5 of 5 clouds
    </span>
  ) : (
    <SourcesPop market={market} label={srcText} ok={srcOk} />
  );

  // Phone and tablet layout (mock option "Phone and tablet layout"; Stacked renders today's layout below 1100 px).
  // On phones the ticket is a bottom sheet opened from the trade bar; Pro's book, trades, positions and orders sit
  // behind tabs. Tablets put the ticket beside the chart. Desktop (1100 px and up) is unchanged.
  const { setConfig } = useMock();
  const { positions, ready } = useAccount();
  const flow = useFlow();
  const isPhone = useMedia("(max-width: 639.98px)");
  const phoneNew = config.phone === "new";
  const sheet = phoneNew && isPhone;
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ptab, setPtab] = useState<"book" | "trades" | "positions" | "orders">("book");
  const asideRef = useRef<HTMLElement>(null);
  const openTicket = (side?: Side) => {
    if (side) trade.setSide(side);
    setTicketOpen(true);
  };
  // Escape closes the ticket only when no Flow sheet sits over it (capture phase: it runs before Flow closes its own)
  const flowSheet = useRef(flow.sheetKind);
  useEffect(() => {
    flowSheet.current = flow.sheetKind;
  });
  useEffect(() => {
    if (!ticketOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && flowSheet.current === null) setTicketOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ticketOpen]);
  // placing an order: the ticket slides away under the Flow sheet (in the same commit), so closing Done lands on the page
  useLayoutEffect(() => {
    if (flow.sheetKind === "placing") setTicketOpen(false);
  }, [flow.sheetKind]);
  // turned to a tablet, or switched to Stacked: no sheet to keep open
  useEffect(() => {
    if (!sheet) setTicketOpen(false);
  }, [sheet]);
  useModalFocus(asideRef, sheet && ticketOpen);
  useKeyboardInset(sheet && ticketOpen);
  useThemeColor(config.theme);
  const ptabs: [typeof ptab, string][] = [
    ["book", "Book"],
    ["trades", "Trades"],
    ["positions", `Positions${ready && positions.length ? ` (${positions.length})` : ""}`],
    ["orders", `Orders${orders.length ? ` (${orders.length})` : ""}`],
  ];
  const onPtabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = ptabs.findIndex(([k]) => k === ptab);
    const next = e.key === "ArrowRight" ? (i + 1) % ptabs.length : e.key === "ArrowLeft" ? (i + ptabs.length - 1) % ptabs.length : e.key === "Home" ? 0 : e.key === "End" ? ptabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setPtab(ptabs[next][0]);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div
      className={`${s.screen} ${dark ? "tone-dark" : "tone-light"} ${loading ? "is-loading" : ""}`}
      data-dfill={config.dfill}
      data-phone={config.phone}
      data-pbar={config.pbar}
      data-ticket={ticketOpen ? "open" : "closed"}
      data-ptab={ptab}
      aria-busy={loading || undefined}
    >
      <Notice status={statusLine(st, !!markets)} />
      <NavBar />
      <MarketStrip />
      <main className={s.main}>
        <div className={s.grid} data-pro={pro}>
          {pro ? (
            // Pro: one line of figures, so the chart and the book get the height
            <section className={`${s.panel} ${s.headPanel}`} aria-label={`${market.gpu} prices`}>
              {nodata ? (
                <NoData start />
              ) : (
              <dl className={s.hStrip}>
              <div className={s.hsCell}>
                <dt className={s.pLabel}>{market.gpu} index</dt>
                <dd className={s.hsVal}>
                  {before ? (
                    <>
                      <b className="font-display" data-words>
                        {head.index.value}
                      </b>
                      <em>{head.index.sub}</em>
                    </>
                  ) : (
                    <>
                      <b className="font-display ag-skel">{usd(market.price)}</b>
                      <em className={sk(delta > 0 ? s.up : delta < 0 ? s.down : undefined)}>{Math.abs(delta) < 0.005 ? "Unchanged" : `${delta > 0 ? "+" : "−"}${usd(Math.abs(delta))}`}</em>
                    </>
                  )}
                </dd>
              </div>
              <div className={s.hsCell}>
                <dt className={s.pLabel}>{loading ? `${month} market` : head.month.label}</dt>
                <dd className={s.hsVal}>
                  {loading || moved ? (
                    <>
                      <b className="font-display ag-skel">{usd(monthLast)}</b>
                      <em className={dayWait ? "ag-skel ag-skel-on" : sk(monthDelta > 0 ? s.up : monthDelta < 0 ? s.down : undefined)}>
                        {dayFailed ? "Not available" : `${monthDelta >= 0 ? "+" : "−"}${usd(Math.abs(monthDelta))}`}
                      </em>
                    </>
                  ) : (
                    <>
                      <b className="font-display" data-words={!head.month.value.startsWith("$") || undefined}>
                        {head.month.value}
                      </b>
                      <em>{head.month.sub}</em>
                    </>
                  )}
                </dd>
              </div>
              {!loading && head.premText && head.insight && (
                <div className={s.hsCell}>
                  <dt className={s.pLabel}>
                    <Note label="Against the index" note={head.insight} />
                  </dt>
                  <dd className={s.hsVal}>{Math.abs(prem) < 0.0005 ? "Level" : `${prem > 0 ? "+" : "−"}${Math.abs(prem * 100).toFixed(1)}%`}</dd>
                </div>
              )}
              <div className={s.hsCell}>
                <dt className={s.pLabel}>Price sources</dt>
                <dd className={s.hsVal}>{srcPop}</dd>
              </div>
              <HeadStats market={market} series={nov} row loading={loading} />
              </dl>
              )}
            </section>
          ) : (
          <section className={`${s.panel} ${s.headPanel}`} aria-label={`${market.gpu} prices`}>
            {nodata ? (
              <NoData start />
            ) : (
            <div className={s.hsRow}>
              <div className={s.priceBlock}>
                <span className={s.pLabel}>{loading ? `Today's ${market.gpu} index` : head.index.label}</span>
                <span className={`${s.bigPrice} font-display ag-skel`} data-words={before || undefined}>
                  {loading ? usd(0) : head.index.value}
                </span>
                <span className={s.pSub}>
                  <em className={sk(before ? undefined : delta > 0 ? s.up : delta < 0 ? s.down : undefined)}>{loading ? "Same as yesterday" : head.index.sub}</em>
                  {srcPop}
                </span>
              </div>
              <div className={s.priceBlock}>
                <span className={s.pLabel}>{loading ? `${month} market` : head.month.label}</span>
                <span className={`${s.bigPrice} font-display ag-skel`} data-words={(!loading && !head.month.value.startsWith("$")) || undefined}>
                  {loading ? usd(0) : head.month.value}
                </span>
                <span className={s.pSub}>
                  <em className={dayWait ? "ag-skel ag-skel-on" : sk(moved ? (monthDelta > 0 ? s.up : monthDelta < 0 ? s.down : undefined) : undefined)}>
                    {loading || dayWait ? "+$0.00 today" : head.month.sub}
                  </em>
                  {/* the month against the index, once the month has a price to compare */}
                  {!loading && head.premText && head.insight && (
                    <span className={s.tipWrap}>
                      <Note label={head.premText} note={head.insight} title={`${month} against the index`} />
                    </span>
                  )}
                </span>
              </div>
              <HeadStats market={market} series={nov} loading={loading} />
            </div>
            )}
          </section>
          )}

          <section className={`${s.panel} ${s.chartPanel}`} aria-label="Price chart" data-series={view}>
            <div className={s.chartBar}>
              <div className={s.barLeft}>
                {!nodata && (
                  <div className={s.seriesTabs} role="tablist" aria-label="Chart">
                    <button role="tab" aria-selected={view === "index"} onClick={() => setSeries("index")}>
                      Index
                    </button>
                    {/* a price-only GPU has no month to chart. Two months trading (Pro): one tab each, and picking one
                        moves the whole screen to it (header, chart, book, trades and ticket) */}
                    {market.tradable &&
                      (trade.pickable ? (
                        trade.open.map((sr) => (
                          <button
                            key={sr.month}
                            role="tab"
                            aria-selected={view === "month" && trade.month === sr.month}
                            onClick={() => {
                              trade.setMonth(sr.month);
                              setSeries("month");
                            }}
                          >
                            {monthName(sr.month)} market
                          </button>
                        ))
                      ) : (
                        <button role="tab" aria-selected={view === "month"} onClick={() => setSeries("month")}>
                          {monthName(nov.month)} market
                        </button>
                      ))}
                  </div>
                )}
                {view === "month" && monthDraw && (
                  <div className={s.ranges} role="group" aria-label="Chart type">
                    <button aria-pressed={kind === "candles"} onClick={() => setKind("candles")}>
                      Candles
                    </button>
                    <button aria-pressed={kind === "line"} onClick={() => setKind("line")}>
                      Line
                    </button>
                  </div>
                )}
                {/* Pro: the candle size beside the chart type (Lighter, Coinbase Advanced); a range tap resets it */}
                {view === "month" && monthDraw && autoSize && pro && kind === "candles" && (
                  <div className={s.ranges} role="group" aria-label="Candle size">
                    {(
                      [
                        [1, "Hourly"],
                        [4, "4-hour"],
                        [24, "Daily"],
                      ] as const
                    ).map(([k, label]) => (
                      <button key={k} aria-pressed={candleSize === k} onClick={() => setSizePick(k)}>
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {view === "index"
                ? !loading &&
                  !nodata &&
                  !before && (
                    <div className={s.barRight}>
                      {/* the band needs a month with a floor and a ceiling */}
                      {bandOk && (
                        <label className={s.bandToggle}>
                          <input type="checkbox" checked={showBand} onChange={(e) => setShowBand(e.target.checked)} />
                          <span className={s.check} aria-hidden="true" />
                          {monthName(nov.month)}'s floor and ceiling
                        </label>
                      )}
                      <div className={s.ranges} role="group" aria-label="Range">
                        {(["1W", "1M", "3M", "ALL"] as Range[]).map((r) => (
                          <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
                            {r === "ALL" ? "All" : r}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                : monthDraw && (
                    <div className={s.barRight}>
                      <div className={s.ranges} role="group" aria-label="Range">
                        {(autoSize
                          ? ([
                              ["day", "1D"],
                              ["week", "1W"],
                              ["all", "Since listing"],
                            ] as const)
                          : ([
                              ["day", "1D"],
                              ["all", "Since listing"],
                            ] as const)
                        ).map(([k, label]) => (
                          <button
                            key={k}
                            aria-pressed={spanNow === k}
                            onClick={() => {
                              setSpan(k);
                              setSizePick(null);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
            </div>
            {/* the month's plot is a skeleton of its own while its candles are on their way */}
            <div className={`${s.chartBody} ag-skel${view === "month" && candlesWait ? " ag-skel-on" : ""}`}>
              {view === "index" ? (
                before && !hasLogger ? (
                  <StateBox>
                    <p className={s.tCopy}>{indexStartsText(market)}</p>
                  </StateBox>
                ) : (
                  <LineChart days={days} range={range} band={bandOk && showBand ? { floor: nov.floor, cap: nov.cap, label: monthName(nov.month).slice(0, 3) } : null} height="100%" />
                )
              ) : monthLine ? (
                <StateBox>
                  <p className={s.tCopy}>{monthLine}</p>
                </StateBox>
              ) : (
                // the axis runs from the listing, so the hours before the first trade stay empty
                <CandleChart candles={candles} hours={spanHours} size={candleSize} kind={kind} height="100%" startAt={nov.listedAt} />
              )}
            </div>
            {view === "index"
              ? !loading &&
                !nodata &&
                (!before || hasLogger) && (
                  <div className={s.legend}>
                    <span>{before ? indexStartsText(market) : "One price a day, so it moves in steps."}</span>
                    {hasRecord && (
                      <span>
                        <i className={s.lgLine} aria-hidden="true" />
                        Our record{recordFrom ? `, from ${recordFrom}` : ""}
                      </span>
                    )}
                    {hasLogger && (
                      <span>
                        <i className={`${s.lgLine} ${s.lgExample}`} aria-hidden="true" />
                        Recorded by our logger, not onchain
                      </span>
                    )}
                    {hasExample && (
                      <span>
                        <i className={`${s.lgLine} ${s.lgExample}`} aria-hidden="true" />
                        Example history
                      </span>
                    )}
                    {hasCarried && (
                      <span>
                        <i className={s.lgDot} aria-hidden="true" />
                        Carried day, unverified
                      </span>
                    )}
                  </div>
                )
              : monthDraw && (
                  <div className={s.legend}>
                    <span>
                      {autoSize ? `${candleSize === 1 ? "Hourly" : candleSize === 4 ? "4-hour" : "Daily"} ${kind === "line" ? "prices" : "candles"}` : "Hourly"} on Kuru since {monthName(nov.month)} listed{listedOn ? ` ${listedOn}` : ""}, mostly quoted by our market-maker bot on testnet.
                    </span>
                    {/* a thin market: a flat stretch is a quiet book, said in words */}
                    {autoSize && quietFor !== null && quietFor >= 2 && (
                      <span>Last trade {quietFor >= 48 ? `${Math.floor(quietFor / 24)} days` : `${quietFor} hours`} ago.</span>
                    )}
                  </div>
                )}
          </section>

          {/* phones: the month's four figures under the chart (the header keeps the two prices) */}
          {phoneNew && !nodata && (
            <section className={`${s.panel} ${s.statsPanel}`} aria-label={market.tradable ? `${month} market` : `${market.gpu} index`}>
              <HeadStats market={market} series={nov} loading={loading} />
            </section>
          )}

          {/* phones, Pro: one of the book, recent trades, positions or orders at a time */}
          {pro && phoneNew && (
            <div className={`${s.panel} ${s.ptabs}`}>
              <div className={s.tabs} role="tablist" aria-label="Pro" onKeyDown={onPtabKey}>
                {ptabs.map(([k, label]) => (
                  <button key={k} type="button" role="tab" aria-selected={ptab === k} tabIndex={ptab === k ? 0 : -1} onClick={() => setPtab(k)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {pro && (
            <section className={`${s.panel} ${s.bookPanel}`} aria-label="Order book">
              {/* the ticket's month (not always the first open one) */}
              <OrderBook
                market={market}
                series={nov}
                loading={loading}
                idle={nodata}
                onPick={(price) => {
                  setPicked((p) => ({ price, n: (p?.n ?? 0) + 1 }));
                  if (sheet) openTicket();
                }}
              />
              <RecentTrades market={market} series={nov} loading={loading} idle={nodata} />
            </section>
          )}

          <aside ref={asideRef} id="ticket" className={`${s.panel} ${s.ticketPanel}`} aria-label={`Trade ${month} ${market.gpu}`} {...(sheet ? { role: "dialog", "aria-modal": true, tabIndex: -1 } : {})}>
            {/* phones: the sheet's head, Simple | Pro on the left and the close X on the right */}
            {phoneNew && (
              <div className={s.ticketHead}>
                <ModeSeg />
                <button type="button" className={s.sheetClose} aria-label="Close" onClick={() => setTicketOpen(false)}>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
                  </svg>
                </button>
              </div>
            )}
            <div className={s.ticketInner}>
              {/* tablets below 1024 px: Simple | Pro heads the ticket column (the compact top bar has no switch) */}
              {phoneNew && (
                <div className={s.ticketMode}>
                  <ModeSeg />
                </div>
              )}
              {/* the ticket for the situation: loading (skeletons), nothing read, a price-only GPU, a month not open yet or
                  with an empty book (a waiting block, Simple and Pro alike), else the ticket itself */}
              {!loading && nodata ? (
                <TicketWait market={market} trade={trade} kind="nodata" />
              ) : !loading && mstate === "priceOnly" ? (
                <PriceOnlyTicket market={market} />
              ) : !loading && (mstate === "upcoming" || mstate === "emptyBook") ? (
                <TicketWait market={market} trade={trade} kind={mstate} />
              ) : pro ? (
                <OrderTicket key={market.gpu} market={market} trade={trade} picked={picked} held={held} onPlace={(o) => setOrders((list) => [o, ...list])} loading={loading} stale={stale} />
              ) : (
                <TradePanel market={market} trade={trade} held={held} loading={loading} stale={stale} />
              )}
              {pro && <AccountBox orders={orders} />}
            </div>
          </aside>
          {phoneNew && <div className={s.ticketScrim} aria-hidden="true" onClick={() => setTicketOpen(false)} />}

          {pro && (
            <section className={`${s.panel} ${s.bottomPanel}`}>
              {phoneNew && (
                <div className={s.phoneAccount}>
                  <AccountBox orders={orders} />
                </div>
              )}
              <ProBottom
                orders={orders}
                onCancel={(id) => setOrders((list) => list.filter((o) => o.id !== id))}
                tab={sheet ? (ptab === "orders" ? "orders" : "positions") : undefined}
                onTab={sheet ? setPtab : undefined}
              />
            </section>
          )}
        </div>
      </main>
      {phoneNew && (
        <BottomDock active="markets">
          <TradeBar
            gpu={market.gpu}
            month={month}
            // the book's own sides once it has been read (an empty side has no price, as the ticket says); the
            // markets quote only while the book is on its way
            quote={topOf(bq.book, nov.quote, !bq.loading)}
            phase={nov.phase}
            opensOn={nov.opensOn}
            tradable={market.tradable}
            loading={loading}
            stale={stale}
            open={ticketOpen}
            side={trade.side}
            onOpen={openTicket}
            onSwitchGpu={(g) => setConfig({ gpu: g })}
          />
        </BottomDock>
      )}
    </div>
  );
}
