// BOTS-SPEC 2.4: the LIMIT table (MS 9.2, contracts/README.md: Foundry, Ethereum Cancun prices, execution gas) and
// the provisional ceilings of the shapes not measured yet. AGATE_MARKET_GAS_LIMITS overrides it whole or per shape:
// JSON {shape: {c: limit}} or {shape: limit}; phase 4 sets it from the Monad re-measurement (MS 10.4 step 7).
import type { Shape } from "./types.ts";

export class LimitsError extends Error {}

type Points = [c: number, limit: number][];

/** Measured rows, c ascending. */
const SYNC: Points = [[0, 3_590], [1, 135_249], [5, 187_235], [30, 496_353], [31, 508_719]];
const SETTLE: Points = [[0, 42_348], [1, 135_479], [5, 187_401], [30, 496_245]];
/** claimMany with 8 ids. */
const CLAIM8: Points = [[0, 222_670], [1, 237_948], [5, 287_382], [30, 596_269]];
/** the one-id floor: claimMany 1 id at c 1 is 135,369 (measured); at other c, a single claim's row plus the same 285
 *  (claim c 1 is 135,084), interpolated like sync. Near one id the per-id slope undercounts the fixed cost. */
const CLAIM1: Points = [[0, 52_372 + 285], [1, 135_369], [5, 187_030 + 285], [30, 495_898 + 285]];
const PER_ID = 25_450;
/** Not in the README's table (measured with payees that already hold the dollar): a payee new to the dollar makes
 *  its balance write zero-to-nonzero, 17,100 more gas at Ethereum prices (20,000 instead of 2,900). Measured on a
 *  local anvil (Oct 3): claimMany of 50 ids to 50 fresh payees at c 0 estimated 1,940,342, above the table's
 *  1,291,570 by 1.5x, so 1.2 x estimate passed CAP and every batch was refused GAS_CAP. The LIMIT counts every
 *  payee as new (the worst case); phase 4's Monad re-measurement should measure claimMany with fresh payees. */
export const FRESH_PAYEE_GAS = 17_100;

const FIXED: Partial<Record<Shape, number>> = {
  // MS 9.2 measures 90,406 for a holder new to both balances on a series that already has a supply. A series' FIRST
  // mint (the maker's, on every new month) also takes the token supply, the short supply and the series' dollar
  // balance from zero: about 141,550 execution gas on the Kuru V1 fork (P1, Oct 3, n = 1; receipt 163,174 with the
  // 21,000 and the calldata), which 90,406 refused GAS_CAP. "The larger row" (BOTS-SPEC 2.4 v2) is that one.
  "series.mint": 142_000,
  "series.redeem": 52_975,
  "factory.list": 3_609_379, // RULE (the larger row)
  "factory.createMarket": 1_247_597, // Kuru V1's real deployProxy, fork
};

/** Unmeasured shapes: a ceiling that replaces LIMIT + 21,000 + calldataGas in the sender's CAP. */
export function provisionalCeiling(shape: Shape, adds = 0, cancels = 0): number | null {
  switch (shape) {
    case "erc20.approve":
      return 120_000;
    case "kuru.deposit":
    case "kuru.withdraw":
      return 300_000;
    case "kuru.batchUpdate":
      return 400_000 + 350_000 * adds + 120_000 * cancels;
    default:
      return null;
  }
}

/** Linear between measured c; below the first point the first value; above the last, the slope of the last two
 *  rows given (for sync, settle and claimMany: 5 to 30, since sync's 31 row is used only exactly at 31). */
function interp(points: Points, c: number, slopeFrom: [number, number] = [5, 30]): number {
  if (points.length === 1 || c <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [c1, l1] = points[i]!;
    const [c0, l0] = points[i - 1]!;
    if (c === c1) return l1;
    if (c < c1) return Math.ceil(l0 + ((l1 - l0) * (c - c0)) / (c1 - c0));
  }
  const a = points.find((p) => p[0] === slopeFrom[0]) ?? points[points.length - 2]!;
  const b = points.find((p) => p[0] === slopeFrom[1]) ?? points[points.length - 1]!;
  const slope = (b[1] - a[1]) / (b[0] - a[0]);
  const last = points[points.length - 1]!;
  return Math.ceil(last[1] + slope * (c - last[0]));
}

export type Override = Record<string, number | Record<string, number>>;

