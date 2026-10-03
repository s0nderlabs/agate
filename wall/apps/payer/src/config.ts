// BOTS-SPEC 4.7: the payer's config (AGATE_PAYER_CONFIG, JSON; every field optional; defaults of section 9). An
// unknown field is refused, so a typo never silently keeps a default.
import { readFileSync } from "node:fs";
import { CENT, MAX_CLAIM_IDS } from "@agate/market";

export class ConfigError extends Error {}

export interface PayerConfig {
  /** factory names of the deployments file; null: every entry */
  factories: string[] | null;
  lister: boolean;
  payer: boolean;
  claimThresholdU: bigint;
  maxIdsPerCall: number;
  claimEveryDays: Record<string, number>;
  keepMon: number;
  lowBalanceMon: number;
  /** unix seconds */
  runUntil: number;
  runUntilIso: string;
  /** null: clamp(min DAY / 20, 10, 300) */
  tickS: number | null;
  logChunk: number;
}

export const DEFAULTS = {
  factories: null,
  lister: true,
  payer: true,
  claimThresholdU: 10_000,
  maxIdsPerCall: 50,
  claimEveryDays: { demo: 1, real: 1, pilot: 1 },
  keepMon: 15,
  lowBalanceMon: 60,
  // through judging and the November series' settle and final sweep (the real calendar's November settles Dec 1)
  runUntil: "2026-12-02T00:00:00Z",
  tickS: null,
  logChunk: 100,
} as const;

const FIELDS = new Set(Object.keys(DEFAULTS));

function int(v: unknown, f: string, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < lo || v > hi) throw new ConfigError(`AGATE_PAYER_CONFIG.${f} is not an integer in ${lo}..${hi}`);
  return v;
}
function num(v: unknown, f: string, lo: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo) throw new ConfigError(`AGATE_PAYER_CONFIG.${f} is not a number >= ${lo}`);
  return v;
}
function bool(v: unknown, f: string): boolean {
  if (typeof v !== "boolean") throw new ConfigError(`AGATE_PAYER_CONFIG.${f} is not true or false`);
  return v;
}

export function parseConfig(input: unknown = {}): PayerConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigError("AGATE_PAYER_CONFIG is not a JSON object");
  const j = input as Record<string, unknown>;
  for (const k of Object.keys(j)) if (!FIELDS.has(k)) throw new ConfigError(`AGATE_PAYER_CONFIG has an unknown field ${k}`);
  const g = <K extends keyof typeof DEFAULTS>(k: K): unknown => (j[k] === undefined ? DEFAULTS[k] : j[k]);

  const fs = g("factories");
  let factories: string[] | null = null;
  if (fs !== null) {
    if (!Array.isArray(fs) || fs.length === 0 || fs.some((x) => typeof x !== "string" || x === "")) throw new ConfigError("AGATE_PAYER_CONFIG.factories is not null or a list of factory names");
    factories = [...new Set(fs as string[])];
  }
  const thr = g("claimThresholdU");
  if (!(typeof thr === "number" && Number.isSafeInteger(thr) && thr >= 1) && !(typeof thr === "string" && /^[1-9][0-9]*$/.test(thr))) throw new ConfigError("AGATE_PAYER_CONFIG.claimThresholdU is not a positive integer (u)");
  const ced = g("claimEveryDays");
  if (!ced || typeof ced !== "object" || Array.isArray(ced)) throw new ConfigError("AGATE_PAYER_CONFIG.claimEveryDays is not an object of factory name to days");
  const claimEveryDays: Record<string, number> = { ...DEFAULTS.claimEveryDays };
  for (const [k, v] of Object.entries(ced as Record<string, unknown>)) claimEveryDays[k] = int(v, `claimEveryDays.${k}`, 1, 31);
  const ru = g("runUntil");
  const runUntilMs = typeof ru === "string" ? Date.parse(ru) : NaN;
  if (typeof ru !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(ru) || !Number.isFinite(runUntilMs)) throw new ConfigError("AGATE_PAYER_CONFIG.runUntil is not an ISO date-time");
  const tick = g("tickS");
  const keepMon = num(g("keepMon"), "keepMon", 0);
  const lowBalanceMon = num(g("lowBalanceMon"), "lowBalanceMon", 0);
  return {
    factories,
    lister: bool(g("lister"), "lister"),
    payer: bool(g("payer"), "payer"),
    claimThresholdU: BigInt(thr as number | string),
    maxIdsPerCall: int(g("maxIdsPerCall"), "maxIdsPerCall", 1, MAX_CLAIM_IDS),
    claimEveryDays,
    keepMon,
    lowBalanceMon,
    runUntil: Math.floor(runUntilMs / 1000),
    runUntilIso: ru,
    tickS: tick === null ? null : int(tick, "tickS", 1, 3_600),
    logChunk: int(g("logChunk"), "logChunk", 10, 10_000),
  };
}

/** The config file named by AGATE_PAYER_CONFIG, else every default. */
export function loadConfig(path: string | undefined = process.env.AGATE_PAYER_CONFIG): PayerConfig {
  if (!path) return parseConfig({});
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError("AGATE_PAYER_CONFIG cannot be read");
  }
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new ConfigError("AGATE_PAYER_CONFIG is not JSON");
  }
  return parseConfig(j);
}

export const DEFAULT_THRESHOLD = CENT;
