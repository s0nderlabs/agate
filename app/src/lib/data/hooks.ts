"use client";
// The screens' reads. Every component asks for what it needs; TanStack Query merges identical reads (same source,
// same key) into one request, so the strip, the header, both tickets, the account box and the Index page share one
// markets read. Queries never run on the server: the example source hands its data over synchronously (initialData),
// live renders its loading state there.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Gpu, Market, Position, Series } from "@/lib/mock/types";
import { useSource } from "./context";
import { placeholderMarket } from "./derive";
import { EMPTY_BOOK, type DataSource } from "./source";

/** Two more tries, 5 s then 10 s apart: the client already retries a failed multicall and viem its requests, so more
 *  would hammer a rate-limited RPC. The example source answers at once (or deliberately not at all). */
const retry = (s: DataSource) => (s.kind === "live" ? 2 : 0);
const retryDelay = (attempt: number) => (attempt === 0 ? 5_000 : 10_000);
/** Polling at the cadence, doubled while reads fail (30 s, then 60 s), back to normal on success. */
const every = (ms: number) => (q: { state: { status: string } }) => (q.state.status === "error" ? ms * 2 : ms);
/** No fresh markets for this long reads as stale (counted in time the page was visible, see visibleAge). */
export const STALE_AFTER = 120_000;

// The stretches this page spent hidden ([from, to] in ms, `to` 0 while it still is). Polling pauses in a hidden tab
// (provider.tsx), so that time never makes data stale: back in view, the focus read gets its chance first. Kept short;
// a dropped old stretch only makes very old data count as older, never as fresh.
const hiddenSpans: [number, number][] = [];
if (typeof document !== "undefined") {
  if (document.visibilityState === "hidden") hiddenSpans.push([Date.now(), 0]);
  document.addEventListener("visibilitychange", () => {
    const now = Date.now();
    const last = hiddenSpans[hiddenSpans.length - 1];
    if (document.visibilityState === "hidden") {
      if (!last || last[1]) hiddenSpans.push([now, 0]);
      if (hiddenSpans.length > 50) hiddenSpans.shift();
    } else if (last && !last[1]) last[1] = now;
  });
}

/** How long the page has been in view since `t` (ms): the time since, less the stretches it spent hidden. */
function visibleAge(t: number, now = Date.now()) {
  let age = now - t;
  for (const [from, to] of hiddenSpans) {
    const end = to || now;
    const start = Math.max(from, t);
    if (end > start) age -= end - start;
  }
  return age;
}

/** Data read at `updatedAt` (ms) is old: no fresh read for two minutes of the page being in view. */
export function isOld(updatedAt: number) {
  return updatedAt > 0 && visibleAge(updatedAt) > STALE_AFTER;
}

function marketsQuery(source: DataSource) {
  return {
    queryKey: [source.key, "markets"],
    queryFn: () => source.markets(),
    refetchInterval: every(30_000),
    staleTime: 15_000,
    retry: retry(source),
    retryDelay,
    initialData: source.initial?.markets,
    initialDataUpdatedAt: source.initial?.marketsAt,
  };
}

function statusOf(q: { isPending: boolean; isError: boolean; data: unknown; dataUpdatedAt: number }) {
  const has = q.data !== undefined;
  return {
    /** nothing to show yet (the first read is on its way) */
    loading: q.isPending,
    /** the last read failed (after its retries) */
    error: q.isError,
    /** showing data that is no longer fresh: the last read failed, or nothing new for two minutes in view */
    stale: has && (q.isError || isOld(q.dataUpdatedAt)),
    /** when the data shown was read (ms), 0 before the first read */
    updatedAt: has ? q.dataUpdatedAt : 0,
  };
}

/** The six GPUs in one read, every 30 s (about 16 RPC requests plus a GraphQL query live). */
export function useMarkets() {
  const source = useSource();
  const q = useQuery(marketsQuery(source));
  return { markets: q.data, ...statusOf(q) };
}

/** One GPU from the same read (a GPU switch is instant: no new request). */
export function useMarket(gpu: Gpu) {
  const source = useSource();
  const q = useQuery({ ...marketsQuery(source), select: (ms: Market[]) => ms.find((m) => m.gpu === gpu) });
  return { market: q.data, ...statusOf(q) };
}

/** One GPU for a screen: the market, or a neutral stand-in while nothing has loaded (or the read failed), so the
 *  layout never breaks and never shows an invented number. `loading` says which. */
export function useScreenMarket(gpu: Gpu) {
  const m = useMarket(gpu);
  const stand = useMemo(() => placeholderMarket(gpu), [gpu]);
  return { ...m, market: m.market ?? stand, missing: !m.market };
}

