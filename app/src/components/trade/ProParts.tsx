"use client";
// Pro depth: the November book on Kuru, positions, recent fills. Simple mode keeps all of this out of view.
import { useState } from "react";
import { monthName } from "@/components/markets/PriceChart";
import { Num } from "@/components/num/Num";
import { useBook, useFills, useIndexer, useLastFor } from "@/lib/data/hooks";
import { monthStateOf, placeholderSeries } from "@/lib/data/derive";
import { DRIP, useMock } from "@/lib/mock/store";
import type { Gpu, Market, Position, Series } from "@/lib/mock/types";
import { int, usd, usd0 } from "@/lib/format";
import { fmtHours } from "@/lib/size";
import type { OpenOrder } from "./OrderTicket";
import { bookText } from "./States";
import s from "./trade.module.css";

/** Skeleton rows while a read is on its way (the screen's, or the book's or the trades' own after the screen has
 * loaded), masked on their own; never real numbers. */
function SkelRows({ n, cols }: { n: number; cols: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div className={s.bookRow} key={i} data-cols={cols}>
          {Array.from({ length: cols }, (_, k) => (
            <span key={k}>
              <span className="ag-skel ag-skel-on">0.00</span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** onPick: Pro's order ticket is on, so rows are buttons that set its limit price. Total = GPU-hours from the
 * spread out to that level (Coinbase Advanced's book carries the same column). series: the ticket's month (the first
 * open one by default). loading: nothing has been read yet (skeleton rows). idle: nothing could be read (Monad
 * unreachable; the header says so), so no rows and no line. */
export function OrderBook({ market, series, onPick, loading = false, idle = false }: { market: Market; series?: Series; onPick?: (price: number) => void; loading?: boolean; idle?: boolean }) {
  // the ticket's month, else the first open one (a stand-in with an empty book for a price-only GPU)
  const bs = series ?? market.series[0] ?? placeholderSeries(market);
  const bq = useBook(bs);
  const b = bq.book;
  const state = monthStateOf(market, bs, bq.loading ? null : b);
  const cum = (levels: { price: number; size: number }[]) => levels.reduce<number[]>((a, l, i) => [...a, (a[i - 1] ?? 0) + l.size], []);
  const askTot = cum(b.asks);
  const bidTot = cum(b.bids);
  const maxTot = Math.max(askTot[askTot.length - 1] ?? 0, bidTot[bidTot.length - 1] ?? 0);
  const totals = !!onPick;
  const row = (l: { price: number; size: number }, kind: "ask" | "bid", tot: number) => {
    const inner = (
      <>
        <i style={{ width: `${(tot / maxTot) * 100}%` }} aria-hidden="true" />
        <span className={kind === "ask" ? s.down : s.up}>
          <Num>{l.price.toFixed(2)}</Num>
        </span>
        <span>
          <Num>{int(l.size)}</Num>
        </span>
        {totals && (
          <span>
            <Num>{int(tot)}</Num>
          </span>
        )}
      </>
    );
    return onPick ? (
      <button className={s.bookRow} key={kind + l.price} data-kind={kind} data-cols={3} onClick={() => onPick(l.price)} title={`Limit at ${usd(l.price)}`}>
        {inner}
      </button>
    ) : (
      <div className={s.bookRow} key={kind + l.price} data-kind={kind}>
        {inner}
      </div>
    );
  };
  const cols = totals ? 3 : 2;
  // skeleton rows until the book itself has been read (a book that could not be read is not an empty one)
  const busy = loading || bq.loading;
  // no rows to show: a price-only GPU, a month not open yet, or nobody quoting yet (said in a line instead)
  const line = !busy && !idle && (state === "priceOnly" || state === "upcoming" || state === "emptyBook") ? bookText(market, bs, state) : null;
  const rows = !busy && !idle && !line;
  return (
    <div className={s.book}>
      <div className={s.panelHead}>
        <b>{(state === "priceOnly" && !loading) || idle ? "Book" : `${monthName(bs.month)} book`}</b>
      </div>
      {idle ? null : line ? (
        <p className={s.empty}>{line}</p>
      ) : (
        <>
          <div className={s.bookCols} data-cols={cols}>
            <span>Price</span>
            <span>GPU-hours</span>
            {totals && <span>Total</span>}
          </div>
          {busy && <SkelRows n={3} cols={cols} />}
          {rows && <div>{b.asks.map((l, i) => ({ l, t: askTot[i] })).reverse().map(({ l, t }) => row(l, "ask", t))}</div>}
          {/* the spread and the middle need both sides */}
          {rows && b.asks.length > 0 && b.bids.length > 0 && (
            <div className={s.spread} data-cols={cols}>
              <span>Spread</span>
              <span>
                <Num>{usd(b.spread)}</Num>
              </span>
              {totals && (
                <span>
                  Mid <Num>{usd(Math.round(((b.bids[0].price + b.asks[0].price) / 2) * 100) / 100)}</Num>
                </span>
              )}
            </div>
          )}
          {busy && <SkelRows n={3} cols={cols} />}
          {rows && <div>{b.bids.map((l, i) => row(l, "bid", bidTot[i]))}</div>}
          {totals && rows && (
            <p className={s.fine}>
              <span className={s.fineMouse}>Click a price to set a limit there.</span>
              <span className={s.fineTouch}>Tap a price to set a limit there.</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

type Tab = "positions" | "orders";

/** A position's gain or loss at a price, or null when there is no price to value it at. */
function pnlOf(p: Position, now: number | null) {
  return now === null ? null : (p.side === "long" ? now - p.entry : p.entry - now) * p.q;
}
function pnlText(pnl: number) {
  return `${pnl >= 0 ? "+" : "−"}${usd0(Math.abs(pnl))}`;
}

/** Positions and resting limit orders (cancel each); the month's recent trades sit under the book. tab and onTab
 * let the phone's Pro tabs drive it; without them it keeps its own tab as before. On phones (new layout) the tables
 * give way to cards. */
export function ProBottom({ orders, onCancel, tab: tabProp, onTab }: { orders: OpenOrder[]; onCancel: (id: string) => void; tab?: Tab; onTab?: (t: Tab) => void }) {
  const [tabState, setTabState] = useState<Tab>("positions");
  const tab = tabProp ?? tabState;
  const setTab = (t: Tab) => {
    setTabState(t);
    onTab?.(t);
  };
  const { wallet, config } = useMock();
  const cards = config.phone === "new";
  // each position is valued at its own market's last price, not the market on screen (null: no price to read)
  const lastFor = useLastFor();
  return (
    <div className={s.bottom}>
      <div className={s.tabs} role="tablist">
        {(
          [
            ["positions", `Positions${wallet.positions.length ? ` (${wallet.positions.length})` : ""}`],
            ["orders", `Open orders${orders.length ? ` (${orders.length})` : ""}`],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "positions" && cards && wallet.positions.length > 0 && (
        <div className={s.cardsWrap}>
          <PositionCards positions={wallet.positions} lastFor={lastFor} />
        </div>
      )}
      {tab === "orders" && cards && orders.length > 0 && (
        <div className={s.cardsWrap}>
          <OrderCards orders={orders} onCancel={onCancel} />
        </div>
      )}
      {tab === "positions" &&
        (wallet.positions.length ? (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className={s.r}>GPU-hours</th>
                  <th className={s.r}>Entry</th>
                  <th className={s.r}>Now</th>
                  <th className={s.r}>Gain or loss</th>
                  <th className={s.r}>Paid so far</th>
                </tr>
              </thead>
              <tbody>
                {wallet.positions.map((p) => {
                  const now = lastFor(p);
                  const pnl = pnlOf(p, now);
                  return (
                    <tr key={p.id}>
                      <td>
                        {p.gpu} {monthName(p.month).slice(0, 3)}
                        {p.daily ? ", paid daily" : ""}
                      </td>
                      <td>{p.side === "long" ? "Long" : "Short"}</td>
                      <td className={s.r}>
                        <Num>{fmtHours(p.q)}</Num>
                      </td>
                      <td className={s.r}>
                        <Num>{usd(p.entry)}</Num>
                      </td>
                      <td className={s.r}>{now === null ? "No price yet" : <Num>{usd(now)}</Num>}</td>
                      <td className={`${s.r} ${pnl === null ? "" : pnl >= 0 ? s.up : s.down}`}>{pnl === null ? "Waiting for a price" : <Num>{pnlText(pnl)}</Num>}</td>
                      <td className={s.r}>
                        <Num>{usd0(p.paid)}</Num>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={s.empty}>No positions yet. When you go Long or Short, it shows up here with what it's worth and what's been paid.</p>
        ))}
      {tab === "orders" &&
        (orders.length ? (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className={s.r}>Limit</th>
                  <th className={s.r}>GPU-hours</th>
                  <th>Time in force</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      {o.gpu} {monthName(o.month).slice(0, 3)}
                      {o.daily ? ", paid daily" : ""}
                    </td>
                    <td className={o.side === "long" ? s.up : s.down}>{o.side === "long" ? "Long" : "Short"}</td>
                    <td className={s.r}>
                      <Num>{usd(o.price)}</Num>
                    </td>
                    <td className={s.r}>
                      <Num>{fmtHours(o.q)}</Num>
                    </td>
                    <td>Good till canceled</td>
                    <td className={s.r}>
                      <button className={s.cancel} onClick={() => onCancel?.(o.id)}>
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={s.empty}>No open orders. A limit away from the book waits here until it fills or you cancel it.</p>
        ))}
    </div>
  );
}

/** The month's recent trades under the book, newest first, in the book's own columns: what just traded sits next
 * to what is on offer (Binance and Bybit stack them; Hyperliquid puts them on a second tab). */
export function RecentTrades({ market, series, loading = false, idle = false }: { market: Market; series?: Series; loading?: boolean; idle?: boolean }) {
  // the ticket's month, else the first open one
  const bs = series ?? market.series[0];
  const fq = useFills(bs);
  const fills = fq.fills;
  const { indexerUp } = useIndexer();
  // a price-only GPU has no trades to list (its book panel already says why)
  if ((!market.tradable && !loading) || idle) return null;
  const listed = !!bs && bs.phase !== "upcoming" && !!bs.quote;
  // the fills' own read: on its way (skeleton rows) or failed with nothing read (history unavailable, never "No
  // trades yet")
  const wait = fq.loading && !fq.error;
  const failed = fq.loading && fq.error;
  // nothing to list: not open yet, no trade history (the indexer holds it, or it could not be read), or no trades yet
  const line = loading ? null : !listed ? "No trades yet." : !indexerUp || failed ? "Trade history is unavailable right now." : wait ? null : !fills.length ? "No trades yet." : null;
  const busy = loading || wait;
  return (
    <div className={s.trades}>
      <div className={s.panelHead}>
        <b>Recent trades</b>
      </div>
      {line ? (
        <p className={s.empty}>{line}</p>
      ) : (
        <>
          <div className={s.tradeRow} data-head>
            <span>Price</span>
            <span>GPU-hours</span>
            <span>Time (UTC)</span>
          </div>
          <div className={s.tradesList}>
            {busy && <SkelRows n={3} cols={3} />}
            {!busy &&
              fills.map((f, i) => (
                <div className={s.tradeRow} key={i}>
                  <span className={f.side === "buy" ? s.up : s.down}>
                    <Num>{f.price.toFixed(2)}</Num>
                  </span>
                  <span>
                    <Num>{int(f.size)}</Num>
                  </span>
                  <span>
                    <Num>{f.time}</Num>
                  </span>
                </div>
              ))}
          </div>
          {!busy && fills.length > 0 && <p className={s.fine}>Quoted and traded mostly by our market-maker bot on testnet.</p>}
        </>
      )}
    </div>
  );
}

/** Under Pro's ticket (Hyperliquid's account panel, Lighter's overview, Binance's assets): what you have to trade with
 * and what is at work, each position valued at its own market's last price. */
export function AccountBox({ orders }: { orders: OpenOrder[] }) {
  const { wallet, drip } = useMock();
  // the same valuation as the positions table and cards, so the two never disagree on one screen
  const lastFor = useLastFor();
  const inOrders = orders.reduce((a, o) => a + o.hold, 0);
  // a position with no price to read (an empty book, nothing read yet) adds nothing, rather than a guessed value
  const priced = wallet.positions.map((p) => pnlOf(p, lastFor(p))).filter((x): x is number => x !== null);
  const pnl = priced.reduce((a, x) => a + x, 0);
  const valued = priced.length > 0 || !wallet.positions.length;
  const paid = wallet.positions.reduce((a, p) => a + p.paid, 0);
  const on = wallet.signedIn;
  const rows: [string, React.ReactNode, string?][] = [
    ["Test dollars", on ? <Num>{usd0(wallet.balance)}</Num> : "Sign in to see"],
    ["In open orders", on ? <Num>{usd0(inOrders)}</Num> : "None"],
    ["Positions", on ? <Num>{String(wallet.positions.length)}</Num> : "None"],
    ["Gain or loss", !on ? "None" : !valued ? "No price yet" : <Num>{Math.abs(pnl) < 0.5 ? "$0" : pnlText(pnl)}</Num>, on && valued && Math.abs(pnl) >= 0.5 ? (pnl > 0 ? s.up : s.down) : undefined],
    ["Paid out so far", on ? <Num>{usd0(paid)}</Num> : "None"],
  ];
  return (
    <section className={s.account} aria-label="Account">
      <div className={s.panelHead}>
        <b>Account</b>
        {on && (
          <button type="button" className={s.textBtn} onClick={drip}>
            Get {int(DRIP)} test dollars
          </button>
        )}
      </div>
      <dl>
        {rows.map(([k, v, cls]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={cls}>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Positions as cards (phones, and the Positions page): what you hold in words, the gain or loss on the right.
 * lastFor values each position at its own market's last price (ProBottom's, so no new data calls). */
export function PositionCards({ positions, lastFor }: { positions: Position[]; lastFor: (p: Position) => number | null }) {
  if (!positions.length) return <p className={s.empty}>No positions yet. When you go Long or Short, it shows up here with what it's worth and what's been paid.</p>;
  return (
    <ul className={s.cards}>
      {positions.map((p) => {
        const now = lastFor(p);
        const pnl = pnlOf(p, now);
        const month = monthName(p.month);
        return (
          <li key={p.id} className={s.card}>
            <div className={s.cardTop}>
              <b>
                {p.gpu} {month.slice(0, 3)}, {p.side === "long" ? "Long" : "Short"}
              </b>
              <span className={`${s.cardPnl} ${pnl === null ? "" : pnl >= 0 ? s.up : s.down}`}>{pnl === null ? "No price yet" : <Num>{pnlText(pnl)}</Num>}</span>
            </div>
            <p className={s.cardLine}>
              <Num>{fmtHours(p.q)}</Num> GPU-hours at <Num>{usd(p.entry)}</Num>
              {now === null ? ", waiting for a price" : <>, now <Num>{usd(now)}</Num></>}
            </p>
            <p className={s.cardQuiet}>
              {p.daily ? (
                <>
                  Paid daily, <Num>{usd0(p.paid)}</Num> so far
                </>
              ) : (
                `Paid once, after ${month} ends`
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/** Resting limit orders as cards (phones): the order in one line, a 44 px Cancel on the right. */
export function OrderCards({ orders, onCancel }: { orders: OpenOrder[]; onCancel: (id: string) => void }) {
  if (!orders.length) return <p className={s.empty}>No open orders. A limit away from the book waits here until it fills or you cancel it.</p>;
  return (
    <ul className={s.cards}>
      {orders.map((o) => (
        <li key={o.id} className={s.card}>
          <div className={s.cardTop}>
            <b>
              {o.gpu} {monthName(o.month).slice(0, 3)}, {o.side === "long" ? "Long" : "Short"} limit <Num>{usd(o.price)}</Num>
            </b>
            <button type="button" className={s.cardCancel} onClick={() => onCancel(o.id)}>
              Cancel
            </button>
          </div>
          <p className={s.cardLine}>
            <Num>{fmtHours(o.q)}</Num> GPU-hours, good till canceled
          </p>
        </li>
      ))}
    </ul>
  );
}
