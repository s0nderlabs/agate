"use client";
// Pro depth: the November book on Kuru, positions, recent fills. Simple mode keeps all of this out of view.
import { useState } from "react";
import { closeOrder } from "@/components/flow/CloseSheet";
import { useDrip } from "@/components/flow/DripButton";
import { useFlow } from "@/components/markets/Flow";
import { monthName } from "@/components/markets/PriceChart";
import { Num } from "@/components/num/Num";
import { useBook, useFills, useIndexer, useLastFor } from "@/lib/data/hooks";
import { monthStateOf, placeholderSeries } from "@/lib/data/derive";
import { DRIP, useAccount, type LimitDone, type LimitOrder } from "@/lib/account";
import { useMock } from "@/lib/mock/store";
import type { Gpu, Market, Position, Series } from "@/lib/mock/types";
import { int, usd, usd0 } from "@/lib/format";
import { showHours } from "@/lib/size";
import type { OpenOrder } from "./OrderTicket";
import { bookText } from "./States";
import { useLimitRun } from "./useLimitRun";
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
  // an entry of $0 is no price (minted pairs nothing has sold yet): no gain or loss to show
  return now === null || p.entry <= 0 ? null : (p.side === "long" ? now - p.entry : p.entry - now) * p.q;
}
/** "+$12", "−$3", or "$0" when it rounds to nothing (never a signed zero). */
function pnlText(pnl: number) {
  const r = Math.round(pnl);
  return r === 0 ? "$0" : `${r > 0 ? "+" : "−"}${usd0(Math.abs(r))}`;
}
/** The gain or loss color, none when it rounds to $0 (as the account box shows it). */
function pnlTone(pnl: number | null) {
  if (pnl === null) return "";
  const r = Math.round(pnl);
  return r > 0 ? s.up : r < 0 ? s.down : "";
}

/** Positions and resting limit orders (cancel each); the month's recent trades sit under the book. tab and onTab
 * let the phone's Pro tabs drive it; without them it keeps its own tab as before. On phones (new layout) the tables
 * give way to cards. canceling: the order whose cancel is on its way (the real account's go to Monad); note: how the
 * last cancel went, over the orders. */
