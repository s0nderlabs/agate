// Environment, panels and the startup checks both bun writers run before their first tick.
import { readFileSync } from "node:fs";
import { installScrubber, type RpcEndpoints, resolveRpcEndpoints, scrubSecrets } from "@agate/report/env";
import type { Address, Hex } from "@agate/report/types";
import type { Panel, SourcesPureApi } from "@agate/sources/types";
import { asSourcesApi, type Clock, clockMismatches, clockOf, neededSources, planReaders, takeReading } from "../core/index.ts";
import type { IndexChain } from "./chain.ts";
import type { PageReader } from "./fetch.ts";
import type { Shape } from "./sender.ts";
import type { ReadingSource } from "./writer.ts";

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing environment variable ${name}`);
  return v;
}

/** Takes a private key from the environment and removes it from process.env so nothing later can print it. */
export function takeKey(name: string): Hex {
  const v = process.env[name];
  delete process.env[name];
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} is missing or not a 32-byte hex key`);
  return v as Hex;
}

/** The RPC endpoints (13.6): AGATE_RPC_URLS_CMD (a command run once at start, printing the list; the Alchemy URL carries
 * a key), else AGATE_RPC_URLS (two or more, comma-separated), else AGATE_RPC_URL (one: RPC_SINGLE). Afterwards both
 * list variables are gone from `e` (pass process.env), so no child inherits them. Errors never echo a URL. */
export function rpcEndpointsFromEnv(e: Record<string, string | undefined> = process.env, run?: (cmd: string) => string): RpcEndpoints {
  const r = run ? resolveRpcEndpoints(e, run) : resolveRpcEndpoints(e);
  delete e.AGATE_RPC_URL;
  return { http: [...new Set(r.http)], ws: [...new Set(r.ws)] };
}

/** The HTTP endpoints of rpcEndpointsFromEnv, in failover order. */
export function rpcUrlsFromEnv(e: Record<string, string | undefined> = process.env): string[] {
  return rpcEndpointsFromEnv(e).http;
}

/** Turns on 13.6's redaction for this process: stdout and stderr scrubbed, and the scrub function for files. */
export function redaction(endpoints: RpcEndpoints): (s: string) => string {
  installScrubber(endpoints);
  return (s: string) => scrubSecrets(s, endpoints);
}

/** MEASURED overrides (gas units): AGATE_GAS_POST, AGATE_GAS_CLOSE, AGATE_GAS_ONREPORT. Unset: the contracts' published figures. */
export function measuredFromEnv(e: Record<string, string | undefined> = process.env): Partial<Record<Shape, bigint>> {
  const g: Partial<Record<Shape, bigint>> = {};
  const take = (k: string, s: Shape) => {
    if (!e[k]) return;
    if (!/^\d+$/.test(e[k]!) || BigInt(e[k]!) < 21_000n) throw new Error(`${k} must be a gas amount`);
    g[s] = BigInt(e[k]!);
  };
  take("AGATE_GAS_POST", "postReport");
  take("AGATE_GAS_CLOSE", "closeDay");
  take("AGATE_GAS_ONREPORT", "onReport");
  return g;
}

/** AGATE_MAX_FEE_GWEI: a cap on maxFeePerGas, in wei (decimal gwei allowed). */
export function maxFeeFromEnv(e: Record<string, string | undefined> = process.env): bigint | undefined {
  const v = e.AGATE_MAX_FEE_GWEI;
  if (!v) return undefined;
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(v.trim());
  if (!m) throw new Error("AGATE_MAX_FEE_GWEI must be a number of gwei");
  return BigInt(m[1]!) * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
}

/** AGATE_PANELS: a JSON file holding Panel[] (or {panels: Panel[]}), one per GPU registered on this index. */
export function loadPanels(path: string): Panel[] {
  return loadPanelFile(path).panels;
}

