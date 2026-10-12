// BOTS-SPEC 3.11: the maker's config (AGATE_MM_CONFIG, JSON; every field optional). An unknown field is refused, so a
// typo never silently falls back to a default. perFactory.<name> overrides the ladder and requote fields for one factory.
import { readFileSync } from "node:fs";
import { type Address, parseEther } from "viem";
import { KURU_MAX_SIZE, KURU_V2_ACCOUNT_CORE } from "@agate/market";
import { UNITS_PER_TOKEN } from "./ladder.ts";
import type { V2Cfg } from "./v2.ts";

export interface BookConfig {
  spreadBps: number;
  levels: number;
  levelStepTicks: number;
  sizesTokens: number[];
  requoteMoveU: bigint;
  replenishBelowPct: number;
  staleS: number;
  minRequoteS: number;
  maxNetTokens: number;
  maxPairsTokens: number;
  stopBeforeEndS: number | null;
}

export interface MmConfig extends BookConfig {
  factories: string[];
  maxLossU: bigint;
  dollarLowU: bigint;
  dollarBufferU: bigint;
  tickS: number | null;
  keepMon: number;
  lowBalanceMon: number;
  keepWei: bigint;
  lowBalanceWei: bigint;
  runUntil: number; // unix s
  /** the budget's pacing head start (s): what the first seconds of a UTC day may already spend */
  headStartS: number;
  perFactory: Record<string, Partial<BookConfig>>;
  /** Kuru Spot V2 books to quote beside the V1 ones (v2.ts); null: none */
  kuruV2: V2Cfg | null;
}

/** kuruV2's own defaults: a small pilot ladder (two levels of 10 and 20 GPU-hours), at most 100 tokens held. */
export const V2_DEFAULTS = { levels: 2, sizesTokens: [10, 20], maxBaseTokens: 100 };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const DEFAULTS = {
  factories: ["demo", "real"],
  spreadBps: 100,
  levels: 3,
  levelStepTicks: 1,
  sizesTokens: [1000, 2000, 4000],
  requoteMoveU: 10_000,
  replenishBelowPct: 50,
  staleS: 21_600,
  minRequoteS: 10,
  maxNetTokens: 14_000,
  maxPairsTokens: 30_000,
  maxLossU: 500_000_000_000,
  dollarLowU: 500_000_000_000,
  dollarBufferU: 100_000_000_000,
  stopBeforeEndS: null as number | null,
  tickS: null as number | null,
  keepMon: 20,
  lowBalanceMon: 40,
  // through judging and the November series' settle (the real calendar's November settles Dec 1)
  runUntil: "2026-12-02T00:00:00Z",
  // 4 hours of the day's budget at 00:00: the new index value moves through the asks then, and requoting every book at
  // once costs more than one hour's share (measured Oct 6-12 2026 with 1 h: H200/B200 asks down 36 to 120 min daily)
  headStartS: 14_400,
  perFactory: {} as Record<string, Record<string, unknown>>,
  kuruV2: null as Record<string, unknown> | null,
};

const BOOK_FIELDS = ["spreadBps", "levels", "levelStepTicks", "sizesTokens", "requoteMoveU", "replenishBelowPct", "staleS", "minRequoteS", "maxNetTokens", "maxPairsTokens", "stopBeforeEndS"] as const;
const TOP_FIELDS = new Set<string>([...Object.keys(DEFAULTS)]);

export class ConfigError extends Error {}

function num(v: unknown, field: string, o: { min?: number; max?: number; int?: boolean } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ConfigError(`config: ${field} is not a number`);
  if (o.int !== false && !Number.isSafeInteger(v)) throw new ConfigError(`config: ${field} is not an integer`);
  if (o.min !== undefined && v < o.min) throw new ConfigError(`config: ${field} is under ${o.min}`);
  if (o.max !== undefined && v > o.max) throw new ConfigError(`config: ${field} is over ${o.max}`);
  return v;
}

