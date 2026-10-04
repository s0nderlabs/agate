"use client";
// Pro depth: the November book on Kuru, positions, recent fills. Simple mode keeps all of this out of view.
import { useState } from "react";
import { monthName } from "@/components/markets/PriceChart";
import { Num } from "@/components/num/Num";
import { book, recentFills } from "@/lib/mock/market";
import { getMarket } from "@/lib/mock/data";
import { useMock } from "@/lib/mock/store";
import type { Market, Position } from "@/lib/mock/types";
import { int, usd, usd0 } from "@/lib/format";
import { Beside, Sources } from "./Insight";
import type { OpenOrder } from "./OrderTicket";
import s from "./trade.module.css";

/** onPick: Pro's order ticket is on, so rows are buttons that set its limit price. Total = GPU-hours from the
 * spread out to that level (Coinbase Advanced's book carries the same column). */
export function OrderBook({ market, onPick, mode = "deep" }: { market: Market; onPick?: (price: number) => void; mode?: "bot" | "deep" }) {
  const b = book(market.gpu, market, mode);
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
      <p className={s.fine}>{totals ? "Click a price to set a limit there. " : ""}Quoted mostly by our market-maker bot on testnet.</p>
    </div>
  );
}

type Tab = "positions" | "orders" | "fills" | "sources";

/** sources: show the "Price sources" tab (only when they are not already in the header). orders: the order
 * ticket is on, so resting limit orders get their own tab. */
export function ProBottom({ market, sources = true, orders, onCancel }: { market: Market; sources?: boolean; orders?: OpenOrder[]; onCancel?: (id: string) => void }) {
  const [picked, setTab] = useState<Tab>("positions");
  const tab: Tab = (picked === "orders" && orders === undefined) || (picked === "sources" && !sources) ? "positions" : picked;
  const { wallet, config } = useMock();
  // each position is valued at its own market's last price, not the market on screen
  const lastFor = (p: Position) => getMarket(p.gpu, config.data, config.book).series.find((x) => x.month === p.month)?.quote?.last ?? p.entry;
  const fills = recentFills(market.gpu, market);
  return (
    <div className={s.bottom}>
      <div className={s.tabs} role="tablist">
        {(
          [
            ["positions", `Positions${wallet.positions.length ? ` (${wallet.positions.length})` : ""}`],
            ["orders", `Open orders${orders?.length ? ` (${orders.length})` : ""}`],
            ["fills", "Recent trades"],
            ["sources", "Price sources"],
          ] as [Tab, string][]
        )
          .filter(([k]) => (sources || k !== "sources") && (orders !== undefined || k !== "orders"))
          .map(([k, label]) => (
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
                        <Num>{int(p.q)}</Num>
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
      {orders !== undefined && tab === "orders" &&
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
                      <Num>{int(o.q)}</Num>
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
      {tab === "fills" && (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Side</th>
                <th className={s.r}>Price</th>
                <th className={s.r}>GPU-hours</th>
              </tr>
            </thead>
            <tbody>
              {fills.map((f, i) => (
                <tr key={i}>
                  <td>
                    <Num>{f.time}</Num>
                  </td>
                  <td className={f.side === "buy" ? s.up : s.down}>{f.side === "buy" ? "Bought" : "Sold"}</td>
                  <td className={s.r}>
                    <Num>{usd(f.price)}</Num>
                  </td>
                  <td className={s.r}>
                    <Num>{int(f.size)}</Num>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sources && tab === "sources" && (
        <div className={s.sourcesPro}>
          <Sources market={market} />
          <Beside market={market} />
        </div>
      )}
    </div>
  );
}

export function SimpleBottom({ market }: { market: Market }) {
  return (
    <div className={s.simpleBottom}>
      <div className={s.sub}>
        <b>Where today's price comes from</b>
        <Sources market={market} />
      </div>
      <div className={s.sub}>
        <b>Beside other prices</b>
        <Beside market={market} />
      </div>
    </div>
  );
}
