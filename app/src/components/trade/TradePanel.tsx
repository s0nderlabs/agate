"use client";
// The right-hand panel (round 4): which month, Long or Short, the price and what it means, size, pay me daily,
// what it costs and risks (tied to the floor and ceiling), one button. Sized so the button sits above the fold.
import { useFlow } from "@/components/markets/Flow";
import { useMemo, useState } from "react";
import { useBook } from "@/lib/data/hooks";
import { dateText, topOf } from "@/lib/data/derive";
import { emptySideText, MonthSeg } from "./States";
import { DRIP, useAccount } from "@/lib/account";
import { cleanTyping, dollarsToHours, floorCents, floorGpus, floorHours, fmtDollars, fmtGpus, fmtHours, gpuWord, hoursToDollars, maxFor, parseAmount, walkDollars, walkHours } from "@/lib/size";
import { SideToggle } from "./SideToggle";
import { monthName } from "@/components/markets/PriceChart";
import { numbersFor, type Trade } from "@/components/markets/useTrade";
import { Num } from "@/components/num/Num";
import type { Market } from "@/lib/mock/types";
import { int, usd, usd0 } from "@/lib/format";
import s from "./trade.module.css";

/** held: test dollars already promised to resting limit orders (placed in Pro), so they cannot be spent twice.
 * loading: the first read is on its way (prices under skeletons, the button waits). stale: the prices are old (no
 * fresh read for two minutes), so the button waits for fresh ones. */