export function ProBottom({ orders, onCancel, canceling = null, note = null, tab: tabProp, onTab }: { orders: OpenOrder[]; onCancel: (id: string) => void; canceling?: string | null; note?: string | null; tab?: Tab; onTab?: (t: Tab) => void }) {
  const [tabState, setTabState] = useState<Tab>("positions");
  const tab = tabProp ?? tabState;
  const setTab = (t: Tab) => {
    setTabState(t);
    onTab?.(t);
  };
  const { config } = useMock();
  const { positions: held, ready } = useAccount();
  // signed out there is nothing to list (the practice wallet keeps its holdings, but they are not shown until sign-in)
  const positions = ready ? held : [];
  const { openClose } = useFlow();
  const cards = config.phone === "new";
  // each position is valued at its own market's last price, not the market on screen (null: no price to read)
  const lastFor = useLastFor();
  return (
    <div className={s.bottom}>
      <div className={s.tabs} role="tablist">
        {(
          [
            ["positions", `Positions${positions.length ? ` (${positions.length})` : ""}`],
            ["orders", `Open orders${orders.length ? ` (${orders.length})` : ""}`],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "positions" && cards && positions.length > 0 && (
        <div className={s.cardsWrap}>
          <PositionCards positions={positions} lastFor={lastFor} />
        </div>
      )}
      {tab === "orders" && note && (
        <p className={s.empty} role="status">
          {note}
        </p>
      )}
      {tab === "orders" && cards && orders.length > 0 && (
        <div className={s.cardsWrap}>
          <OrderCards orders={orders} onCancel={onCancel} canceling={canceling} />
        </div>
      )}
      {tab === "positions" &&
        (positions.length ? (
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
                  <th>
                    <span className="sr-only">Close</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
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
                        <Num>{showHours(p.q)}</Num>
                      </td>
                      <td className={s.r}>
                        <Num>{usd(p.entry)}</Num>
                      </td>
                      <td className={s.r}>{now === null ? "No price yet" : <Num>{usd(now)}</Num>}</td>
                      <td className={`${s.r} ${pnlTone(pnl)}`}>{pnl === null ? "Waiting for a price" : <Num>{pnlText(pnl)}</Num>}</td>
                      <td className={s.r}>
                        <Num>{usd0(p.paid)}</Num>
                      </td>
                      {/* close from the row, as pro venues whose sides never net do (the phone cards and Positions too) */}
                      <td className={s.r}>
                        {closeOrder(p) && (
                          <button type="button" className={s.cancel} onClick={() => openClose(p)}>
                            Close
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={s.empty}>{ready ? "No positions yet. When you go Long or Short, it shows up here with what it's worth and what's been paid." : "Sign in to see your positions here, with what each is worth and a Close for each."}</p>
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
                      <Num>{showHours(o.q)}</Num>
                    </td>
                    <td>Good till canceled</td>
                    <td className={s.r}>
                      <button className={s.cancel} disabled={canceling !== null} onClick={() => onCancel?.(o.id)}>
                        {canceling === o.id ? "Canceling" : "Cancel"}
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
 * and what is at work, each position valued at its own market's last price. The real account's filled orders leave
 * their dollars at Kuru: said under the figures, with the move back to the balance (planWithdrawMargin). */
export function AccountBox({ orders }: { orders: OpenOrder[] }) {
  const account = useAccount();
  const { positions } = account;
  // the same valuation as the positions table and cards, so the two never disagree on one screen
  const lastFor = useLastFor();
  const drip = useDrip();
  const [moved, setMoved] = useState<string | null>(null);
  // what limit orders left at Kuru (the real account's only): dollars from a filled ask, GPU-hours from a filled bid
  const atKuru = account.planLimit && account.marginBalance >= 0.01 ? account.marginBalance : 0;
  const tokensAtKuru = account.planLimit ? positions.filter((p) => p.kind === "tokens" && p.inMargin >= 0.0001) : [];
  // signed out it says so once: nothing to count or value
  if (!account.ready)
    return (
      <section className={s.account} aria-label="Account">
        <div className={s.panelHead}>
          <b>Account</b>
        </div>
        <p className={s.accountOut}>Sign in to see your test dollars, positions and what they've paid you.</p>
      </section>
    );
  const inOrders = orders.reduce((a, o) => a + o.hold, 0);
  // a position with no price to read (an empty book, nothing read yet) adds nothing, rather than a guessed value
  const priced = positions.map((p) => pnlOf(p, lastFor(p))).filter((x): x is number => x !== null);
  const pnl = priced.reduce((a, x) => a + x, 0);
  const valued = priced.length > 0 || !positions.length;
  const paid = positions.reduce((a, p) => a + p.paid, 0);
  const rows: [string, React.ReactNode, string?][] = [
    ["Test dollars", <Num>{usd0(account.balance)}</Num>],
    ["In open orders", <Num>{usd0(inOrders)}</Num>],
    ["Positions", <Num>{String(positions.length)}</Num>],
    ["Gain or loss", !valued ? "No price yet" : <Num>{Math.abs(pnl) < 0.5 ? "$0" : pnlText(pnl)}</Num>, valued && Math.abs(pnl) >= 0.5 ? (pnl > 0 ? s.up : s.down) : undefined],
    ["Paid out so far", <Num>{usd0(paid)}</Num>],
  ];
  return (
    <section className={s.account} aria-label="Account">
      <div className={s.panelHead}>
        <b>Account</b>
        <button type="button" className={s.textBtn} disabled={drip.busy} onClick={() => void drip.run()}>
          {drip.busy ? "Getting test dollars" : `Get ${int(DRIP)} test dollars`}
        </button>
      </div>
      {drip.error && (
        <p className="ag-err" role="status">
          {drip.error}
        </p>
      )}
      <dl>
        {rows.map(([k, v, cls]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={cls}>{v}</dd>
          </div>
        ))}
      </dl>
      {atKuru > 0 && (
        <KuruLine order={{ kind: "withdrawMargin", asset: "dollar" }} onMoved={setMoved} back={(r) => `${usd(r.withdrawn?.dollars ?? atKuru)} is back in your balance.`}>
          <Num>{usd(atKuru)}</Num> waits at Kuru, where a limit order left it.
        </KuruLine>
      )}
      {tokensAtKuru.map((p) => (
        <KuruLine key={p.id} order={{ kind: "withdrawMargin", asset: { gpu: p.gpu, month: p.month } }} onMoved={setMoved} back={(r) => `${showHours(r.withdrawn?.gpuHours ?? p.inMargin)} GPU-hours of ${p.gpu} ${monthName(p.month)} are in your account now.`}>
          <Num>{showHours(p.inMargin)}</Num> GPU-hours of {p.gpu} {monthName(p.month)} wait at Kuru, where a limit order left them.
        </KuruLine>
      ))}
      {moved && (
        <p className={s.accountOut} role="status">
          {moved}
        </p>
      )}
    </section>
  );
}

/** One thing limit orders left at Kuru, in a sentence, and its move back to the account (planWithdrawMargin). back:
 *  the line once it landed; onMoved hands the outcome up (ok false: why not, and the button stays for another try), so
 *  it stays after this line goes with the next wallet read. Pro's account box and the close form both use it. */
export function KuruLine({ order, back, onMoved, label = "Move to your account", className = s.accountOut, btnClass = s.textBtn, children }: { order: LimitOrder; back: (r: LimitDone) => string; onMoved: (line: string, ok: boolean) => void; label?: string; className?: string; btnClass?: string; children: React.ReactNode }) {
  const move = useLimitRun();
  return (
    <p className={className}>
      {children}{" "}
      <button type="button" className={btnClass} disabled={move.busy} onClick={() => void move.run(order).then((r) => (r.ok ? onMoved(back(r.result), true) : r.message && onMoved(r.message, false)))}>
        {move.busy ? move.stepText : label}
      </button>
    </p>
  );
}

/** Positions as cards (phones, and the Positions page): what you hold in words, the gain or loss on the right.
 * lastFor values each position at its own market's last price (ProBottom's, so no new data calls). */
/** closable: false for positions the account does not hold itself (an AI's pocket: closing plans from the main account). */
export function PositionCards({ positions, lastFor, closable = true }: { positions: Position[]; lastFor: (p: Position) => number | null; closable?: boolean }) {
  const account = useAccount();
  const { openClose } = useFlow();
  // closing is a plan and one operation (the pretend account books it from the book's top)
  const canClose = closable && account.ready;
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
              <span className={`${s.cardPnl} ${pnlTone(pnl)}`}>{pnl === null ? "No price yet" : <Num>{pnlText(pnl)}</Num>}</span>
              {canClose && closeOrder(p) && (
                <button type="button" className={s.cardCancel} onClick={() => openClose(p)}>
                  Close
                </button>
              )}
            </div>
            <p className={s.cardLine}>
              <Num>{showHours(p.q)}</Num> GPU-hours at <Num>{usd(p.entry)}</Num>
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

/** Resting limit orders as cards (phones): the order in one line, a 44 px Cancel on the right. canceling: as ProBottom. */
export function OrderCards({ orders, onCancel, canceling = null }: { orders: OpenOrder[]; onCancel: (id: string) => void; canceling?: string | null }) {
  if (!orders.length) return <p className={s.empty}>No open orders. A limit away from the book waits here until it fills or you cancel it.</p>;
  return (
    <ul className={s.cards}>
      {orders.map((o) => (
        <li key={o.id} className={s.card}>
          <div className={s.cardTop}>
            <b>
              {o.gpu} {monthName(o.month).slice(0, 3)}, {o.side === "long" ? "Long" : "Short"} limit <Num>{usd(o.price)}</Num>
            </b>
            <button type="button" className={s.cardCancel} disabled={canceling !== null} onClick={() => onCancel(o.id)}>
              {canceling === o.id ? "Canceling" : "Cancel"}
            </button>
          </div>
          <p className={s.cardLine}>
            <Num>{showHours(o.q)}</Num> GPU-hours, good till canceled
          </p>
        </li>
      ))}
    </ul>
  );
}
