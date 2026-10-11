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
 * the index with credit and a link: the values of its free daily index (api.ornnai.com/api/daily-index/all), read by
 * /api/ornn when the data is live; the values below are the last read by hand (Oct 11 2026, for the day of Oct 10),
 * shown when that read fails. Akash: the
 * Oct 1 chain read found H200 listed (2 providers, 40 GPUs at $4.45) but none rented, and no B200: no traded price.
 * The price-only GPUs (B300, A100, L40S) have no peers yet. */
export interface PeerPrice {
  name: string;
  kind: "traded-private" | "traded-onchain";
  price: number | null;
  note: string;
  asOf: string;
}

const dayOf = (s: number) => new Date(s * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Ornn's daily index as last read by hand: when its day closed (unix seconds), and its value per GPU. A live reading
 *  older than this never replaces it. */
const ORNN_HAND_AT = Date.parse("2026-10-10T20:00:00.000Z") / 1000;
const ornn = (price: number, at = ORNN_HAND_AT): PeerPrice => ({ name: "Ornn", kind: "traded-private", price, note: "Traded prices, private data. Shown with credit, display only.", asOf: dayOf(at) });
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

/** Ornn's daily index as /api/ornn answers it: per GPU, its value and when that value's day closed (unix seconds). */
export interface OrnnIndex {
  gpus: Partial<Record<Gpu, { price: number; at: number }>>;
}

/** Ornn's names for the three GPUs it agreed to have shown; its other rows (A100, RTX 5090) are left out. */
const ORNN_NAMES = new Map<string, Gpu>([
  ["H100 SXM", "H100"],
  ["H200", "H200"],
  ["B200", "B200"],
]);

const ornnTime = (d: unknown) => (typeof d === "string" ? Date.parse(d) : NaN);

/** Ornn's free daily index ({ success, date, data: [{ gpu_type, region, index_value, date }] }) as an OrnnIndex, or
 *  null when it is not that shape or carries none of the three. Only global rows count; each value keeps its own
 *  row's day (the top date when a row has none), the newest row per GPU wins, and a value outside $0 to $100 an hour
 *  is left out as a misread. */
export function ornnIndexOf(raw: unknown): OrnnIndex | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { success?: unknown; date?: unknown; data?: unknown };
  if (r.success !== true || !Array.isArray(r.data)) return null;
  const top = ornnTime(r.date);
  const gpus: OrnnIndex["gpus"] = {};
  for (const row of r.data as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const { gpu_type, region, index_value, date } = row as { gpu_type?: unknown; region?: unknown; index_value?: unknown; date?: unknown };
    const gpu = typeof gpu_type === "string" ? ORNN_NAMES.get(gpu_type) : undefined;
    if (!gpu || region !== "global") continue;
    if (typeof index_value !== "number" || !Number.isFinite(index_value) || index_value <= 0 || index_value >= 100) continue;
    const ms = Number.isFinite(ornnTime(date)) ? ornnTime(date) : top;
    if (!Number.isFinite(ms)) continue;
    const at = Math.floor(ms / 1000);
    if (!gpus[gpu] || at > gpus[gpu].at) gpus[gpu] = { price: index_value, at };
  }
  return Object.keys(gpus).length ? { gpus } : null;
}

/** Two readings of Ornn's index (say agate-1's copy and Ornn's own API) as one: per GPU, the newer day. */
export function newerOrnn(a: OrnnIndex | null, b: OrnnIndex | null): OrnnIndex | null {
  if (!a || !b) return a ?? b;
  const gpus: OrnnIndex["gpus"] = { ...a.gpus };
  for (const [g, v] of Object.entries(b.gpus) as [Gpu, { price: number; at: number }][]) if (!gpus[g] || v.at > gpus[g].at) gpus[g] = v;
  return { gpus };
}

/** The prices beside ours. With live data, Ornn's number is its latest daily index (/api/ornn) and Akash's is the
 *  robot's chain read, its seller and buyer counts always beside it (a thin market); without them, the dated readings
 *  above, each GPU on its own. */
export function peersFor(gpu: Gpu, akash?: AkashTraded | null, ornnRead?: OrnnIndex | null): PeerPrice[] {
  const o = ornnRead?.gpus[gpu];
  const ornnNow = o && o.at >= ORNN_HAND_AT ? ornn(o.price, o.at) : ORNN[gpu];
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
  return [ornnNow, fresh ?? AKASH[gpu]].filter((p): p is PeerPrice => !!p);
}