/** The panel file with the panel tool's flags (panels/launch.json carries includeOverCap: 7.10). */
export function loadPanelFile(path: string): { panels: Panel[]; flags: { includeOverCap?: boolean; includeEur?: boolean } } {
  const j = JSON.parse(readFileSync(path, "utf8")) as Panel[] | { panels: Panel[]; flags?: { includeOverCap?: boolean; includeEur?: boolean } };
  const panels = Array.isArray(j) ? j : j.panels;
  if (!Array.isArray(panels) || panels.length === 0) throw new Error(`${path}: no panels`);
  const flags = Array.isArray(j) ? {} : { ...(j.flags ?? {}) };
  return { panels, flags };
}

export async function loadSourcesApi(): Promise<SourcesPureApi> {
  return asSourcesApi(await import("@agate/sources/pure"));
}

export interface StartInfo {
  clock: Clock;
  /** The panels whose GPU is registered on this index (an unregistered one is left out with a warning). */
  panels: Panel[];
  chainSelector: bigint;
  slot: number; // this key's writer slot, -1 if none
  warnings: string[];
}

/** Reads the clock, checks each panel against the registered GPU (slot count and recipeHash) and the key's role.
 * A panel that does not match its registration refuses the start (a wrong recipe would post wrong slots). */
export async function startupChecks(chain: IndexChain, panels: readonly Panel[], api: SourcesPureApi, expectSlot: 0 | 1): Promise<StartInfo> {
  const c = await chain.clocks();
  const warnings: string[] = clockMismatches(c).map((m) => `clocks() differ from BUILD-SPEC 2.2 (the chain's values are used): ${m}`);
  const ids = new Set<string>();
  const active: Panel[] = [];
  for (const p of panels) {
    if (ids.has(p.gpuId.toLowerCase())) throw new Error(`${p.gpu}: panel listed twice`);
    ids.add(p.gpuId.toLowerCase());
    if (api.gpuIdOf(p.spec).toLowerCase() !== p.gpuId.toLowerCase()) throw new Error(`${p.gpu}: gpuId does not match its spec`);
    const g = await chain.gpu(p.gpuId as Hex);
    if (Number(g.nSlots) === 0) {
      warnings.push(`${p.gpu} ${p.gpuId} is not registered on ${chain.index}: left out until a restart after registerGpu`);
      continue;
    }
    if (Number(g.nSlots) !== p.slots.length) throw new Error(`${p.gpu}: panel has ${p.slots.length} slots, index has ${g.nSlots}`);
    const h = api.recipeHash(p);
    if (h.toLowerCase() !== g.recipeHash.toLowerCase()) throw new Error(`${p.gpu}: recipeHash ${h} differs from the registered ${g.recipeHash}`);
    active.push(p);
  }
  if (active.length === 0) throw new Error(`no panel of AGATE_PANELS is registered on ${chain.index}`);
  const ws = await chain.writers();
  const slot = ws.findIndex((w: Address) => w.toLowerCase() === chain.writer.toLowerCase());
  if (slot !== expectSlot) warnings.push(`this key ${chain.writer} is writer slot ${slot}, expected ${expectSlot}`);
  if (slot >= 0 && (await chain.isSuspended(chain.writer))) warnings.push(`this key ${chain.writer} is suspended`);
  return { clock: clockOf(c), panels: active, chainSelector: BigInt(c.chainSelector), slot, warnings };
}

/** The direct reading path: fetch every page from this machine, parse with @agate/sources; with the day's readers
 * in force (8.6) each distinct URL is fetched once and each GPU parsed with its slot's parser version. */
export function directSource(api: SourcesPureApi, panels: readonly Panel[], reader: PageReader): ReadingSource {
  const defs = neededSources(api, panels);
  return {
    async take(at) {
      const t0 = Date.now();
      const plans = at.readers ? planReaders(api, defs, panels, at.readers) : undefined;
      const { pages, fx } = await reader.readAll(defs, at.readAt, plans);
      return { reading: takeReading(api, panels, defs, at, pages, fx, plans), via: "direct", ms: Date.now() - t0 };
    },
  };
}

export function jsonSay(role: string) {
  return (event: string, data?: Record<string, unknown>) =>
    console.log(JSON.stringify({ t: Math.floor(Date.now() / 1000), role, event, ...data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
