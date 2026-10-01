// Random worlds for the L1 property test and the honest-failure fuzz (BUILD-SPEC 12.6 L1, L1b, 12.5 fuzz E): step
// pages, transient loss, watcher gaps, writer-side blocks, view splits, dark spells and one writer stolen with a
// random strategy. Deterministic per seed.
import type { ProfileInput } from "../clock.ts";
import { mulberry32, type Outage, type PageFn, type WorldOptions, type WriterSpec } from "./world.ts";

export type Strategy = "none" | "freeze" | "plant" | "withhold" | "late-close" | "garbage";
export const STRATEGIES: Strategy[] = ["none", "freeze", "plant", "withhold", "late-close", "garbage"];

export interface RandomWorld {
  seed: number;
  options: WorldOptions;
  strategy: Strategy;
  thief: number | null; // writer index
  truth: (d: number) => number[]; // page prices per slot at noon (for reports)
  notes: string[];
}

function hash01(...xs: number[]): number {
  let h = 2166136261;
  for (const x of xs) {
    h ^= x & 0xffff;
    h = Math.imul(h, 16777619);
    h ^= x >>> 16;
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

export interface RandomOptions {
  profile?: ProfileInput;
  days: number;
  firstDay: number;
  loss: number; // transient failure probability per read
  thief: boolean; // allow a stolen writer
  guardian: boolean;
  standby?: boolean;
  /** max watcher gap in intervals */
  maxGap?: number;
  /** force the stolen writer's strategy (and which writer) */
  strategy?: Strategy;
  thiefWriter?: number;
  /** the harness's attester: the real rule R, or I28's negative control */
  careless?: boolean;
}

export function randomWorld(seed: number, o: RandomOptions): RandomWorld {
  const rng = mulberry32(seed * 7919 + 13);
  const P = o.profile ?? { day: 2_400, slices: 12 };
  const DAY = P.day;
  const slice = DAY / P.slices;
  const n = 5;
  const d0 = o.firstDay;
  const ds = (d: number) => d * DAY;
  const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)]!;
  const cents = (v: number) => Math.round(v / 10_000) * 10_000;
  const notes: string[] = [];
  const base = Array.from({ length: n }, () => cents(2_500_000 + rng() * 2_000_000));
  const steps: { slot: number; at: number; v: number; nets?: string[] }[] = [];
  const cur = [...base];
  for (let d = d0 + 1; d < d0 + o.days; d++) {
    for (let i = 0; i < n; i++) {
      if (rng() < 0.12) {
        cur[i] = Math.max(500_000, cents(cur[i]! + (rng() < 0.5 ? -1 : 1) * (50_000 + rng() * 550_000)));
        steps.push({ slot: i, at: ds(d) + Math.floor(rng() * DAY), v: cur[i]! });
      }
    }
  }
  const outages: Outage[] = [];
  // dark spells for everyone (never on more than two slots at once so the quorum assumption holds)
  const nDark = Math.floor(rng() * 3);
  for (let j = 0; j < nDark; j++) {
    const slot = pick([0, 1, 2, 3, 4]);
    const from = ds(d0 + 2 + Math.floor(rng() * (o.days - 6))) + Math.floor(rng() * DAY);
    const len = Math.floor((0.2 + rng() * 7) * DAY);
    outages.push({ slot, from, to: from + len, state: rng() < 0.5 ? "DARK" : "NR" });
    notes.push(`dark slot ${slot} for ${(len / DAY).toFixed(1)} days`);
  }
  // writer-side blocks (one writer's network cannot read a page for a day)
  if (rng() < 0.5) {
    const slot = pick([0, 1, 2, 3, 4]);
    const d = d0 + 2 + Math.floor(rng() * (o.days - 4));
    outages.push({ slot, from: ds(d), to: ds(d + 1), state: "FAIL", nets: [pick(["w1", "w2"])] });
    notes.push(`writer block slot ${slot} day ${d - d0}`);
  }
  // a view split: one page shows one writer (and its region's looks) another price for a day
  const splits: { slot: number; from: number; to: number; factor: number; nets: string[] }[] = [];
  if (rng() < 0.3) {
    const slot = pick([0, 1, 2, 3, 4]);
    const d = d0 + 2 + Math.floor(rng() * (o.days - 4));
    const net = pick(["w1", "w2"]);
    splits.push({ slot, from: ds(d), to: ds(d + 1), factor: 1.05, nets: [net, "look"] });
    notes.push(`view split slot ${slot} day ${d - d0} for ${net}`);
  }
  steps.sort((a, b) => a.at - b.at);
  const price = (i: number, t: number, net: string) => {
    let v = base[i]!;
    for (const s of steps) {
      if (s.at > t) break;
      if (s.slot === i && (!s.nets || s.nets.includes(net))) v = s.v;
    }
    for (const x of splits) if (x.slot === i && x.from <= t && t < x.to && x.nets.includes(net)) v = cents(v * x.factor);
    return v;
  };
  const pages: PageFn = (i, t, net) => {
    for (const x of outages) if (x.slot === i && x.from <= t && t < x.to && (!x.nets || x.nets.includes(net))) return { s: x.state };
    if (o.loss > 0 && hash01(seed, i, Math.floor(t / 7), net.length) < o.loss) return { s: "FAIL" };
    return { s: "V", v: price(i, t, net) };
  };
  // watcher gaps
  const gaps: [number, number][] = [];
  const nGaps = Math.floor(rng() * 3);
  for (let j = 0; j < nGaps; j++) {
    const k = Math.floor((ds(d0 + 1) + rng() * (o.days - 3) * DAY) / slice);
    const len = 1 + Math.floor(rng() * (o.maxGap ?? 12));
    gaps.push([k, k + len]);
    notes.push(`watcher gap ${len} intervals`);
  }
  let strategy: Strategy = "none";
  let thief: number | null = null;
  const writers: WriterSpec[] = [{ net: "w1" }];
  if (o.standby !== false) writers.push({ net: "w2" });
  if (o.thief) {
    strategy = o.strategy ?? pick(STRATEGIES);
    if (strategy !== "none") {
      thief = o.thiefWriter ?? (writers.length > 1 ? Math.floor(rng() * 2) : 0);
      const from = d0 + 2 + Math.floor(rng() * 6);
      const slot = Math.floor(rng() * n);
      const plantV = cents(base[slot]! * (0.7 + rng() * 0.6));
      const frozen: number[] = [...base];
      const spec = writers[thief]!;
      notes.push(`thief writer ${thief} ${strategy} from day ${from - d0} slot ${slot}`);
      if (strategy === "freeze") spec.values = (d, _h, _t, v) => (d >= from ? v.map((x, i) => (x ? frozen[i]! : 0)) : v);
      if (strategy === "plant") spec.values = (d, _h, _t, v) => (d >= from ? v.map((x, i) => (i === slot ? plantV : x)) : v);
      if (strategy === "withhold") spec.values = (d, _h, _t, v) => (d >= from ? v.map((x, i) => (i === slot ? 0 : x)) : v);
      if (strategy === "garbage") spec.values = (d, h, _t, v) => (d >= from ? v.map((x, i) => cents((x || base[i]!) * (0.5 + hash01(seed, d, h, i)))) : v);
      if (strategy === "late-close") {
        spec.close = "earliest";
        spec.values = (d, _h, _t, v) => (d >= from ? v.map((x, i) => (i === slot ? 0 : x)) : v);
      }
    }
  }
  const truth = (d: number) => Array.from({ length: n }, (_, i) => price(i, ds(d) + DAY / 2, "watch"));
  return {
    seed,
    strategy,
    thief,
    truth,
    notes,
    options: {
      profile: P,
      firstDay: d0,
      pages,
      writers,
      watcherMissed: (k) => gaps.some(([a, b]) => k >= a && k < b),
      guardian: o.guardian ? { delay: Math.floor(slice), looks: true } : null,
      ...(o.careless ? { attester: { careless: true } } : {}),
      seed,
    },
  };
}
