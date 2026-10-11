"use client";
// The numbers How Agate works is explained with: the live H100 front month (the next full month the trade screen
// opens on) when it is listed with a two-sided book, else the market of Oct 8 the words were written on (H100
// November: floor $1.95, ceiling $8.00, 30 days, bid $3.95, ask $4.03, index $3.99), said as an example. One set
// always: a live index is never mixed with the example month.
import { monthName } from "@/components/markets/PriceChart";
import { useMarkets, useNow } from "@/lib/data/hooks";
import { frontMonth } from "@/lib/data/derive";

export type Worked = { live: boolean; month: string; floor: number; cap: number; days: number; ask: number; bid: number; index: number };

/** The H100 month the parts are worked on: live when read, else the Oct 8 market they were written on. */
export function useWorked(): Worked {
  const { markets } = useMarkets();
  const now = useNow();
  const m = markets?.find((x) => x.gpu === "H100");
  const f = m ? frontMonth(m, now) : undefined;
  const live = !!f && f.phase !== "upcoming" && f.cap > 0 && !!f.quote && f.quote.ask > 0 && f.quote.bid > 0;
  return {
    live,
    month: live ? monthName(f!.month) : "November",
    floor: live ? f!.floor : 1.95,
    cap: live ? f!.cap : 8,
    days: live ? f!.n : 30,
    ask: live ? f!.quote!.ask : 4.03,
    bid: live ? f!.quote!.bid : 3.95,
    // one set: the live index only beside the live month, else the day the example was written
    index: live && m && m.price > 0 ? m.price : 3.99,
  };
}

