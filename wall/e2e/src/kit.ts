// Shared pieces of the e2e scenarios (scenarios.ts, the Oct 1 set; upgrades.ts, the Oct 3 set): the scripted
// H100 world, the run-and-judge wrapper and small readers of events and logs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReplayScenario, ScriptedSource } from "@agate/sources/io";
import type { WallEvent } from "@agate/watcher";
import { ROOT } from "./chain.ts";
import { type DayRow, judge, type JudgeOptions, type RunReport } from "./report.ts";
import { World, type WorldOptions } from "./world.ts";

export const T0 = 1_790_000_000; // 2026-09-21: anvil's first block on the demo profiles
export const OCT1 = 20_727;
export const NOV1 = 20_758;
export const GUARD = { delay: 1, looks: true, suspend: true };
export const H100_ID = "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955";
export const KIND = { OUT: 0, FRESH: 1, HELD: 2 } as const;

export interface Scenario {
  name: string;
  what: string;
  needsArchive?: boolean;
  /** macOS with /usr/bin/sandbox-exec (the repair agent's sandbox, 15.2) */
  needsSandbox?: boolean;
  run(): Promise<RunReport>;
}

export const haveSandbox = (): boolean => process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

export const p = (price: string) => ({ price, count: 8 as const });
export type Steps = { from: { day: number; slice?: number }; price?: string; count?: 1 | 8; state?: "not-rentable" | "missing" | "garbled" }[];

/** Five single-cloud H100 families at fixed prices (the spec's 3.00 / 3.20 / 3.40 / 3.60 / 3.80 world, slot order
 *  Verda, Nebius, Lambda, Civo, Hyperstack), with extra steps per slot. Demo days are relative to the epoch. */
export function h100World(steps: Partial<Record<0 | 1 | 2 | 3 | 4, Steps>> = {}, base = ["3.00", "3.20", "3.40", "3.60", "3.80"]): Record<string, ScriptedSource> {
  const ids = ["p_verda", "p_nebius", "p_lambda", "p_civo", "p_hyperstack"];
  const out: Record<string, ScriptedSource> = {};
  ids.forEach((id, i) => {
    out[id] = { gpus: { H100: [{ from: { day: 0 }, ...p(base[i]!) }, ...((steps as Record<number, Steps>)[i] ?? [])] } };
  });
  return out;
}

export function demoScenario(): ReplayScenario {
  return JSON.parse(readFileSync(join(ROOT, "wall/packages/sources/replay/demo.json"), "utf8")) as ReplayScenario;
}

export async function runWorld(o: WorldOptions, until: (w: World) => number, j: JudgeOptions = {}, during?: (w: World) => Promise<void> | void): Promise<RunReport> {
  const w = await World.create(o);
  const t0 = Date.now();
  try {
    await w.runUntil(until(w), during);
    const r = await judge(w, j);
    r.stats.wallMs = Date.now() - t0;
    r.stats.home = w.home;
    return r;
  } finally {
    w.stop();
  }
}

export const relDay = (w: World, k: number) => w.dep.epochDay + k;
export const guard = (day: number) => ({ delay: Math.max(1, Math.floor(day / 40)), looks: true, suspend: true });
export const lc = (a: string) => a.toLowerCase();
export const final = (days: DayRow[], d: number, gpu = "H100") => days.find((x) => x.gpu === gpu && x.day === d);

export function slotsOf(ev: WallEvent[], gpuId: string, day: number, digest?: string) {
  const xs = ev.filter((e): e is Extract<WallEvent, { name: "RecordSlots" }> => e.name === "RecordSlots" && e.gpuId.toLowerCase() === gpuId.toLowerCase() && e.day === day && (!digest || e.digest.toLowerCase() === digest.toLowerCase()));
  return xs[xs.length - 1];
}

/** Per-role copies of a global script with extra page states for some roles (a view split). */
export function withRoles(scripted: Record<string, ScriptedSource>, id: string, roles: string[], page: { from: { day: number; slice?: number }; state: "ok" | "broken" | "http-503" | "hang" | "gzip-raw" }[]): ReplayScenario {
  const out: ReplayScenario = { archive: false, scripted, roles: {} };
  for (const r of roles) out.roles![r] = { [id]: { ...scripted[id]!, page } };
  return out;
}

/** Every JSON line of every file in a folder (sorted by name), skipping a torn line. */
export function jsonLines<T = Record<string, unknown>>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l) as T);
      } catch {
        // a torn line
      }
    }
  }
  return out;
}

/** The unix second of the block an event was emitted in (its key is "block:logIndex"). */
export async function eventTime(w: World, e: { key: string }): Promise<number> {
  return Number((await w.a.pub.getBlock({ blockNumber: BigInt(Number(e.key.split(":")[0])) })).timestamp);
}

/** Every file under a folder, recursively. */
export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
