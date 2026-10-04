"use client";
// Ticket state and its numbers (the router's openLong / openShort, with pay me daily = streamOut).
import { useMemo, useState } from "react";
import { placeholderSeries } from "@/lib/data/derive";
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
  /** Long with pay me daily gets the floor back at once */
  backNow: number;
  maxLoss: number;
  maxGain: number;
}

export function useTrade(market: Market) {
  // a price-only GPU (B300, A100, L40S) has no month: the ticket lays out on a stand-in that has no band and no quote
  const stand = useMemo(() => placeholderSeries(market), [market]);
  const tradable = market.series.filter((s) => s.phase === "trading" || s.phase === "paying");
  // the month the reader picked, null until they pick one. Never seeded from the first render: live data arrives
  // after it, and the loading stand-in's month (the month after the next index price) would stick
  const [picked, setMonth] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("long");
  const [gpus, setGpus] = useState(2);
  const [daily, setDaily] = useState(true);

  // the picked month, else (none picked, or it settled away) the first open one
  const series = (picked ? market.series.find((s) => s.month === picked) : undefined) ?? tradable[0] ?? market.series[0] ?? stand;
  const month = series.month;

  const n = useMemo<TradeNumbers>(() => {
    const hours = 24 * gpus * series.n;
    const q = series.quote;
    const price = q ? (side === "long" ? q.ask : q.bid) : 0;
    const F = series.floor;
    const C = series.cap;
    const outlay = side === "long" ? price * hours : (C - price) * hours;
    const backNow = side === "long" && daily ? F * hours : 0;
    return {
      series,
      side,
      gpus,
      daily,
      hours,
      price,
      outlay,
      backNow,
      maxLoss: side === "long" ? (price - F) * hours : (C - price) * hours,
      maxGain: side === "long" ? (C - price) * hours : (price - F) * hours,
    };
  }, [series, side, gpus, daily]);

  return {
    n,
    months: market.series,
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
  const F = series.floor;
  const C = series.cap;
  const L = side === "long";
  return {
    series,
    side,
    gpus: hours / (24 * series.n),
    daily,
    hours,
    price,
    outlay: L ? price * hours : (C - price) * hours,
    backNow: L && daily ? F * hours : 0,
    maxLoss: L ? (price - F) * hours : (C - price) * hours,
    maxGain: L ? (C - price) * hours : (price - F) * hours,
  };
}
