// Akash traded price (BUILD-SPEC 16): pure computation, no Node, Bun or DOM APIs, integers only (BigInt).
// Display only, labelled "traded, Akash chain": never an agate index input, never a settlement value.

export type GpuName = "H100" | "H200" | "B200";
export const GPU_NAMES: readonly GpuName[] = ["H100", "H200", "B200"];
/** The model token of each GPU in Akash's attribute keys `vendor/nvidia/model/<token>[/...]`. */
export const MODEL_TOKEN: Readonly<Record<GpuName, string>> = { H100: "h100", H200: "h200", B200: "b200" };

export const LABEL = "traded, Akash chain";
export const NOTES =
  "Price per GPU-hour of active leases, GPU-weighted median; a lease's price covers its whole bundle (GPU, CPU, memory, storage). Display only, never an agate index input.";
export const PRICE_DENOM = "uact";
/** Leases whose price is in this denom are counted; the amount is uact (10^-6 ACT) per block. */
export const MS_PER_HOUR = 3_600_000n;
const E18 = 10n ** 18n;

export interface Coin {
  denom: string;
  amount: string;
}

/** One active lease as the market module lists it (only the fields used). */
export interface LeaseIn {
  owner: string; // the buyer (deployment owner)
  dseq: string;
  gseq: number;
  provider: string; // the seller
  price: Coin; // per block, for the whole group
}

/** One resource of a deployment group: GPU units per replica, the GPU attribute keys, and the replica count. */
export interface ResourceIn {
  gpuUnits: number;
  gpuKeys: readonly string[];
  count: number;
}
export interface GroupIn {
  resources: readonly ResourceIn[];
}
export type Groups = Readonly<Record<string, GroupIn>>;

export const groupKey = (owner: string, dseq: string | number, gseq: string | number): string => `${owner}/${dseq}/${gseq}`;

/** The model token a GPU attribute key names (`vendor/<v>/model/<m>[/...]`), lowercase, or null. */
export function modelOfKey(key: string): string | null {
  const s = key.toLowerCase().split("/");
  if (s.length < 4 || s[0] !== "vendor" || s[2] !== "model" || !s[3]) return null;
  return s[3];
}

/** "sxm" or "pcie" when the key states an interface, else null. */
export function interfaceOfKey(key: string): "sxm" | "pcie" | null {
  const s = key.toLowerCase().split("/");
  const i = s.indexOf("interface");
  if (i < 0 || i + 1 >= s.length) return null;
  return s[i + 1] === "sxm" ? "sxm" : s[i + 1] === "pcie" ? "pcie" : null;
}

export type LeaseClass =
  | { kind: "none" } // no GPU resource: not a GPU lease
  | { kind: "ambiguous"; models: ReadonlySet<string> } // a resource naming several models or none, or mixed models
  | { kind: "exact"; model: string; units: number; iface: "sxm" | "pcie" | "unstated" };

/** Rule 16.4: every GPU resource must name exactly one model, the same one; units = sum of gpu units * count. */
export function classifyGroup(g: GroupIn): LeaseClass {
  const gpuRes = g.resources.filter((r) => r.gpuUnits > 0);
  if (gpuRes.length === 0) return { kind: "none" };
  const all = new Set<string>();
  let ambiguous = false;
  let units = 0;
  const ifaces: ("sxm" | "pcie" | null)[] = [];
  for (const r of gpuRes) {
    const models = new Set<string>();
    for (const k of r.gpuKeys) {
      const m = modelOfKey(k);
      if (m) {
        models.add(m);
        ifaces.push(interfaceOfKey(k));
      }
    }
    for (const m of models) all.add(m);
    if (models.size !== 1) ambiguous = true;
    units += r.gpuUnits * Math.max(0, r.count);
  }
  if (ambiguous || all.size !== 1) return { kind: "ambiguous", models: all };
  const model = [...all][0]!;
  const iface = ifaces.length > 0 && ifaces.every((x) => x === "sxm") ? "sxm" : ifaces.length > 0 && ifaces.every((x) => x === "pcie") ? "pcie" : "unstated";
  return { kind: "exact", model, units, iface };
}

/** A decimal string with up to 18 decimals (the chain's DecCoin) as an integer scaled by 10^18. Throws on any other form. */
export function parseDec18(s: string): bigint {
  const m = /^(\d{1,30})(?:\.(\d{1,18}))?$/.exec(s);
  if (!m) throw new RangeError(`not a decimal with at most 18 places: ${JSON.stringify(String(s).slice(0, 40))}`);
  return BigInt(m[1]!) * E18 + BigInt((m[2] ?? "").padEnd(18, "0"));
}

