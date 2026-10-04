"use client";
// The right-hand panel: one month, Long or Short, size in GPUs, pay me daily, what it costs and risks, one button.
import { useState } from "react";
import { useFlow } from "@/components/markets/Flow";
import { monthName } from "@/components/markets/PriceChart";
import type { Trade } from "@/components/markets/useTrade";
import { Num } from "@/components/num/Num";
import type { Market } from "@/lib/mock/types";
import { int, usd, usd0 } from "@/lib/format";
import s from "./trade.module.css";

export function TradePanel({ market, trade, pro }: { market: Market; trade: Trade; pro: boolean }) {
  const { submit } = useFlow();
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const { n } = trade;
  const L = n.side === "long";
  const m = monthName(n.series.month);
  const [limit, setLimit] = useState("");
  return (
    <div className={s.ticket}>
      <div className={s.tHead}>
        <div className={s.seg} role="group" aria-label="Month">
          {trade.months.map((sr) => (
            <button key={sr.month} aria-pressed={trade.month === sr.month} disabled={sr.phase === "upcoming"} onClick={() => trade.setMonth(sr.month)}>
              {sr.phase === "upcoming" ? `${monthName(sr.month).slice(0, 3)}, opens Nov 1` : monthName(sr.month)}
            </button>
          ))}
        </div>
      </div>

      <div className={`${s.seg} ${s.side}`} role="group" aria-label="Side">
        <button aria-pressed={L} onClick={() => trade.setSide("long")}>
          Long
        </button>
        <button aria-pressed={!L} onClick={() => trade.setSide("short")}>
          Short
        </button>
      </div>

      <div className={s.tPrice}>
        <b className="font-display ag-skel">{usd(n.price)}</b>
        <span>
          per GPU-hour, {L ? "the ask" : "the bid"} for {m}
        </span>
      </div>

      <p className={s.tCopy}>
        {L
          ? `Long pays you ${m}'s average ${market.gpu} price for every GPU-hour. It protects a GPU bill from rising prices.`
          : `Short pays you ${usd(n.series.cap)} minus ${m}'s average. You gain when the average comes in below ${usd(n.price)}.`}
      </p>

      {pro && (
        <div className={s.proRow}>
          <div className={s.seg} role="group" aria-label="Order type">
            <button aria-pressed={orderType === "market"} onClick={() => setOrderType("market")}>
              Market
            </button>
            <button aria-pressed={orderType === "limit"} onClick={() => setOrderType("limit")}>
              Limit
            </button>
          </div>
          {orderType === "limit" && (
            <label className={s.field}>
              <span>Limit price</span>
              <input id="limit-price" inputMode="decimal" placeholder={n.price.toFixed(2)} value={limit} onChange={(e) => setLimit(e.target.value)} />
            </label>
          )}
        </div>
      )}

      <div className={s.sizeRow}>
        <div className={s.field}>
          <span>GPUs</span>
          <div className={s.stepper}>
            <button aria-label="Fewer GPUs" onClick={() => trade.setGpus(trade.gpus - 1)}>
              −
            </button>
            <b>
              <Num>{String(trade.gpus)}</Num>
            </b>
            <button aria-label="More GPUs" onClick={() => trade.setGpus(trade.gpus + 1)}>
              +
            </button>
          </div>
        </div>
        <div className={s.field}>
          <span>Days in {m}</span>
          <div className={s.stepper}>
            <b>
              <Num>{String(n.series.n)}</Num>
            </b>
          </div>
        </div>
      </div>
      <p className={s.hours}>
        <Num>{int(n.hours)}</Num> GPU-hours
      </p>

      <label className={s.toggle}>
        <input type="checkbox" checked={trade.daily} onChange={(e) => trade.setDaily(e.target.checked)} />
        <span className={s.switch} aria-hidden="true" />
        <span className={s.toggleText}>
          <b>Pay me daily</b>
          <span>{L ? "Get the floor back now, then a share every morning. Locks the market rate." : "Get your share every morning instead of once at the end."}</span>
        </span>
      </label>

      <dl className={s.sum}>
        <div>
          <dt>{L ? "You pay" : "You put up"}</dt>
          <dd>
            <Num>{usd0(n.outlay)}</Num>
          </dd>
        </div>
        {n.daily && L && (
          <div>
            <dt>Back right away</dt>
            <dd>
              <Num>{usd0(n.backNow)}</Num>
            </dd>
          </div>
        )}
        <div>
          <dt>Most you can lose</dt>
          <dd>
            <Num>{usd0(n.maxLoss)}</Num>
          </dd>
        </div>
        <div>
          <dt>Most you can make</dt>
          <dd>
            <Num>{usd0(n.maxGain)}</Num>
          </dd>
        </div>
        {pro && (
          <div>
            <dt>Settles between</dt>
            <dd>
              <Num>{`${usd(n.series.floor)} and ${usd(n.series.cap)}`}</Num>
            </dd>
          </div>
        )}
      </dl>

      <button className={s.cta} onClick={() => submit(n)}>
        {L ? "Long" : "Short"} at {usd(n.price)}
      </button>
      <p className={s.fine}>{n.daily ? "Paid a share every morning from Nov 2." : `Paid once, after ${m} ends.`} Fully backed, no margin calls.</p>
    </div>
  );
}
