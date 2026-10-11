"use client";
// The prices beside ours, per GPU, read when the data is live: Ornn's daily index through /api/ornn, and Akash's
// hourly chain read (the shared-akash robot's file through /api/akash). A server without a reading answers 404: a
// reading already shown stays, and with none that peer's dated reading shows.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { peersFor, type AkashTraded, type OrnnIndex } from "@/lib/peers";
import type { Gpu } from "@/lib/mock/types";
import { useSource } from "./context";

/** A route's answer; one without a reading (404) throws, so a reading already shown stays until the next good one. */
async function readJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return (await r.json()) as T;
}

export function usePeers(gpu: Gpu) {
  const source = useSource();
  const live = source.kind === "live";
  // the robot reads the chain hourly: read it now and then, never more than the panel needs
  const q = useQuery({ queryKey: ["akash"], queryFn: () => readJson<AkashTraded>("/api/akash"), enabled: live, staleTime: 10 * 60_000, refetchInterval: 30 * 60_000, retry: false });
  // Ornn posts once a day; the route keeps a reading an hour
  const o = useQuery({ queryKey: ["ornn"], queryFn: () => readJson<OrnnIndex>("/api/ornn"), enabled: live, staleTime: 30 * 60_000, refetchInterval: 60 * 60_000, retry: false });
  return useMemo(() => peersFor(gpu, live ? q.data : null, live ? o.data : null), [gpu, live, q.data, o.data]);
}