/** u per GPU-hour = round_half_up(amount_uact_per_block * 3,600,000 / blockMs / units) (16.5). 1 uact is read as 1 u. */
export function perGpuHourU(amount: string, blockMs: number, units: number): bigint {
  if (!Number.isSafeInteger(blockMs) || blockMs <= 0) throw new RangeError(`bad block time ${blockMs}`);
  if (!Number.isSafeInteger(units) || units <= 0) throw new RangeError(`bad unit count ${units}`);
  const num = parseDec18(amount) * MS_PER_HOUR;
  const den = E18 * BigInt(blockMs) * BigInt(units);
  return (2n * num + den) / (2n * den);
}

/** Cent string of a u amount, half up: 2,604,011 -> "2.60". */
export function centString(u: bigint): string {
  const cents = (u + 5_000n) / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export interface Weighted {
  u: bigint;
  units: number;
}

/** The value at 0-based position i of the multiset where each entry appears `units` times (entries sorted). */
function at(sorted: readonly Weighted[], i: number): bigint {
  let seen = 0;
  for (const e of sorted) {
    seen += e.units;
    if (i < seen) return e.u;
  }
  throw new RangeError("position past the multiset");
}

export interface WeightedStats {
  n: number;
  medianU: bigint;
  p25U: bigint;
  p75U: bigint;
  minU: bigint;
  maxU: bigint;
}

/** GPU-weighted median as in 4.6 (odd: the middle; even: the mean of the two middle, half up to a whole u), and the
 *  nearest-rank 25th and 75th percentiles (rank = ceil(p * n / 100)). Null for an empty set. */
export function weightedStats(entries: readonly Weighted[]): WeightedStats | null {
  const xs = entries.filter((e) => e.units > 0).slice().sort((a, b) => (a.u < b.u ? -1 : a.u > b.u ? 1 : 0));
  const n = xs.reduce((s, e) => s + e.units, 0);
  if (n === 0) return null;
  const medianU = n % 2 === 1 ? at(xs, (n - 1) / 2) : (at(xs, n / 2 - 1) + at(xs, n / 2) + 1n) / 2n;
  const rank = (p: number) => Math.max(1, Math.ceil((p * n) / 100));
  return { n, medianU, p25U: at(xs, rank(25) - 1), p75U: at(xs, rank(75) - 1), minU: xs[0]!.u, maxU: xs[xs.length - 1]!.u };
}

export interface GpuTraded {
  median: string | null;
  medianU: number | null;
  p25U: number | null;
  p75U: number | null;
  minU: number | null;
  maxU: number | null;
  gpus: number;
  leases: number;
  sellers: number;
  buyers: number;
  topBuyerGpuShareBps: number;
  topSellerGpuShareBps: number;
  interfaces: { sxm: number; pcie: number; unstated: number };
  excluded: { ambiguousModel: number; otherDenom: number };
}

export interface Traded {
  gpus: Partial<Record<GpuName, GpuTraded>>;
  /** every active lease read, GPU or not */
  leasesSeen: number;
  /** leases whose deployment group could not be read (left out, never guessed) */
  missingGroups: number;
}

const bps = (part: number, whole: number) => (whole > 0 ? Math.floor((part * 10_000) / whole) : 0);
const topShare = (m: Map<string, number>, total: number) => bps(Math.max(0, ...m.values()), total);

/** Rules 16.4 to 16.6 over the active leases and their groups. H100 is always present; H200 and B200 when any
 *  exactly-modelled lease exists. */
export function computeTraded(leases: readonly LeaseIn[], groups: Groups, blockMs: number): Traded {
  const acc = new Map<GpuName, { w: Weighted[]; leases: number; gpus: number; sellers: Map<string, number>; buyers: Map<string, number>; ifc: GpuTraded["interfaces"]; amb: number; other: number }>();
  const slot = (g: GpuName) => {
    let a = acc.get(g);
    if (!a) acc.set(g, (a = { w: [], leases: 0, gpus: 0, sellers: new Map(), buyers: new Map(), ifc: { sxm: 0, pcie: 0, unstated: 0 }, amb: 0, other: 0 }));
    return a;
  };
  slot("H100");
  let missing = 0;
  for (const l of leases) {
    const grp = groups[groupKey(l.owner, l.dseq, l.gseq)];
    if (!grp) {
      missing++;
      continue;
    }
    const c = classifyGroup(grp);
    if (c.kind === "none") continue;
    if (c.kind === "ambiguous") {
      for (const g of GPU_NAMES) if (c.models.has(MODEL_TOKEN[g])) slot(g).amb++;
      continue;
    }
    const g = GPU_NAMES.find((x) => MODEL_TOKEN[x] === c.model);
    if (!g || c.units <= 0) continue;
    const a = slot(g);
    if (l.price.denom !== PRICE_DENOM) {
      a.other++;
      continue;
    }
    let u: bigint;
    try {
      u = perGpuHourU(l.price.amount, blockMs, c.units);
    } catch {
      a.other++;
      continue;
    }
    a.w.push({ u, units: c.units });
    a.leases++;
    a.gpus += c.units;
    a.sellers.set(l.provider, (a.sellers.get(l.provider) ?? 0) + c.units);
    a.buyers.set(l.owner, (a.buyers.get(l.owner) ?? 0) + c.units);
    a.ifc[c.iface] += c.units;
  }
  const out: Traded["gpus"] = {};
  for (const g of GPU_NAMES) {
    const a = acc.get(g);
    if (!a) continue;
    if (g !== "H100" && a.leases === 0) continue;
    const s = weightedStats(a.w);
    out[g] = {
      median: s ? centString(s.medianU) : null,
      medianU: s ? Number(s.medianU) : null,
      p25U: s ? Number(s.p25U) : null,
      p75U: s ? Number(s.p75U) : null,
      minU: s ? Number(s.minU) : null,
      maxU: s ? Number(s.maxU) : null,
      gpus: a.gpus,
      leases: a.leases,
      sellers: a.sellers.size,
      buyers: a.buyers.size,
      topBuyerGpuShareBps: topShare(a.buyers, a.gpus),
      topSellerGpuShareBps: topShare(a.sellers, a.gpus),
      interfaces: a.ifc,
      excluded: { ambiguousModel: a.amb, otherDenom: a.other },
    };
  }
  return { gpus: out, leasesSeen: leases.length, missingGroups: missing };
}

/** Block time in whole milliseconds from two header times (RFC 3339 with up to 9 fractional digits), half up. */
export function blockMsBetween(tOld: string, tNew: string, blocks: number): number {
  const ns = (t: string): bigint => {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(t);
    if (!m) throw new RangeError(`bad block time ${JSON.stringify(t)}`);
    const s = Date.parse(`${m[1]}Z`);
    if (!Number.isFinite(s)) throw new RangeError(`bad block time ${JSON.stringify(t)}`);
    return BigInt(s) * 1_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"));
  };
  if (!Number.isSafeInteger(blocks) || blocks <= 0) throw new RangeError(`bad block count ${blocks}`);
  const d = ns(tNew) - ns(tOld);
  if (d <= 0n) throw new RangeError("block times do not increase");
  const den = BigInt(blocks) * 1_000_000n;
  return Number((2n * d + den) / (2n * den));
}

/** The output file of 16 (version 1). */
export interface AkashTradedFile {
  kind: "agate.akash-traded";
  version: 1;
  label: typeof LABEL;
  displayOnly: true;
  generatedAt: number;
  chain: { id: string; height: number; time: string };
  endpoint: string;
  blockMs: number;
  blockMsOverBlocks: number;
  unit: { denom: string; act: "ACT"; uactPerAct: number; usdPerAct: string };
  gpus: Traded["gpus"];
  leasesSeen: number;
  missingGroups: number;
  notes: string;
  error: string | null;
}

export const UNIT = { denom: PRICE_DENOM, act: "ACT", uactPerAct: 1_000_000, usdPerAct: "1 (Akash's peg, not verified by agate)" } as const;

export function buildFile(x: { generatedAt: number; chain: AkashTradedFile["chain"]; endpoint: string; blockMs: number; blocks: number; traded: Traded }): AkashTradedFile {
  return {
    kind: "agate.akash-traded",
    version: 1,
    label: LABEL,
    displayOnly: true,
    generatedAt: x.generatedAt,
    chain: x.chain,
    endpoint: x.endpoint,
    blockMs: x.blockMs,
    blockMsOverBlocks: x.blocks,
    unit: { ...UNIT },
    gpus: x.traded.gpus,
    leasesSeen: x.traded.leasesSeen,
    missingGroups: x.traded.missingGroups,
    notes: NOTES,
    error: null,
  };
}