export function TradePanel({ market, trade, held = 0, loading: marketLoading = false, stale = "none" }: { market: Market; trade: Trade; held?: number; loading?: boolean; stale?: "none" | "stale" | "nodata" }) {
  const { submit, openSignIn } = useFlow();
  const account = useAccount();
  const gated = !account.ready;
  // Simple's size: one amount, in dollars (Polymarket, Kalshi, Public default) or in GPUs
  // for the month (the hedger's own words); either way the GPU-hours, fractions included, fall out of it
  const [unit, setUnit] = useState<"usd" | "gpus">("usd");
  const [amt, setAmt] = useState("1,000");
  const side = trade.side;
  const s0 = trade.n.series;
  // the month's book (empty while it is not listed): the walk and the prices on Long / Short read the same levels
  const bq = useBook(s0);
  const b = bq.book;
  const levels = useMemo(() => (side === "long" ? b.asks : b.bids), [b, side]);
  const top = topOf(b, s0.quote);
  // prices are not known until the markets read and the month's book have both answered (a book that could not be
  // read is not an empty one)
  const loading = marketLoading || bq.loading;
  // one side of a loaded book is empty (nobody selling, or nobody buying): that side has no price and cannot fill
  const known = !loading;
  const noAsk = known && !b.asks.length;
  const noBid = known && !b.bids.length;
  const none = side === "long" ? noAsk : noBid;
  // skeletons masked on their own (ag-skel-on): the book can still be on its way after the screen has loaded
  const skel = loading ? "ag-skel ag-skel-on" : undefined;
  // a figure under a skeleton while loading (wrapped only then, so the normal markup is unchanged)
  const sk = (v: React.ReactNode) => (loading ? <span className={skel}>{v}</span> : v);
  const days = s0.n;
  const typed = parseAmount(amt) ?? 0;
  const fill = unit === "usd" ? walkDollars(levels, side, typed, s0.cap) : walkHours(levels, side, floorHours(typed * 24 * days), s0.cap);
  // more than the book holds now: say so and offer what fills (agate's ThinBook rule, never fill less silently)
  const thin = unit === "usd" ? typed - fill.outlay > 0.01 : fill.short;
  const signedIn = account.ready;
  // signed out, the 25% / 50% / Max chips work on the free test dollars you get at sign-in
  const balance = signedIn ? Math.max(0, account.balance - held) : DRIP;
  const max = maxFor(levels, side, balance, s0.cap);
  const n = numbersFor(s0, side, fill.filled, trade.daily, fill.avg);
  const over = fill.filled > 0 && n.outlay > balance + 0.005;
  const setShare = (p: number) => {
    if (unit === "usd") return setAmt(fmtDollars(floorCents((max.dollars * p) / 100)));
    setAmt(fmtGpus(floorGpus(floorHours((max.hours * p) / 100) / (24 * days))));
  };
  const swapUnit = (u: "usd" | "gpus") => {
    if (u === unit) return;
    // convert what was asked for, not what fills, so a request bigger than the book keeps its warning
    setAmt(u === "usd" ? fmtDollars(floorCents(hoursToDollars(levels, side, floorHours(typed * 24 * days), s0.cap))) : fmtGpus(floorGpus(dollarsToHours(levels, side, typed, s0.cap) / (24 * days))));
    setUnit(u);
  };
  const walks = fill.filled > 0 && Math.abs(fill.avg - (levels[0]?.price ?? fill.avg)) >= 0.0005;
  const L = n.side === "long";
  const m = monthName(n.series.month);
  const open = trade.months.filter((sr) => sr.phase !== "upcoming");
  // the month after this one, when it is not open yet (never the ticket's own month)
  const next = loading ? undefined : trade.months.find((sr) => sr.phase === "upcoming" && sr.month !== n.series.month);
  // the button waits while prices load, and once they are two minutes old (it says which)
  const wait = marketLoading || (bq.loading && !bq.error) ? "Loading prices" : stale === "stale" ? "Waiting for fresh prices" : stale === "nodata" || bq.loading ? "Waiting for prices" : null;
  const worst = L ? n.series.floor : n.series.cap;
  const best = L ? n.series.cap : n.series.floor;
  // what a dollar comes to on this side at the book's top (a Long pays the ask, a Short puts up ceiling minus bid);
  // no number until a price is known
  const perUnit = loading || none ? 0 : L ? top.ask : s0.cap - top.bid;
  const perDollar = perUnit > 0 ? `Any amount works. $1 is about ${(Math.round((1 / perUnit) * 100) / 100).toLocaleString("en-US")} GPU-hours at this price.` : "Any amount works.";
  return (
    <div className={s.ticket}>
      {/* one month open: say so in a line; a control with one live choice and one disabled one is noise */}
      <div className={s.tTop}>
        {open.length > 1 ? (
          <MonthSeg trade={trade} />
        ) : (
          <b>
            {m} {market.gpu}
          </b>
        )}
        {next && <span>{monthName(next.month)} opens {dateText(next.opensOn ?? `${next.month}-01`)}</span>}
      </div>

      <SideToggle side={trade.side} onSide={trade.setSide} ask={noAsk ? null : top.ask} bid={noBid ? null : top.bid} skel={loading} />

      {/* with nobody on this side there is no price to gain against: the line under the amount says so instead */}
      {!none && (
        <p className={s.tCopy}>
          {L ? (
            <>
              Gains if {m}'s average {market.gpu} price comes in above <b className={skel}>{usd(n.price)}</b>. Protects a GPU bill from rising prices.
            </>
          ) : (
            <>
              Gains if {m}'s average {market.gpu} price comes in below <b className={skel}>{usd(n.price)}</b>. Protects GPU income from falling prices.
            </>
          )}
        </p>
      )}

      <div className={s.amount}>
          <div className={s.amountHead}>
            <span>Amount</span>
            <div className={s.unitSeg} role="group" aria-label="Amount in">
              <button aria-pressed={unit === "usd"} onClick={() => swapUnit("usd")}>
                Dollars
              </button>
              <button aria-pressed={unit === "gpus"} onClick={() => swapUnit("gpus")}>
                GPUs
              </button>
            </div>
          </div>
          <label className={s.amountBox}>
            {unit === "usd" && <span className={s.amountPre}>$</span>}
            <input
              inputMode="decimal"
              enterKeyHint="done"
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              value={amt}
              placeholder="0"
              aria-label={unit === "usd" ? "Amount in dollars" : "GPUs for the whole month"}
              onChange={(e) => setAmt(cleanTyping(e.target.value, unit === "usd" ? 2 : 4))}
              onBlur={() => setAmt(unit === "usd" ? fmtDollars(floorCents(typed)) : fmtGpus(floorGpus(typed)))}
            />
            {unit === "gpus" && <span className={s.amountPost}>{gpuWord(typed)}, all of {m}</span>}
          </label>
          <div className={s.amountRow}>
            <div className={s.amountChips}>
              {[25, 50, 100].map((p) => (
                <button key={p} onClick={() => setShare(p)}>
                  {p === 100 ? "Max" : `${p}%`}
                </button>
              ))}
            </div>
            <span>{signedIn ? <><Num>{int(balance)}</Num> test dollars to use</> : <><Num>{int(DRIP)}</Num> free test dollars at sign-in</>}</span>
          </div>
          {none ? (
            <p className={s.amountWarn} key="none">
              {emptySideText(n.series, L)}
            </p>
          ) : !loading && thin ? (
            <p className={s.amountWarn} key="thin">
              Only {unit === "usd" ? usd(floorCents(fill.outlay)) : `${fmtGpus(floorGpus(fill.filled / (24 * days)))} GPUs`} fills right now.{" "}
              <button
                type="button"
                className={s.textBtn}
                onClick={() => setAmt(unit === "usd" ? fmtDollars(floorCents(fill.outlay)) : fmtGpus(floorGpus(fill.filled / (24 * days))))}
              >
                Use that
              </button>
            </p>
          ) : over ? (
            <p className={s.amountWarn} key="over">
              {signedIn ? `More than your ${int(balance)} test dollars.` : `More than the ${int(DRIP)} free test dollars.`}{" "}
              <button type="button" className={s.textBtn} onClick={() => setShare(100)}>
                Use max
              </button>
            </p>
          ) : (
            <p className={s.amountEcho}>
              {fill.filled > 0 ? (
                unit === "usd" ? (
                  <>
                    = <Num>{fmtHours(fill.filled)}</Num> GPU-hours
                    {fill.filled >= 0.01 * 24 * days && (
                      <>
                        , about <Num>{fmtGpus(Math.round((fill.filled / (24 * days)) * 100) / 100)}</Num> {gpuWord(fill.filled / (24 * days))} for all of {m}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    = <Num>{fmtHours(fill.filled)}</Num> GPU-hours, <Num>{usd(n.outlay)}</Num>
                  </>
                )
              ) : unit === "usd" ? (
                sk(perDollar)
              ) : (
                <>One GPU for all of {m} is {int(24 * days)} GPU-hours. Halves work too.</>
              )}
            </p>
          )}
        </div>

      <label className={s.toggle}>
        <input type="checkbox" checked={trade.daily} onChange={(e) => trade.setDaily(e.target.checked)} />
        <span className={s.switch} aria-hidden="true" />
        <span className={s.toggleText}>
          <b>Pay me daily</b>
          <span>{L ? "Get the floor back now, then a share every morning." : "Get your share every morning, not once at the end."}</span>
        </span>
      </label>

      {/* with nobody on this side nothing fills, so there is nothing to sum up */}
      {!none && (
        <dl className={s.sum}>
          {walks && (
            <div>
              <dt>
                Average price <span className={s.hint}>across the book's prices</span>
              </dt>
              <dd>
                <Num>{`$${n.price.toFixed(3)}`}</Num>
              </dd>
            </div>
          )}
          <div>
            <dt>{L ? "You pay" : "You put up"}</dt>
            <dd className={skel}>
              <Num>{usd0(n.outlay)}</Num>
            </dd>
          </div>
          {n.daily && L && (
            <div>
              <dt>Back right away</dt>
              <dd className={skel}>
                <Num>{usd0(n.backNow)}</Num>
              </dd>
            </div>
          )}
          <div>
            <dt>
              Most you can lose{" "}
              <span className={s.hint}>{sk(`if it averages ${usd(worst)} or ${L ? "less" : "more"}`)}</span>
            </dt>
            <dd className={skel}>
              <Num>{usd0(n.maxLoss)}</Num>
            </dd>
          </div>
          <div>
            <dt>
              Most you can make{" "}
              <span className={s.hint}>{sk(`if it averages ${usd(best)} or ${L ? "more" : "less"}`)}</span>
            </dt>
            <dd className={skel}>
              <Num>{usd0(n.maxGain)}</Num>
            </dd>
          </div>
        </dl>
      )}

      {/* signed out: everything above works, the button asks for sign-in and keeps this order for review after */}
      {/* signed out, an empty or too-big amount still opens sign-in, but the order is not carried through it */}
      {/* the button and its line stay pinned at the bottom of the ticket on phones and tablets (no box on desktop) */}
      <div className={s.ctaBar}>
        <button
          className={s.cta}
          data-side={n.side}
          data-gate={gated}
          disabled={wait !== null || (!gated && (none || fill.filled <= 0 || thin || (over && held > 0)))}
          onClick={() => (gated && (none || fill.filled <= 0 || thin) ? openSignIn() : submit(n))}
        >
          {wait ?? (gated ? (
            "Sign in to trade"
          ) : none ? (
            L ? "No sellers right now" : "No buyers right now"
          ) : fill.filled <= 0 ? (
            "Enter an amount"
          ) : unit === "usd" ? (
            <>
              {L ? "Long" : "Short"} <Num>{floorCents(typed) % 1 ? usd(floorCents(typed)) : usd0(typed)}</Num>
            </>
          ) : (
            <>
              {L ? "Long" : "Short"} <Num>{fmtGpus(typed)}</Num> {gpuWord(typed)} for {m}
            </>
          ))}
        </button>
        <p className={s.fine}>
          {gated ? "Free to try: 10,000 test dollars a day. Your order stays as you set it." : <>{n.daily ? `Paid a share every morning from ${m.slice(0, 3)} 2.` : `Paid once, after ${m} ends.`} Fully backed, no margin calls.</>}
        </p>
      </div>
    </div>
  );
}
