// Traded prices shown beside the index, display only. They are the app's own (the client has no peer prices), so
// they stay here for both data sources. Moved out of lib/mock on Oct 4 2026 when live data arrived.
import type { Gpu } from "@/lib/mock/types";

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Traded prices beside ours, per GPU (display only). Ornn agreed Oct 1 2026 to H100, H200 and B200 shown beside
 * the index with credit and a link. H200/B200 values are the last we read (licence check Sep 29). Akash: the
 * Oct 1 chain read found H200 listed (2 providers, 40 GPUs at $4.45) but none rented, and no B200: no traded price.
 * The price-only GPUs (B300, A100, L40S) have no peers yet. */
export interface PeerPrice {
  name: string;
  kind: "traded-private" | "traded-onchain";
  price: number | null;
  note: string;
  asOf: string;
}

const ORNN: Partial<Record<Gpu, PeerPrice>> = {
  H100: { name: "Ornn", kind: "traded-private", price: 2.92, note: "Traded prices, private data. Shown with credit, display only.", asOf: "Oct 2" },
  H200: { name: "Ornn", kind: "traded-private", price: 4.94, note: "Traded prices, private data. Shown with credit, display only.", asOf: "Sep 29" },
  B200: { name: "Ornn", kind: "traded-private", price: 8.14, note: "Traded prices, private data. Shown with credit, display only.", asOf: "Sep 29" },
};
const AKASH: Partial<Record<Gpu, PeerPrice>> = {
  H100: { name: "Akash", kind: "traded-onchain", price: 2.6, note: "Real rentals on Akash's own chain: 35 leases, 3 sellers. Display only.", asOf: "Oct 2" },
  H200: { name: "Akash", kind: "traded-onchain", price: null, note: "40 H200 listed at $4.45, none rented yet. Display only.", asOf: "Oct 1" },
  B200: { name: "Akash", kind: "traded-onchain", price: null, note: "No B200 offered on Akash yet.", asOf: "Oct 1" },
};

export function peersFor(gpu: Gpu): PeerPrice[] {
  return [ORNN[gpu], AKASH[gpu]].filter((p): p is PeerPrice => !!p);
}
