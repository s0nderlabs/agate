"use client";
// The prices beside ours, per GPU: Ornn's dated reading, and Akash's hourly chain read when the data is live (the
// shared-akash robot's file through /api/akash; a server without it answers 404 and the dated reading stays).
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { peersFor, type AkashTraded } from "@/lib/peers";
import type { Gpu } from "@/lib/mock/types";
import { useSource } from "./context";

async function readAkash(): Promise<AkashTraded | null> {
  const r = await fetch("/api/akash");
  if (!r.ok) return null;
  return (await r.json()) as AkashTraded;
}

export function usePeers(gpu: Gpu) {
  const source = useSource();
  const live = source.kind === "live";
  // the robot reads the chain hourly: read it now and then, never more than the panel needs
  const q = useQuery({ queryKey: ["akash"], queryFn: readAkash, enabled: live, staleTime: 10 * 60_000, refetchInterval: 30 * 60_000, retry: false });
  return useMemo(() => peersFor(gpu, live ? q.data : null), [gpu, live, q.data]);
}