function bookFields(j: Record<string, unknown>, base: BookConfig, where: string): BookConfig {
  const b: BookConfig = { ...base, sizesTokens: [...base.sizesTokens] };
  if (j.spreadBps !== undefined) b.spreadBps = num(j.spreadBps, `${where}spreadBps`, { min: 0, max: 5_000 });
  if (j.levels !== undefined) b.levels = num(j.levels, `${where}levels`, { min: 1, max: 20 });
  if (j.levelStepTicks !== undefined) b.levelStepTicks = num(j.levelStepTicks, `${where}levelStepTicks`, { min: 1, max: 10_000 });
  if (j.sizesTokens !== undefined) {
    if (!Array.isArray(j.sizesTokens) || j.sizesTokens.length === 0) throw new ConfigError(`config: ${where}sizesTokens is not a list`);
    const maxTokens = Number(KURU_MAX_SIZE / UNITS_PER_TOKEN);
    b.sizesTokens = j.sizesTokens.map((x, i) => num(x, `${where}sizesTokens[${i}]`, { min: 1, max: maxTokens }));
  }
  if (j.requoteMoveU !== undefined) b.requoteMoveU = BigInt(num(j.requoteMoveU, `${where}requoteMoveU`, { min: 0 }));
  if (j.replenishBelowPct !== undefined) b.replenishBelowPct = num(j.replenishBelowPct, `${where}replenishBelowPct`, { min: 0, max: 100 });
  if (j.staleS !== undefined) b.staleS = num(j.staleS, `${where}staleS`, { min: 1 });
  if (j.minRequoteS !== undefined) b.minRequoteS = num(j.minRequoteS, `${where}minRequoteS`, { min: 0 });
  if (j.maxNetTokens !== undefined) b.maxNetTokens = num(j.maxNetTokens, `${where}maxNetTokens`, { min: 0 });
  if (j.maxPairsTokens !== undefined) b.maxPairsTokens = num(j.maxPairsTokens, `${where}maxPairsTokens`, { min: 0 });
  if (j.stopBeforeEndS !== undefined) b.stopBeforeEndS = j.stopBeforeEndS === null ? null : num(j.stopBeforeEndS, `${where}stopBeforeEndS`, { min: 1 });
  if (b.sizesTokens.length < b.levels) throw new ConfigError(`config: ${where}sizesTokens has fewer entries than levels`);
  return b;
}

export function parseConfig(text: string | null): MmConfig {
  let j: Record<string, unknown> = {};
  if (text !== null && text.trim() !== "") {
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ConfigError("config: not JSON");
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new ConfigError("config: not an object");
  }
  for (const k of Object.keys(j)) if (!TOP_FIELDS.has(k)) throw new ConfigError(`config: unknown field ${k}`);
  const base: BookConfig = {
    spreadBps: DEFAULTS.spreadBps,
    levels: DEFAULTS.levels,
    levelStepTicks: DEFAULTS.levelStepTicks,
    sizesTokens: DEFAULTS.sizesTokens,
    requoteMoveU: BigInt(DEFAULTS.requoteMoveU),
    replenishBelowPct: DEFAULTS.replenishBelowPct,
    staleS: DEFAULTS.staleS,
    minRequoteS: DEFAULTS.minRequoteS,
    maxNetTokens: DEFAULTS.maxNetTokens,
    maxPairsTokens: DEFAULTS.maxPairsTokens,
    stopBeforeEndS: DEFAULTS.stopBeforeEndS,
  };
  const book = bookFields(j, base, "");
  let factories = DEFAULTS.factories;
  if (j.factories !== undefined) {
    if (!Array.isArray(j.factories) || j.factories.some((x) => typeof x !== "string" || x === "")) throw new ConfigError("config: factories is not a list of names");
    factories = j.factories as string[];
  }
  const big = (k: "maxLossU" | "dollarLowU" | "dollarBufferU") => BigInt(num(j[k] ?? DEFAULTS[k], k, { min: 0 }));
  const keepMon = num(j.keepMon ?? DEFAULTS.keepMon, "keepMon", { min: 0, int: false });
  const lowBalanceMon = num(j.lowBalanceMon ?? DEFAULTS.lowBalanceMon, "lowBalanceMon", { min: 0, int: false });
  const ru = j.runUntil ?? DEFAULTS.runUntil;
  if (typeof ru !== "string" || Number.isNaN(Date.parse(ru))) throw new ConfigError("config: runUntil is not an ISO time");
  const tickS = j.tickS === undefined || j.tickS === null ? null : num(j.tickS, "tickS", { min: 1 });
  const headStartS = num(j.headStartS ?? DEFAULTS.headStartS, "headStartS", { min: 0, max: 86_400 });
  const perFactory: Record<string, Partial<BookConfig>> = {};
  const pf = (j.perFactory ?? {}) as Record<string, unknown>;
  if (typeof pf !== "object" || Array.isArray(pf)) throw new ConfigError("config: perFactory is not an object");
  for (const [name, raw] of Object.entries(pf)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`config: perFactory.${name} is not an object`);
    for (const k of Object.keys(raw)) if (!(BOOK_FIELDS as readonly string[]).includes(k)) throw new ConfigError(`config: unknown field perFactory.${name}.${k}`);
    bookFields(raw as Record<string, unknown>, book, `perFactory.${name}.`); // validates the merged result
    perFactory[name] = raw as Partial<BookConfig>;
  }
  return {
    ...book,
    factories,
    maxLossU: big("maxLossU"),
    dollarLowU: big("dollarLowU"),
    dollarBufferU: big("dollarBufferU"),
    tickS,
    keepMon,
    lowBalanceMon,
    keepWei: parseEther(String(keepMon)),
    lowBalanceWei: parseEther(String(lowBalanceMon)),
    runUntil: Math.floor(Date.parse(ru) / 1000),
    headStartS,
    perFactory,
    kuruV2: parseV2(j.kuruV2, book),
  };
}

