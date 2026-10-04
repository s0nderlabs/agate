"use client";
// The right-hand panel (round 4): which month, Long or Short, the price and what it means, size, pay me daily,
// what it costs and risks (tied to the floor and ceiling), one button. Sized so the button sits above the fold.
import { useState } from "react";
import { useFlow } from "@/components/markets/Flow";
import { useMock } from "@/lib/mock/store";
import { monthName } from "@/components/markets/PriceChart";
import type { Trade } from "@/components/markets/useTrade";
import { Num } from "@/components/num/Num";
import type { Market } from "@/lib/mock/types";
import { int, usd, usd0 } from "@/lib/format";
import s from "./trade.module.css";

export function TradePanel({ market, trade, pro }: { market: Market; trade: Trade; pro: boolean }) {
  const { submit } = useFlow();
  const { config, wallet } = useMock();
  const gated = config.gate === "signin" && !wallet.signedIn;
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const { n } = trade;
  const L = n.side === "long";
  const m = monthName(n.series.month);
  const [limit, setLimit] = useState("");
  // this ticket only fills now: a limit at or through the book fills at the book price, shown on the button; a limit
  // that would wait in the book belongs to the order ticket. Simple has no limits, whatever Pro left set.
  const lim = Number(limit);
  const useLimit = pro && orderType === "limit" && limit !== "" && lim > 0;
  const waits = useLimit && (L ? lim < n.price : lim > n.price);
  const open = trade.months.filter((sr) => sr.phase !== "upcoming");
  const next = trade.months.find((sr) => sr.phase === "upcoming");
  const worst = L ? n.series.floor : n.series.cap;
  const best = L ? n.series.cap : n.series.floor;
  return (
    <div className={s.ticket}>
      {/* one month open: say so in a line; a control with one live choice and one disabled one is noise */}
      <div className={s.tTop}>
        {open.length > 1 ? (
          <div className={s.seg} role="group" aria-label="Month">
            {open.map((sr) => (
              <button key={sr.month} aria-pressed={trade.month === sr.month} onClick={() => trade.setMonth(sr.month)}>
                {monthName(sr.month)}
              </button>
            ))}
          </div>
        ) : (
          <b>
            {m} {market.gpu}
          </b>
        )}
        {next && <span>{monthName(next.month)} opens Nov 1</span>}
      </div>

      <div className={`${s.seg} ${s.side}`} role="group" aria-label="Side">
        <button aria-pressed={L} onClick={() => trade.setSide("long")}>
          Long
        </button>
        <button aria-pressed={!L} onClick={() => trade.setSide("short")}>
          Short
        </button>
      </div>

      <div className={s.tPriceRow}>
        <div className={s.tPrice}>
          <b className="font-display ag-skel">{usd(useLimit ? lim : n.price)}</b>
          <span>per GPU-hour, {useLimit ? "your limit" : L ? "the ask" : "the bid"}</span>
        </div>
        {pro && (
          <div className={s.seg} role="group" aria-label="Order type">
            <button aria-pressed={orderType === "market"} onClick={() => setOrderType("market")}>
              Market
            </button>
            <button aria-pressed={orderType === "limit"} onClick={() => setOrderType("limit")}>
              Limit
            </button>
          </div>
        )}
      </div>
      {pro && orderType === "limit" && (
        <label className={s.field}>
          <span>Limit price</span>
          <input id="limit-price" inputMode="decimal" placeholder={n.price.toFixed(2)} value={limit} onChange={(e) => setLimit(e.target.value)} />
        </label>
      )}

      <p className={s.tCopy}>
        {L ? (
          <>
            Gains if {m}'s average {market.gpu} price comes in above <b>{usd(n.price)}</b>. Protects a GPU bill from rising prices.
          </>
        ) : (
          <>
            Gains if {m}'s average {market.gpu} price comes in below <b>{usd(n.price)}</b>. Protects GPU income from falling prices.
          </>
        )}
      </p>

      <div>
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
          {trade.gpus} × 24 h × {n.series.n} days = <b><Num>{int(n.hours)}</Num> GPU-hours</b>
        </p>
      </div>

      <label className={s.toggle}>
        <input type="checkbox" checked={trade.daily} onChange={(e) => trade.setDaily(e.target.checked)} />
        <span className={s.switch} aria-hidden="true" />
        <span className={s.toggleText}>
          <b>Pay me daily</b>
          <span>{L ? "Get the floor back now, then a share every morning." : "Get your share every morning, not once at the end."}</span>
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
          <dt>
            Most you can lose{" "}
            <span className={s.hint}>
              {config.risk === "settle" ? `if it settles at ${usd(worst)}` : `if it averages ${usd(worst)} or ${L ? "less" : "more"}`}
            </span>
          </dt>
          <dd>
            <Num>{usd0(n.maxLoss)}</Num>
          </dd>
        </div>
        <div>
          <dt>
            Most you can make{" "}
            <span className={s.hint}>{config.risk === "settle" ? `if it settles at ${usd(best)}` : `if it averages ${usd(best)} or ${L ? "more" : "less"}`}</span>
          </dt>
          <dd>
            <Num>{usd0(n.maxGain)}</Num>
          </dd>
        </div>
      </dl>

      {/* signed out: everything above works, the button asks for sign-in and keeps this order for review after */}
      <button className={s.cta} disabled={!gated && waits} onClick={() => submit(n)}>
        {gated ? "Sign in to trade" : <>{L ? "Long" : "Short"} at {usd(n.price)}</>}
      </button>
      <p className={s.fine}>
        {gated ? "Free to try: 10,000 test dollars a day. Your order stays as you set it." : waits ? `Your limit is ${L ? "under the ask" : "over the bid"}, so it would wait in the book. This ticket only fills now.` : <>{n.daily ? "Paid a share every morning from Nov 2." : `Paid once, after ${m} ends.`} Fully backed, no margin calls.</>}
      </p>
    </div>
  );
}
