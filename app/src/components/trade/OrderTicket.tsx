"use client";
// Pro mode's order ticket: trading the month like any asset on an order book (Kuru). Modeled on Coinbase Advanced
// (limit price with quick fills, amount with % buttons, Subtotal / Fee / Total) and Hyperliquid (Available to
// trade, Current position, a summary under the button). One deliberate difference: where Hyperliquid shows a
// liquidation price and margin, this says "none, fully backed", because a Long or Short here can never be
// liquidated. Pro speaks trader (Order value, Max loss); Simple keeps the plain plan in GPUs x days.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFlow } from "@/components/markets/Flow";
import { monthName } from "@/components/markets/PriceChart";
import type { Trade, TradeNumbers } from "@/components/markets/useTrade";
import { Num } from "@/components/num/Num";
import { useMock } from "@/lib/mock/store";
import type { Market } from "@/lib/mock/types";
import { int, usd, usd0 } from "@/lib/format";
import s from "./order.module.css";

export interface OpenOrder {
  id: string;
  gpu: string;
  month: string;
  side: "long" | "short";
  price: number;
  q: number;
  daily: boolean;
  placedAt: string;
}

export function OrderTicket({ market, trade, picked, onPlace }: { market: Market; trade: Trade; picked: { price: number; n: number } | null; onPlace: (o: OpenOrder) => void }) {
  const { submit, openSignIn } = useFlow();
  const { wallet, config } = useMock();
  const series = trade.n.series;
  const q = series.quote!;
  const L = trade.side === "long";
  const [type, setType] = useState<"market" | "limit">("market");
  const [limitStr, setLimitStr] = useState("");
  const [sizeStr, setSizeStr] = useState(String(trade.n.hours));
  const [note, setNote] = useState<{ msg: string; at: string } | null>(null);

  // a click on a book row lands here: switch to Limit at that price. A pick made before this ticket mounted
  // (on another GPU, or before a Simple/Pro switch) is not applied again.
  const seenPick = useRef(picked?.n ?? 0);
  useEffect(() => {
    if (!picked || picked.n === seenPick.current) return;
    seenPick.current = picked.n;
    setType("limit");
    setLimitStr(picked.price.toFixed(2));
  }, [picked]);

  const book = L ? q.ask : q.bid;
  const limit = Number(limitStr);
  const limitOk = type === "limit" && limitStr !== "" && limit > series.floor && limit < series.cap;
  const price = type === "market" ? book : limitOk ? limit : book;
  // a limit at or through the book fills now (at the book price); otherwise it rests as an open order
  const crosses = type === "market" || (limitOk && (L ? limit >= q.ask : limit <= q.bid));
  const fillPrice = crosses ? book : price;
  // pay me daily runs through agate's router: a market order or a limit that fills now can use it; an order that
  // waits in the book fills on Kuru directly and settles at the end of the month instead (@agate/client, Oct 4)
  const canDaily = crosses;
  const daily = canDaily && trade.daily;
  const size = Math.max(0, Math.floor(Number(sizeStr) || 0));
  const perHour = L ? fillPrice : series.cap - fillPrice;
  const balance = wallet.signedIn ? wallet.balance : 0;
  const maxSize = perHour > 0 ? Math.floor(balance / perHour) : 0;

  const n = useMemo<TradeNumbers>(() => {
    const F = series.floor;
    const C = series.cap;
    return {
      series,
      side: trade.side,
      gpus: size / (24 * series.n),
      daily,
      hours: size,
      price: fillPrice,
      outlay: L ? fillPrice * size : (C - fillPrice) * size,
      backNow: L && daily ? F * size : 0,
      maxLoss: L ? (fillPrice - F) * size : (C - fillPrice) * size,
      maxGain: L ? (C - fillPrice) * size : (fillPrice - F) * size,
    };
  }, [series, trade.side, daily, size, fillPrice, L]);

  const position = wallet.positions.filter((p) => p.gpu === market.gpu && p.month === series.month).reduce((a, p) => a + (p.side === "long" ? p.q : -p.q), 0);
  const gpusAllMonth = size / (24 * series.n);
  const m = monthName(series.month);
  const worst = L ? series.floor : series.cap;
  const best = L ? series.cap : series.floor;

  const gated = config.gate === "signin" && !wallet.signedIn;
  const inputs = `${trade.side}|${type}|${limitStr}|${sizeStr}`;
  const placed = note?.at === inputs ? note.msg : null;
  const setPlaced = (msg: string) => setNote({ msg, at: inputs });
  const go = () => {
    if (size <= 0) return;
    if (gated && !crosses) return openSignIn();
    if (crosses) return submit(n);
    if (!wallet.signedIn) return openSignIn();
    if (n.outlay > wallet.balance) return setPlaced(`Not enough test dollars: this order needs ${usd0(n.outlay)} and you have ${usd0(wallet.balance)}.`);
    onPlace({ id: Math.random().toString(36).slice(2, 10), gpu: market.gpu, month: series.month, side: trade.side, price, q: size, daily: false, placedAt: new Date().toISOString() });
    setPlaced(`${L ? "Long" : "Short"} ${int(size)} GPU-hours at ${usd(price)} is waiting in the book.`);
  };

  return (
    <div className={s.ticket}>
      <div className={s.side} role="group" aria-label="Side">
        <button aria-pressed={L} data-side="long" onClick={() => trade.setSide("long")}>
          Long
        </button>
        <button aria-pressed={!L} data-side="short" onClick={() => trade.setSide("short")}>
          Short
        </button>
      </div>

      <div className={s.typeTabs} role="tablist" aria-label="Order type">
        {(["market", "limit"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={type === t} onClick={() => setType(t)}>
            {t === "market" ? "Market" : "Limit"}
          </button>
        ))}
        <span className={s.month}>
          {m} {market.gpu}
        </span>
      </div>

      <dl className={s.facts}>
        <div>
          <dt>Available to trade</dt>
          <dd>{wallet.signedIn ? <><Num>{int(wallet.balance)}</Num> test dollars</> : "Sign in to see"}</dd>
        </div>
        <div>
          <dt>Current position</dt>
          <dd>{position === 0 ? "None" : <>{position > 0 ? "Long" : "Short"} <Num>{int(Math.abs(position))}</Num> GPU-hours</>}</dd>
        </div>
      </dl>

      {type === "limit" && (
        <div className={s.group}>
          <label className={s.input}>
            <span>Limit price</span>
            <input inputMode="decimal" placeholder={book.toFixed(2)} value={limitStr} onChange={(e) => setLimitStr(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={limitStr !== "" && !limitOk} />
            <em>USD per GPU-hour</em>
          </label>
          <div className={s.chips}>
            {(
              [
                ["Bid", q.bid],
                ["Mid", Math.round(((q.bid + q.ask) / 2) * 100) / 100],
                ["Ask", q.ask],
              ] as [string, number][]
            ).map(([k, v]) => (
              <button key={k} onClick={() => setLimitStr(v.toFixed(2))}>
                {k} <Num>{usd(v)}</Num>
              </button>
            ))}
          </div>
          {limitStr !== "" && !limitOk ? <p className={s.warn}>A limit has to sit between the floor {usd(series.floor)} and the ceiling {usd(series.cap)}.</p> : <p className={s.help}>Good till canceled.</p>}
        </div>
      )}

      <div className={s.group}>
        <label className={s.input}>
          <span>Size</span>
          <input inputMode="numeric" value={sizeStr} onChange={(e) => setSizeStr(e.target.value.replace(/[^0-9]/g, ""))} />
          <em>GPU-hours</em>
        </label>
        <div className={s.chips}>
          {[25, 50, 75, 100].map((p) => (
            <button key={p} disabled={maxSize === 0} onClick={() => setSizeStr(String(Math.floor((maxSize * p) / 100)))}>
              {p === 100 ? "Max" : `${p}%`}
            </button>
          ))}
        </div>
        <p className={s.help}>{size > 0 ? `About ${gpusAllMonth >= 10 ? Math.round(gpusAllMonth) : gpusAllMonth.toFixed(gpusAllMonth % 1 ? 1 : 0)} GPUs for all of ${m}.` : "One GPU for a day is 24 GPU-hours."}</p>
      </div>

      {canDaily ? (
        <label className={s.check}>
          <input type="checkbox" checked={trade.daily} onChange={(e) => trade.setDaily(e.target.checked)} />
          <span className={s.box} aria-hidden="true" />
          <span>
            Pay me daily <em>{L ? "floor back now, then daily" : "a share every morning"}</em>
          </span>
        </label>
      ) : (
        <p className={s.help}>An order that waits in the book fills on Kuru directly, so it settles at the end of {m}, not daily.</p>
      )}

      <dl className={s.sum}>
        <div>
          <dt>{L ? "Order value" : "Collateral"}</dt>
          <dd>
            <Num>{usd0(n.outlay)}</Num>
          </dd>
        </div>
        {n.backNow > 0 && (
          <div>
            <dt>Back right away</dt>
            <dd>
              <Num>{usd0(n.backNow)}</Num>
            </dd>
          </div>
        )}
        <div>
          <dt>
            Max loss <span>{config.risk === "settle" ? `settles at ${usd(worst)}` : `at ${usd(worst)} or ${L ? "less" : "more"}`}</span>
          </dt>
          <dd>
            <Num>{usd0(n.maxLoss)}</Num>
          </dd>
        </div>
        <div>
          <dt>
            Max gain <span>{config.risk === "settle" ? `settles at ${usd(best)}` : `at ${usd(best)} or ${L ? "more" : "less"}`}</span>
          </dt>
          <dd>
            <Num>{usd0(n.maxGain)}</Num>
          </dd>
        </div>
        <div>
          <dt>Liquidation</dt>
          <dd className={s.good}>None, fully backed</dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd>None on testnet</dd>
        </div>
      </dl>

      <button className={s.cta} data-side={trade.side} disabled={size <= 0 || (type === "limit" && !limitOk)} onClick={go}>
        {gated ? (
          "Sign in to trade"
        ) : (
          <>
            {L ? "Long" : "Short"} <Num>{int(size)}</Num> GPU-hours {crosses ? "at" : "limit"} <Num>{usd(crosses ? fillPrice : price)}</Num>
          </>
        )}
      </button>
      {gated && <p className={s.note}>Free to try: 10,000 test dollars a day.</p>}
      {!gated && (placed ? <p className={s.note}>{placed}</p> : type === "limit" && limitOk && !crosses && <p className={s.note}>Rests in the book until it fills or you cancel it.</p>)}
    </div>
  );
}
