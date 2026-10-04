"use client";
// Ticket state and its numbers (the router's openLong / openShort, with pay me daily = streamOut).
import { useMemo, useState } from "react";
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
  const tradable = market.series.filter((s) => s.phase === "trading" || s.phase === "paying");
  const [month, setMonth] = useState(tradable[0]?.month ?? market.series[0].month);
  const [side, setSide] = useState<Side>("long");
  const [gpus, setGpus] = useState(2);
  const [daily, setDaily] = useState(true);

  const series = market.series.find((s) => s.month === month) ?? market.series[0];

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