/** The ladder and requote fields the V2 desk reads. Its wind-down is the series' (V1's stopAt), its mint cap the top
 *  level's maxPairsTokens and its inventory cap maxBaseTokens, so maxNetTokens, maxPairsTokens and stopBeforeEndS are
 *  refused under kuruV2 rather than silently ignored. */
export const V2_BOOK_FIELDS = ["spreadBps", "levels", "levelStepTicks", "sizesTokens", "requoteMoveU", "replenishBelowPct", "staleS", "minRequoteS"] as const;

/** kuruV2: { accountCore?, books: [{ market, series }], maxBaseTokens?, ...V2_BOOK_FIELDS } over the top-level book
 *  (not perFactory) with V2_DEFAULTS' levels and sizes. */
function parseV2(raw: unknown, top: BookConfig): V2Cfg | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("config: kuruV2 is not an object");
  const j = raw as Record<string, unknown>;
  const own = new Set(["accountCore", "books", "maxBaseTokens"]);
  for (const k of Object.keys(j)) if (!own.has(k) && !(V2_BOOK_FIELDS as readonly string[]).includes(k)) throw new ConfigError(`config: unknown field kuruV2.${k}`);
  const accountCore = (j.accountCore ?? KURU_V2_ACCOUNT_CORE) as string;
  if (typeof accountCore !== "string" || !ADDRESS.test(accountCore)) throw new ConfigError("config: kuruV2.accountCore is not an address");
  if (!Array.isArray(j.books) || j.books.length === 0) throw new ConfigError("config: kuruV2.books is not a list of { market, series }");
  const books = j.books.map((b, i) => {
    const x = b as Record<string, unknown>;
    if (!x || typeof x !== "object" || typeof x.market !== "string" || !ADDRESS.test(x.market) || typeof x.series !== "string" || !ADDRESS.test(x.series)) throw new ConfigError(`config: kuruV2.books[${i}] needs a market and a series address`);
    for (const k of Object.keys(x)) if (k !== "market" && k !== "series") throw new ConfigError(`config: unknown field kuruV2.books[${i}].${k}`);
    return { market: x.market as Address, series: x.series as Address };
  });
  if (new Set(books.map((b) => b.market.toLowerCase())).size !== books.length) throw new ConfigError("config: kuruV2.books names a market twice");
  const fields = Object.fromEntries(Object.entries(j).filter(([k]) => !own.has(k)));
  const book = bookFields(fields, { ...top, sizesTokens: [...V2_DEFAULTS.sizesTokens], levels: V2_DEFAULTS.levels }, "kuruV2.");
  const maxBaseTokens = num(j.maxBaseTokens ?? V2_DEFAULTS.maxBaseTokens, "kuruV2.maxBaseTokens", { min: 0 });
  return { ...book, accountCore: accountCore as Address, books, maxBaseTokens };
}

/** The book fields for one factory: the top level with perFactory.<name> over it. */
export function bookConfig(c: MmConfig, factory: string): BookConfig {
  const raw = c.perFactory[factory];
  if (!raw) return c;
  return bookFields(raw as Record<string, unknown>, c, `perFactory.${factory}.`);
}

export function loadConfig(path: string | undefined): MmConfig {
  if (!path) return parseConfig(null);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError("config: AGATE_MM_CONFIG cannot be read");
  }
  return parseConfig(text);
}

/** stopBeforeEndS null: max(60, DAY / 24) per series. */
export function stopBeforeEnd(b: BookConfig, day: number): number {
  return b.stopBeforeEndS ?? Math.max(60, Math.floor(day / 24));
}

/** tickS null: clamp(min DAY of the quoted factories / 20, 10, 60). */
export function tickSeconds(c: MmConfig, days: readonly number[]): number {
  if (c.tickS !== null) return c.tickS;
  if (days.length === 0) return 30;
  return Math.min(60, Math.max(10, Math.floor(Math.min(...days) / 20)));
}
