"use client";
// Ticket state and its numbers (the router's openLong / openShort, with pay me daily = streamOut).
import { useMemo, useState } from "react";
import { bandNow, frontMonth, monthOpen, placeholderSeries } from "@/lib/data/derive";
import { useNow } from "@/lib/data/hooks";
import type { Market, Series, Side } from "@/lib/mock/types";

export interface TradeNumbers {
  series: Series;
  side: Side;
  gpus: number;
  daily: boolean;
  /** GPU-hours = tokens: sizeFor(gpus, n) = 24 x gpus x n */
  hours: number;
  /** the price the order fills at: Long buys at the ask, Short sells at the bid */
  price: number;
  /** what leaves the wallet: Long pays price x hours, Short puts up (ceiling - price) x hours */
  outlay: number;
  /** pay me daily's part paid at once: a Long the floor (in a month part paid, the priced days plus the floor for the
   *  days left), a Short its share of the priced days (none before the month starts) */
  backNow: number;
  maxLoss: number;
  maxGain: number;
}

/** one: the ticket keeps to one month, the next full one (Simple); otherwise the reader picks among the open months. */
export function useTrade(market: Market, { one = false }: { one?: boolean } = {}) {
  // a price-only GPU (B300, A100, L40S) has no month: the ticket lays out on a stand-in that has no band and no quote
  const stand = useMemo(() => placeholderSeries(market), [market]);
  const now = useNow();
  // the months that trade now: listed, priced, and their maker still quoting (a month in its last hour, or closed and
  // waiting for its last day to be final, is held and collected from Positions)
  const open = market.series.filter((s) => monthOpen(s, now));
  const front = frontMonth(market, now);
  // the month the reader picked, null until they pick one. Never seeded from the first render: live data arrives
  // after it, and the loading stand-in's month (the month after the next index price) would stick
  const [picked, setMonth] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("long");
  const [gpus, setGpus] = useState(2);
  const [daily, setDaily] = useState(true);

  // Simple: the next full month, even while it waits to open. Otherwise the picked month while it still trades, else
  // the next full one when it trades, else the first that does (December in the hours before January lists)
  const pick = !one && picked ? open.find((s) => s.month === picked) : undefined;
  const frontOpen = front && open.includes(front) ? front : undefined;
  const series = (one ? front : (pick ?? frontOpen ?? open[0] ?? front)) ?? market.series[0] ?? stand;
  const month = series.month;

  const n = useMemo<TradeNumbers>(() => {
    const q = series.quote;
    return numbersFor(series, side, 24 * gpus * series.n, daily, q ? (side === "long" ? q.ask : q.bid) : 0);
  }, [series, side, gpus, daily]);

  return {
    n,
    months: market.series,
    /** the months a reader can pick (Pro, and Simple while both are shown) */
    open,
    /** the month picker shows: more than one month trades and the ticket is not kept to one */
    pickable: !one && open.length > 1,
    month,
    setMonth,
    side,
    setSide,
    gpus,
    setGpus: (g: number) => setGpus(Math.max(1, Math.min(512, g))),
    daily,
    setDaily,
  };
}

export type Trade = ReturnType<typeof useTrade>;

/** The ticket's numbers for an explicit size in GPU-hours, filled at `price` (the average when it walks the book). */
export function numbersFor(series: Series, side: Side, hours: number, daily: boolean, price: number): TradeNumbers {
  const L = side === "long";
  // where the month can still end: the floor to the ceiling before it starts, narrower as its days are priced
  const b = bandNow(series);
  return {
    series,
    side,
    gpus: hours / (24 * series.n),
    daily,
    hours,
    price,
    outlay: L ? price * hours : (series.cap - price) * hours,
    backNow: daily ? (L ? b.longNow : b.shortNow) * hours : 0,
    maxLoss: L ? (price - b.lo) * hours : (b.hi - price) * hours,
    maxGain: L ? (b.hi - price) * hours : (price - b.lo) * hours,
  };
}
