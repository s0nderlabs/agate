"use client";
// The data layer's provider: one TanStack QueryClient per page (it dedupes identical reads across components, polls,
// pauses in hidden tabs, keeps the last good data while a read fails) and the source the Mock controls pick. Sits
// inside MockProvider, which owns the source switch.
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useMock } from "@/lib/mock/store";
import { SourceCtx, useSource } from "./context";
import { useMarkets } from "./hooks";
import { exampleSource, liveSource } from "./source";

export { useSource } from "./context";

export function DataProvider({ children }: { children: React.ReactNode }) {
  const { config } = useMock();
  // made once per page; on the server once per request
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // hidden tabs stop polling (phones above all) and catch up on focus
            refetchIntervalInBackground: false,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
          },
        },
      }),
  );
  const source = config.source === "live" ? liveSource : exampleSource(config.data, config.when);
  return (
    <QueryClientProvider client={client}>
      <SourceCtx.Provider value={source}>
        {children}
        {source.kind === "live" && <Wake />}
      </SourceCtx.Provider>
    </QueryClientProvider>
  );
}

/** Reads markets again 20 s after the soonest expected change (the next final index price, an upcoming month's
 *  listing), so the first price and a new month show without waiting for the next poll, even in a hidden tab. The
 *  times are expectations and can slip, so normal polling carries on regardless. */
function Wake() {
  const { markets, updatedAt } = useMarkets();
  const source = useSource();
  const qc = useQueryClient();
  useEffect(() => {
    if (!markets) return;
    const now = Date.now();
    // a time within a minute of the read itself is already due: the client says "now" (chain time) for a price that
    // waits on its countersign or a month that can list, and a browser clock behind the chain would read that as
    // future and wake every 20 s. Normal polling covers what is due.
    const from = Math.max(now, updatedAt + 60_000);
    const times = markets
      .flatMap((m) => [m.nextUpdateAt, ...m.series.filter((s) => s.phase === "upcoming").map((s) => s.opensOn ?? "")])
      .map((t) => Date.parse(t))
      .filter((t) => Number.isFinite(t) && t > from);
    if (!times.length) return;
    const wait = Math.min(...times) - now + 20_000;
    // setTimeout holds at most about 24 days; anything later is picked up by a later read
    if (wait > 2 ** 31 - 1) return;
    const id = setTimeout(() => qc.invalidateQueries({ queryKey: [source.key, "markets"] }), wait);
    return () => clearTimeout(id);
  }, [markets, updatedAt, qc, source.key]);
  return null;
}
