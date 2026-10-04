"use client";
// Pro depth: the November book on Kuru, positions, recent fills. Simple mode keeps all of this out of view.
import { useState } from "react";
import { monthName } from "@/components/markets/PriceChart";
import { Num } from "@/components/num/Num";
import { book, recentFills } from "@/lib/mock/market";
import { getMarket } from "@/lib/mock/data";
import { DRIP, useMock } from "@/lib/mock/store";
import type { Gpu, Market, Position } from "@/lib/mock/types";
import { int, usd, usd0 } from "@/lib/format";
import { fmtHours } from "@/lib/size";
import type { OpenOrder } from "./OrderTicket";
import s from "./trade.module.css";

/** onPick: Pro's order ticket is on, so rows are buttons that set its limit price. Total = GPU-hours from the
 * spread out to that level (Coinbase Advanced's book carries the same column). */
export function OrderBook({ market, onPick }: { market: Market; onPick?: (price: number) => void }) {
  const b = book(market);
  const cum = (levels: { price: number; size: number }[]) => levels.reduce<number[]>((a, l, i) => [...a, (a[i - 1] ?? 0) + l.size], []);
  const askTot = cum(b.asks);
  const bidTot = cum(b.bids);
  const maxTot = Math.max(askTot[askTot.length - 1], bidTot[bidTot.length - 1]);
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
  return (
    <div className={s.book}>
      <div className={s.panelHead}>
        <b>{monthName(market.series[0].month)} book</b>
      </div>
      <div className={s.bookCols} data-cols={totals ? 3 : 2}>
        <span>Price</span>
        <span>GPU-hours</span>
        {totals && <span>Total</span>}
      </div>
      <div>{b.asks.map((l, i) => ({ l, t: askTot[i] })).reverse().map(({ l, t }) => row(l, "ask", t))}</div>
      <div className={s.spread} data-cols={totals ? 3 : 2}>
        <span>Spread</span>
        <span>
          <Num>{usd(b.spread)}</Num>
        </span>
        {totals && (
          <span>
            Mid <Num>{usd(Math.round(((market.series[0].quote!.bid + market.series[0].quote!.ask) / 2) * 100) / 100)}</Num>
          </span>
        )}
      </div>
      <div>{b.bids.map((l, i) => row(l, "bid", bidTot[i]))}</div>
      {totals && <p className={s.fine}>Click a price to set a limit there.</p>}
    </div>
  );
}

type Tab = "positions" | "orders";

/** Positions and resting limit orders (cancel each); the month's recent trades sit under the book. */
export function ProBottom({ orders, onCancel }: { orders: OpenOrder[]; onCancel: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>("positions");
  const { wallet, config } = useMock();
  // each position is valued at its own market's last price, not the market on screen
  const lastFor = (p: Position) => getMarket(p.gpu, config.data).series.find((x) => x.month === p.month)?.quote?.last ?? p.entry;
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
                  const pnl = (p.side === "long" ? now - p.entry : p.entry - now) * p.q;
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
                      <td className={s.r}>
                        <Num>{usd(now)}</Num>
                      </td>
                      <td className={`${s.r} ${pnl >= 0 ? s.up : s.down}`}>
                        <Num>{`${pnl >= 0 ? "+" : "−"}${usd0(Math.abs(pnl))}`}</Num>
                      </td>
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
export function RecentTrades({ market }: { market: Market }) {
  const fills = recentFills(market.gpu, market);
  return (
    <div className={s.trades}>
      <div className={s.panelHead}>
        <b>Recent trades</b>
      </div>
      <div className={s.tradeRow} data-head>
        <span>Price</span>
        <span>GPU-hours</span>
        <span>Time (UTC)</span>
      </div>
      <div className={s.tradesList}>
        {fills.map((f, i) => (
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
      <p className={s.fine}>Quoted and traded mostly by our market-maker bot on testnet.</p>
    </div>
  );
}

/** Under Pro's ticket (Hyperliquid's account panel, Lighter's overview, Binance's assets): what you have to trade with
 * and what is at work, each position valued at its own market's last price. */
export function AccountBox({ orders }: { orders: OpenOrder[] }) {
  const { wallet, config, drip } = useMock();
  const series = (gpu: string, month: string) => getMarket(gpu as Gpu, config.data).series.find((x) => x.month === month);
  const inOrders = orders.reduce((a, o) => a + o.hold, 0);
  const pnl = wallet.positions.reduce((a, p) => {
    const now = series(p.gpu, p.month)?.quote?.last ?? p.entry;
    return a + (p.side === "long" ? now - p.entry : p.entry - now) * p.q;
  }, 0);
  const paid = wallet.positions.reduce((a, p) => a + p.paid, 0);
  const on = wallet.signedIn;
  const rows: [string, React.ReactNode, string?][] = [
    ["Test dollars", on ? <Num>{usd0(wallet.balance)}</Num> : "Sign in to see"],
    ["In open orders", on ? <Num>{usd0(inOrders)}</Num> : "None"],
    ["Positions", on ? <Num>{String(wallet.positions.length)}</Num> : "None"],
    ["Gain or loss", on ? <Num>{Math.abs(pnl) < 0.5 ? "$0" : `${pnl > 0 ? "+" : "−"}${usd0(Math.abs(pnl))}`}</Num> : "None", on && Math.abs(pnl) >= 0.5 ? (pnl > 0 ? s.up : s.down) : undefined],
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
