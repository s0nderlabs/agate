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
import { useBook } from "@/lib/data/hooks";
import { topOf } from "@/lib/data/derive";
import { emptySideText } from "./States";
import { useMock } from "@/lib/mock/store";
import { cleanTyping, dollarsToHours, floorCents, floorHours, fmtDollars, fmtGpus, fmtHours, gpuWord, hoursToDollars, LIMIT_MAX, LIMIT_MIN, maxFor, parseAmount, walkDollars, walkHours } from "@/lib/size";
import { SideToggle } from "./SideToggle";
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
  /** test dollars the order holds while it rests (the price for a Long, ceiling - price for a Short, per GPU-hour) */
  hold: number;
  daily: boolean;
  placedAt: string;
}

/** held: test dollars already promised to resting orders; they are not free to trade again. loading: the first read
 * is on its way (prices under skeletons, the button waits). stale: no fresh prices for two minutes (the button waits). */
export function OrderTicket({ market, trade, picked, held, onPlace, loading: marketLoading = false, stale = "none" }: { market: Market; trade: Trade; picked: { price: number; n: number } | null; held: number; onPlace: (o: OpenOrder) => void; loading?: boolean; stale?: "none" | "stale" | "nodata" }) {
  const { submit, openSignIn } = useFlow();
  const { wallet, config } = useMock();
  // live prices on a practice wallet: a resting order is saved in this browser only, and says so
  const practice = config.source === "live";
  const series = trade.n.series;
  // the month's book (empty while it is not listed); its top is the quote, so the walk and the labels agree
  const bq = useBook(series);
  const bk = bq.book;
  const q = topOf(bk, series.quote);
  const L = trade.side === "long";
  // prices are not known until the markets read and the month's book have both answered (a book that could not be
  // read is not an empty one)
  const loading = marketLoading || bq.loading;
  // one side of a loaded book is empty: no price on it, and a market order there cannot fill
  const known = !loading;
  const noAsk = known && !bk.asks.length;
  const noBid = known && !bk.bids.length;
  // skeletons masked on their own (ag-skel-on): the book can still be on its way after the screen has loaded
  const skel = loading ? "ag-skel ag-skel-on" : undefined;
  const sk = (v: React.ReactNode) => (loading ? <span className={skel}>{v}</span> : v);
  const [type, setType] = useState<"market" | "limit">("market");
  const [limitStr, setLimitStr] = useState("");
  const [sizeStr, setSizeStr] = useState(fmtHours(trade.n.hours));
  // Size in GPU-hours or in dollars, one tap apart (Hyperliquid, Coinbase Advanced, Lighter, dYdX, Drift)
  const [unit, setUnit] = useState<"hours" | "usd">("hours");
  const [note, setNote] = useState<{ msg: string; at: string } | null>(null);

  // a click on a book row lands here: switch to Limit at that price. A pick made before this ticket mounted
  // (on another GPU, or before a Simple/Pro switch) is not applied again.
  const seenPick = useRef(picked?.n ?? 0);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (!picked || picked.n === seenPick.current) return;
    seenPick.current = picked.n;
    setFlash((f) => f + 1);
    setType("limit");
    setLimitStr(picked.price.toFixed(2));
  }, [picked]);

  const top = L ? q.ask : q.bid;
  const none = type === "market" && (L ? noAsk : noBid);
  const limit = Number(limitStr);
  const limitOk = type === "limit" && limitStr !== "" && limit > series.floor && limit < series.cap;
  const price = type === "market" ? top : limitOk ? limit : top;
  // a limit at or through the book fills now; otherwise it rests as an open order
  // (only against a side that has orders: with nobody selling, a Long limit can only rest, and that is the point of it)
  const crosses = type === "market" || (limitOk && (L ? bk.asks.length > 0 && limit >= q.ask : bk.bids.length > 0 && limit <= q.bid));
  // pay me daily runs through agate's router: a market order or a limit that fills now can use it; an order that
  // waits in the book fills on Kuru directly and settles at the end of the month instead (@agate/client, Oct 4)
  const canDaily = crosses;
  const daily = canDaily && trade.daily;
  // what fills: an order that fills now walks the book best price first (its average is the fill price), a limit
  // only as far as its own price; a resting limit fills at its own price. Steps: 0.0001 GPU-hour, dollars in cents.
  const levels = useMemo(() => {
    const side = L ? bk.asks : bk.bids;
    return limitOk ? side.filter((l) => (L ? l.price <= limit : l.price >= limit)) : side;
  }, [bk, L, limitOk, limit]);
  const typed = parseAmount(sizeStr) ?? 0;
  const restPer = L ? price : series.cap - price;
  const walk = crosses ? (unit === "usd" ? walkDollars(levels, trade.side, typed, series.cap) : walkHours(levels, trade.side, floorHours(typed), series.cap)) : null;
  const size = walk ? walk.filled : unit === "usd" ? (restPer > 0 ? floorHours(typed / restPer) : 0) : floorHours(typed);
  const fillPrice = walk ? walk.avg : price;
  // more than the book holds right now: say so, never fill less without asking (agate's ThinBook rule)
  const thin = !loading && !none && !!walk && (unit === "usd" ? typed - walk.outlay > 0.01 : walk.short);
  const depth = levels.reduce((a, l) => a + l.size, 0);
  const balance = wallet.signedIn ? Math.max(0, wallet.balance - held) : 0;
  const max = crosses ? maxFor(levels, trade.side, balance, series.cap) : { hours: restPer > 0 ? Math.min(LIMIT_MAX, floorHours(balance / restPer)) : 0, dollars: balance, bookBound: false };
  const maxSize = max.hours;
  // Kuru takes resting limits of 1 to 1,000,000 GPU-hours
  const belowLimitMin = type === "limit" && !crosses && size > 0 && size < LIMIT_MIN;
  const aboveLimitMax = type === "limit" && !crosses && size > LIMIT_MAX;
  const over = wallet.signedIn && size > 0 && (L ? fillPrice : series.cap - fillPrice) * size > balance + 0.005;
  const pct = maxSize > 0 ? Math.min(100, Math.round((size / maxSize) * 100)) : 0;
  // the slider and the % box set the size as a share of what the balance (and the book) allow
  const setShare = (p: number) => {
    const h = floorHours((maxSize * Math.max(0, Math.min(100, p))) / 100);
    setSizeStr(unit === "hours" ? fmtHours(h) : fmtDollars(floorCents(crosses ? walkHours(levels, trade.side, h, series.cap).outlay : h * restPer)));
  };

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

  const gated = !wallet.signedIn;
  // the button waits while prices load, and once they are two minutes old (it says which)
  const wait = marketLoading || (bq.loading && !bq.error) ? "Loading prices" : stale === "stale" ? "Waiting for fresh prices" : stale === "nodata" || bq.loading ? "Waiting for prices" : null;
  const inputs = `${trade.side}|${type}|${limitStr}|${sizeStr}`;
  const placed = note?.at === inputs ? note.msg : null;
  const setPlaced = (msg: string) => setNote({ msg, at: inputs });
  const go = () => {
    if (size <= 0) return;
    if (gated && !crosses) return openSignIn();
    // an order that fills now goes through the review sheets, unless open orders hold the dollars it needs
    if (crosses && !(over && held > 0)) return submit(n);
    if (!wallet.signedIn) return openSignIn();
    if (n.outlay > balance + 0.005) return setPlaced(`Not enough test dollars: this order needs ${usd0(n.outlay)} and ${usd0(balance)} is free${held > 0 ? ` (${usd0(held)} is held by your open orders)` : ""}.`);
    onPlace({ id: Math.random().toString(36).slice(2, 10), gpu: market.gpu, month: series.month, side: trade.side, price, q: size, hold: n.outlay, daily: false, placedAt: new Date().toISOString() });
    setPlaced(practice ? "Practice order: it waits here until you cancel it or reload the page." :`${L ? "Long" : "Short"} ${fmtHours(size)} GPU-hours at ${usd(price)} is waiting in the book.`);
  };

  return (
    <div className={s.ticket}>
      <SideToggle side={trade.side} onSide={trade.setSide} ask={noAsk ? null : q.ask} bid={noBid ? null : q.bid} skel={loading} />

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
          <dd>{wallet.signedIn ? <><Num>{int(balance)}</Num> test dollars</> : "Sign in to see"}</dd>
        </div>
        <div>
          <dt>Current position</dt>
          <dd>{position === 0 ? "None" : <>{position > 0 ? "Long" : "Short"} <Num>{fmtHours(Math.abs(position))}</Num> GPU-hours</>}</dd>
        </div>
      </dl>

      {type === "limit" && (
        <div className={s.group}>
          <label className={s.input} key={`limit-${flash}`} data-flash={flash > 0 || undefined}>
            <span>Limit price</span>
            <input inputMode="decimal" enterKeyHint="done" onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} placeholder={top > 0 ? top.toFixed(2) : ""} value={limitStr} onChange={(e) => setLimitStr(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={limitStr !== "" && !limitOk} />
            <em>USD per GPU-hour</em>
          </label>
          <div className={s.chips}>
            {(
              [
                ["Bid", noBid ? 0 : q.bid],
                ["Mid", noAsk || noBid ? 0 : Math.round(((q.bid + q.ask) / 2) * 100) / 100],
                ["Ask", noAsk ? 0 : q.ask],
              ] as [string, number][]
            )
              // a side with nobody on it has no price to pick (and no middle)
              .filter(([, v]) => loading || v > 0)
              .map(([k, v]) => (
              <button key={k} onClick={() => setLimitStr(v.toFixed(2))}>
                {k} {sk(<Num>{usd(v)}</Num>)}
              </button>
            ))}
          </div>
          {limitStr !== "" && !limitOk ? <p className={s.warn}>A limit has to sit between the floor {usd(series.floor)} and the ceiling {usd(series.cap)}.</p> : <p className={s.help}>Good till canceled.</p>}
        </div>
      )}

      <div className={s.group}>
        <label className={s.input}>
          <span>Size</span>
          <input
            inputMode="decimal"
            enterKeyHint="done"
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            value={sizeStr}
            onChange={(e) => setSizeStr(cleanTyping(e.target.value, unit === "usd" ? 2 : 4))}
            onBlur={() => setSizeStr(unit === "usd" ? fmtDollars(floorCents(typed)) : fmtHours(floorHours(typed)))}
          />
          {(
            <button
              type="button"
              className={s.unit}
              title={unit === "hours" ? "Size in dollars instead" : "Size in GPU-hours instead"}
              onClick={() => {
                // convert what was asked for, not what fills, so a request bigger than the book keeps its warning
                const h = floorHours(typed);
                setSizeStr(
                  unit === "hours"
                    ? fmtDollars(floorCents(crosses ? hoursToDollars(levels, trade.side, h, series.cap) : h * restPer))
                    : fmtHours(floorHours(crosses ? dollarsToHours(levels, trade.side, typed, series.cap) : restPer > 0 ? typed / restPer : 0)),
                );
                setUnit(unit === "hours" ? "usd" : "hours");
              }}
            >
              {unit === "hours" ? "GPU-hours" : "USD"}
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path d="M3.5 1.5v9M1.5 8.5l2 2 2-2M8.5 10.5v-9M6.5 3.5l2-2 2 2" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
          )}
        </label>
        <div className={s.slider}>
            <input type="range" min={0} max={100} step={1} value={pct} disabled={maxSize === 0} onChange={(e) => setShare(Number(e.target.value))} aria-label="Share of what you can trade" style={{ ["--p" as string]: `${pct}%` }} />
            <label className={s.pct}>
              <input inputMode="numeric" value={String(pct)} disabled={maxSize === 0} onChange={(e) => setShare(Number(e.target.value.replace(/[^0-9]/g, "")) || 0)} aria-label="Percent of what you can trade" />
              <span>%</span>
            </label>
          </div>
        {none ? (
          <p className={`${s.warn} ${s.sizeMsg}`} key="none">
            {emptySideText(series, L)}
          </p>
        ) : thin ? (
          <p className={`${s.warn} ${s.sizeMsg}`} key="thin">
            The book holds {fmtHours(depth)} GPU-hours{type === "limit" ? " at your limit or better" : ""} right now.{" "}
            <button type="button" className={s.linkBtn} onClick={() => { setUnit("hours"); setSizeStr(fmtHours(depth)); }}>
              Use {fmtHours(depth)}
            </button>
          </p>
        ) : belowLimitMin ? (
          <p className={`${s.warn} ${s.sizeMsg}`} key="min">Limit orders need at least {LIMIT_MIN} GPU-hour.</p>
        ) : aboveLimitMax ? (
          <p className={`${s.warn} ${s.sizeMsg}`} key="maxlim">
            Limit orders take at most {int(LIMIT_MAX)} GPU-hours.{" "}
            <button type="button" className={s.linkBtn} onClick={() => { setUnit("hours"); setSizeStr(fmtHours(LIMIT_MAX)); }}>
              Use {int(LIMIT_MAX)}
            </button>
          </p>
        ) : over ? (
          <p className={`${s.warn} ${s.sizeMsg}`} key="over">
            More than your {int(balance)} {held > 0 ? "free " : ""}test dollars.{" "}
            <button type="button" className={s.linkBtn} onClick={() => setShare(100)}>
              Use max
            </button>
          </p>
        ) : (
          <p className={`${s.help} ${s.sizeMsg}`}>
            {size > 0
              ? `${unit === "usd" ? `${fmtHours(size)} GPU-hours. ` : ""}${
                  gpusAllMonth >= 0.01 ? `About ${fmtGpus(Math.round(gpusAllMonth * 100) / 100)} ${gpuWord(gpusAllMonth)} for all of ${m}.` : `About ${fmtGpus(Math.round((size / 24) * 100) / 100 || 0.01)} GPU for a day.`
                }`
              : type === "limit"
                ? `Limit orders take ${int(LIMIT_MIN)} to ${int(LIMIT_MAX)} GPU-hours, in steps of 0.0001.`
                : "Any size from 0.0001 GPU-hour. One GPU for a day is 24."}
          </p>
        )}
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
          <dd className={skel}>
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
            Max loss <span>{sk(`at ${usd(worst)} or ${L ? "less" : "more"}`)}</span>
          </dt>
          <dd className={skel}>
            <Num>{usd0(n.maxLoss)}</Num>
          </dd>
        </div>
        <div>
          <dt>
            Max gain <span>{sk(`at ${usd(best)} or ${L ? "more" : "less"}`)}</span>
          </dt>
          <dd className={skel}>
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

      {/* the button and its line stay pinned at the bottom of the ticket on phones and tablets (no box on desktop) */}
      <div className={s.ctaBar}>
        <button className={s.cta} data-side={trade.side} data-gate={gated} disabled={wait !== null || none || size <= 0 || (type === "limit" && !limitOk) || thin || belowLimitMin || aboveLimitMax} onClick={go}>
          {wait ?? (gated ? (
            "Sign in to trade"
          ) : none ? (
            L ? "No sellers right now" : "No buyers right now"
          ) : (
            <>
              {L ? "Long" : "Short"} <Num>{fmtHours(size)}</Num> GPU-hours {crosses ? (walk && Math.abs(walk.avg - top) >= 0.0005 ? "at avg" : "at") : "limit"} <Num>{usd(crosses ? fillPrice : price)}</Num>
            </>
          ))}
        </button>
        {gated && <p className={s.note}>Free to try: 10,000 test dollars a day.</p>}
        {!gated && (placed ? <p className={s.note}>{placed}</p> : type === "limit" && limitOk && !crosses && <p className={s.note}>Rests in the book until it fills or you cancel it.</p>)}
      </div>
    </div>
  );
}
