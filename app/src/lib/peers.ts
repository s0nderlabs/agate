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
 * the index with credit and a link: the values of its free daily index (api.ornnai.com/api/daily-index/all), last
 * read Oct 11 2026 for the day of Oct 10. Akash: the
 * Oct 1 chain read found H200 listed (2 providers, 40 GPUs at $4.45) but none rented, and no B200: no traded price.
 * The price-only GPUs (B300, A100, L40S) have no peers yet. */
export interface PeerPrice {
  name: string;
  kind: "traded-private" | "traded-onchain";
  price: number | null;
  note: string;
  asOf: string;
}

/** Ornn's daily index: the day it is for (UTC), and its value per GPU. A re-read changes these four only. */
const ORNN_DAY = "Oct 10";
const ornn = (price: number): PeerPrice => ({ name: "Ornn", kind: "traded-private", price, note: "Traded prices, private data. Shown with credit, display only.", asOf: ORNN_DAY });
const ORNN: Partial<Record<Gpu, PeerPrice>> = { H100: ornn(2.67), H200: ornn(5.91), B200: ornn(7.53) };
const AKASH: Partial<Record<Gpu, PeerPrice>> = {
  H100: { name: "Akash", kind: "traded-onchain", price: 2.6, note: "Real rentals on Akash's own chain: 35 leases, 3 sellers. Display only.", asOf: "Oct 2" },
  H200: { name: "Akash", kind: "traded-onchain", price: null, note: "40 H200 listed at $4.45, none rented yet. Display only.", asOf: "Oct 1" },
  B200: { name: "Akash", kind: "traded-onchain", price: null, note: "No B200 offered on Akash yet.", asOf: "Oct 1" },
};

/** The shared-akash robot's latest read (GET /api/akash): per GPU, the GPU-weighted median of active leases. */
export interface AkashTraded {
  /** unix seconds of the last good read */
  generatedAt: number;
  gpus: Partial<Record<Gpu, { median: number | null; gpus: number; leases: number; sellers: number; buyers: number }>>;
}

const dayOf = (s: number) => new Date(s * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The prices beside ours. With the robot's read (live data), Akash's number is today's chain read, its seller and
 *  buyer counts always beside it (a thin market); without it, the dated reading above. */
export function peersFor(gpu: Gpu, akash?: AkashTraded | null): PeerPrice[] {
  const a = akash?.gpus[gpu];
  const fresh: PeerPrice | undefined = a
    ? {
        name: "Akash",
        kind: "traded-onchain",
        price: a.median,
        note:
          a.median === null
            ? `No ${gpu} rented on Akash's chain right now. Display only.`
            : `Real rentals on Akash's own chain: ${a.leases} ${a.leases === 1 ? "lease" : "leases"}, ${a.sellers} ${a.sellers === 1 ? "seller" : "sellers"}, ${a.buyers} ${a.buyers === 1 ? "buyer" : "buyers"}. Display only.`,
        asOf: dayOf(akash!.generatedAt),
      }
    : undefined;
  return [ORNN[gpu], fresh ?? AKASH[gpu]].filter((p): p is PeerPrice => !!p);
}