/** Listed months only (an upcoming month or a price-only GPU has no book, fills or candles). */
function listedKey(series: Series | null | undefined) {
  const on = !!series && series.phase !== "upcoming";
  return { on, gpu: (series?.gpu ?? "H100") as Gpu, month: series?.month ?? "" };
}

/** A month's book, every 15 s; the empty book while it is not listed or not read yet. `loading` is true until a book
 *  has been read, also when the first read failed (`error` says so): a book that could not be read is never shown
 *  as an empty one. */
export function useBook(series: Series | null | undefined) {
  const source = useSource();
  const { on, gpu, month } = listedKey(series);
  const q = useQuery({
    queryKey: [source.key, "book", gpu, month],
    queryFn: () => source.book(gpu, month),
    enabled: on,
    refetchInterval: every(15_000),
    staleTime: 7_500,
    retry: retry(source),
    retryDelay,
    initialData: on && source.initial ? () => source.initial!.book(gpu, month) : undefined,
  });
  return { book: (on && q.data) || EMPTY_BOOK, loading: on && q.data === undefined, error: on && q.isError };
}

/** A month's recent fills, newest first, every 15 s (Pro only: pass enabled false elsewhere). Like the book, `loading`
 *  stays true until fills have been read, also when the first read failed (`error` says so): trades that could not
 *  be read are never shown as "no trades". */
export function useFills(series: Series | null | undefined, { enabled = true, limit = 30 }: { enabled?: boolean; limit?: number } = {}) {
  const source = useSource();
  const { on: listed, gpu, month } = listedKey(series);
  const on = listed && enabled;
  const q = useQuery({
    queryKey: [source.key, "fills", gpu, month, limit],
    queryFn: () => source.fills(gpu, month, limit),
    enabled: on,
    refetchInterval: every(15_000),
    staleTime: 7_500,
    retry: retry(source),
    retryDelay,
    initialData: on && source.initial ? () => source.initial!.fills(gpu, month, limit) : undefined,
  });
  return { fills: (on && q.data) || [], loading: on && q.data === undefined, error: on && q.isError };
}

/** A month's hourly candles, every 30 s; shared by the chart, the header's day change and the stats. `loading` and
 *  `error` as for the book and the fills: until candles have been read, nothing counted from them is shown as zero. */
export function useCandles(series: Series | null | undefined) {
  const source = useSource();
  const { on, gpu, month } = listedKey(series);
  const q = useQuery({
    queryKey: [source.key, "candles", gpu, month],
    queryFn: () => source.candles(gpu, month),
    enabled: on,
    refetchInterval: every(30_000),
    staleTime: 15_000,
    retry: retry(source),
    retryDelay,
    initialData: on && source.initial ? () => source.initial!.candles(gpu, month) : undefined,
  });
  return { candles: (on && q.data) || [], loading: on && q.data === undefined, error: on && q.isError };
}

/** Whether the indexer answers, every 60 s (trade history, candles and listing times come from it). */
export function useIndexer() {
  const source = useSource();
  const q = useQuery({
    queryKey: [source.key, "indexer"],
    queryFn: () => source.indexerUp(),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 0,
    initialData: source.initial?.indexerUp,
  });
  // up until a check says otherwise (the screens never claim an outage they have not seen); `checked` tells the two apart
  return { indexerUp: q.data ?? true, loading: q.isPending, checked: q.data !== undefined };
}

/** One line of status for the Notice bar and the CTA: which source, loading, failing, stale, when last read. */
export function useDataStatus() {
  const source = useSource();
  const m = useMarkets();
  const { indexerUp } = useIndexer();
  // live: a clock of its own, so old prices turn stale on time even while a read hangs (a hung RPC call raises no
  // error and re-renders nothing for minutes)
  const [, tick] = useState(0);
  const live = source.kind === "live";
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(id);
  }, [live]);
  return { source: source.kind, loading: m.loading, error: m.error, stale: m.stale, updatedAt: m.updatedAt, indexerUp };
}

/** "Now" for counting (traded in the last 24 hours, days left): the example's own morning, or the clock. */
export function useNow() {
  return useSource().now();
}

/** Each position at its own market's last price (any GPU, any month), from the shared markets read; null while there
 *  is no price to read (nothing read yet, Monad unreachable, an empty book's last of 0), never the entry price passed
 *  off as one. */
export function useLastFor() {
  const { markets } = useMarkets();
  return (p: Position): number | null => markets?.find((m) => m.gpu === p.gpu)?.series.find((x) => x.month === p.month)?.quote?.last || null;
}

/** A month of any GPU from the shared markets read. */
export function useSeriesFor() {
  const { markets } = useMarkets();
  return (gpu: string, month: string) => markets?.find((m) => m.gpu === gpu)?.series.find((x) => x.month === month);
}