export class LimitTable {
  private readonly override: Override;
  constructor(override: Override = {}) {
    // an empty {c: limit} entry counts as no override (fromEnv refuses one; a direct caller gets the table's row)
    this.override = Object.fromEntries(Object.entries(override).filter(([, v]) => typeof v === "number" || Object.keys(v).length > 0));
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): LimitTable {
    const raw = env.AGATE_MARKET_GAS_LIMITS;
    if (!raw) return new LimitTable();
    let j: unknown;
    try {
      j = JSON.parse(raw);
    } catch {
      throw new LimitsError("AGATE_MARKET_GAS_LIMITS is not JSON");
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new LimitsError("AGATE_MARKET_GAS_LIMITS is not an object");
    const ok = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (!SHAPES.includes(k as Shape)) throw new LimitsError(`AGATE_MARKET_GAS_LIMITS: unknown shape ${k}`);
      if (ok(v)) continue;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new LimitsError(`AGATE_MARKET_GAS_LIMITS.${k} is not a limit or {c: limit}`);
      // an empty {c: limit} would have no point to interpolate (every plan of the shape would throw): refused at start
      if (Object.keys(v).length === 0) throw new LimitsError(`AGATE_MARKET_GAS_LIMITS.${k} is empty`);
      for (const [c, l] of Object.entries(v as Record<string, unknown>)) {
        if (!/^\d+$/.test(c) || !ok(l)) throw new LimitsError(`AGATE_MARKET_GAS_LIMITS.${k} has a bad entry`);
      }
    }
    return new LimitTable(j as Override);
  }

  private points(shape: Shape, base: Points): Points {
    const o = this.override[shape];
    if (o === undefined) return base;
    if (typeof o === "number") return [[0, o]];
    const pts = Object.entries(o).map(([c, l]) => [Number(c), l] as [number, number]).sort((a, b) => a[0] - b[0]);
    return pts.length ? pts : base;
  }

  /** Whether the shape has a measured (or overridden) LIMIT; else the sender uses provisionalCeiling. */
  measured(shape: Shape): boolean {
    return this.override[shape] !== undefined || provisionalCeiling(shape) === null;
  }

  /** limitFor(shape, c = 0, n = 1) of BOTS-SPEC 2.4: execution gas. Throws for an unmeasured shape without override. */
  limitFor(shape: Shape, c = 0, n = 1): number {
    if (c < 0 || !Number.isInteger(c)) throw new LimitsError(`c ${c} is not a count`);
    switch (shape) {
      case "series.sync":
        return interp(this.points(shape, SYNC), c);
      case "series.settle":
        return interp(this.points(shape, SETTLE), c);
      case "series.claimMany": {
        if (n < 1 || !Number.isInteger(n)) throw new LimitsError(`n ${n} is not a count of ids`);
        const at8 = interp(this.points(shape, CLAIM8), c);
        const scaled = at8 + (n - 8) * PER_ID;
        // an overridden table is taken as measured on Monad: the one-id floor scales with it
        const one = this.override[shape] === undefined ? interp(CLAIM1, c) : Math.ceil((interp(CLAIM1, c) * at8) / interp(CLAIM8, c));
        return Math.max(scaled, one) + n * FRESH_PAYEE_GAS;
      }
      default: {
        const o = this.override[shape];
        if (typeof o === "number") return o;
        if (o && typeof o === "object") return interp(this.points(shape, []), c);
        const v = FIXED[shape];
        if (v === undefined) throw new LimitsError(`${shape} has no measured LIMIT`);
        return v;
      }
    }
  }
}

export const SHAPES: readonly Shape[] = [
  "series.mint",
  "series.redeem",
  "series.sync",
  "series.claimMany",
  "series.settle",
  "factory.list",
  "factory.createMarket",
  "erc20.approve",
  "kuru.deposit",
  "kuru.withdraw",
  "kuru.batchUpdate",
];

/** Calldata gas as Ethereum prices it: 16 per nonzero byte, 4 per zero byte. */
export function calldataGas(data: `0x${string}`): number {
  let g = 0;
  for (let i = 2; i < data.length; i += 2) g += data.slice(i, i + 2) === "00" ? 4 : 16;
  return g;
}

/** BOTS-SPEC 2.3 step 3: CAP = 1.5 (LIMIT + 21,000 + calldataGas), or 1.5 x the provisional ceiling of an unmeasured
 *  shape, rounded up. */
export function capFor(table: LimitTable, shape: Shape, data: `0x${string}`, o: { c?: number; n?: number; adds?: number; cancels?: number } = {}): bigint {
  if (!table.measured(shape)) {
    const ceil = provisionalCeiling(shape, o.adds ?? 0, o.cancels ?? 0)!;
    return BigInt(Math.ceil(ceil * 1.5));
  }
  const base = table.limitFor(shape, o.c ?? 0, o.n ?? 1) + 21_000 + calldataGas(data);
  return (BigInt(base) * 3n + 1n) / 2n;
}
