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
import { Compare, SourceStrip } from "@/components/markets/Parts";
import s from "./trade.module.css";

export function OrderBook({ market }: { market: Market }) {
  const b = book(market.gpu, market);
  const max = Math.max(...b.asks.map((l) => l.size), ...b.bids.map((l) => l.size));
  const row = (l: { price: number; size: number }, kind: "ask" | "bid") => (
    <div className={s.bookRow} key={kind + l.price} data-kind={kind}>
      <i style={{ width: `${(l.size / max) * 100}%` }} aria-hidden="true" />
      <span className={kind === "ask" ? s.down : s.up}>
        <Num>{l.price.toFixed(2)}</Num>
      </span>
      <span>
        <Num>{int(l.size)}</Num>
      </span>
    </div>
  );
  return (
    <div className={s.book}>
      <div className={s.panelHead}>
        <b>{monthName(market.series[0].month)} book</b>
      </div>
      <div className={s.bookCols}>
        <span>Price</span>
        <span>GPU-hours</span>
      </div>
      <div>{[...b.asks].reverse().map((l) => row(l, "ask"))}</div>
      <div className={s.spread}>
        <span>Spread</span>
        <span>
          <Num>{usd(b.spread)}</Num>
        </span>
      </div>
      <div>{b.bids.map((l) => row(l, "bid"))}</div>
      <p className={s.fine}>Quoted mostly by our market-maker bot on testnet.</p>
    </div>
  );
}

type Tab = "positions" | "fills" | "sources";

export function ProBottom({ market }: { market: Market }) {
  const [tab, setTab] = useState<Tab>("positions");
  const { wallet, config } = useMock();
  // each position is valued at its own market's last price, not the market on screen
  const lastFor = (p: Position) => getMarket(p.gpu, config.data).series.find((x) => x.month === p.month)?.quote?.last ?? p.entry;
  const fills = recentFills(market.gpu, market);
  return (
    <div className={s.bottom}>
      <div className={s.tabs} role="tablist">
        {(
          [
            ["positions", `Positions${wallet.positions.length ? ` (${wallet.positions.length})` : ""}`],
            ["fills", "Recent trades"],
            ["sources", "Price sources"],
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
      {tab === "sources" && (
        <div className={s.sourcesPro}>
          <SourceStrip market={market} />
          <Compare market={market} big={34} />
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
        <span>Five clouds post an on-demand {market.gpu} price. The middle one becomes the index, onchain.</span>
        <SourceStrip market={market} />
      </div>
      <div className={s.sub}>
        <b>Beside other prices</b>
        <span>Ours is posted and onchain. The other two are traded prices, shown for context.</span>
        <Compare market={market} big={32} />
      </div>
    </div>
  );
}
