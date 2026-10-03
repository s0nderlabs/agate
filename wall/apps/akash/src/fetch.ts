// Akash public REST reads for the traded-price reader (BUILD-SPEC 16, steps 1 to 3 and 7). Read only: no key, no
// transaction, an honest user agent, endpoints in order with failover on an error, a timeout or a wrong chain id.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { blockMsBetween, buildFile, computeTraded, groupKey, type AkashTradedFile, type GroupIn, type Groups, type LeaseIn, type ResourceIn } from "./akash.ts";

export const USER_AGENT = "agate-wall/akash/0.1 (+https://github.com/s0nderlabs/agate)";
export const CHAIN_ID = "akashnet-2";
export const DEFAULT_ENDPOINTS = ["https://api.akashnet.net", "https://akash-api.polkachu.com", "https://rest-akash.ecostake.com", "https://akash-rest.publicnode.com"] as const;
export const BLOCK_SPAN = 10_000;
export const INFO_CAP = 200;
const LEASES = "/akash/market/v1beta5/leases/list";
const DEP_INFO = "/akash/deployment/v1beta4/deployments/info";
const DEP_LIST = "/akash/deployment/v1beta4/deployments/list";
const BLOCKS = "/cosmos/base/tendermint/v1beta1/blocks";

export type GetJson = (url: string, timeoutMs: number) => Promise<unknown>;

export const httpGetJson: GetJson = async (url, timeoutMs) => {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
const str = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" ? String(x) : "");
const host = (ep: string) => {
  try {
    return new URL(ep).host;
  } catch {
    return ep;
  }
};

export interface Header {
  chainId: string;
  height: number;
  time: string;
}

function headerOf(j: unknown): Header {
  const b = obj(obj(j).block ?? obj(j).sdk_block);
  const h = obj(b.header);
  const height = Number(str(h.height));
  if (!str(h.chain_id) || !Number.isSafeInteger(height) || !str(h.time)) throw new Error("no block header");
  return { chainId: str(h.chain_id), height, time: str(h.time) };
}

/** Rule 16.1: the latest header and the one BLOCK_SPAN earlier; blockMs in whole milliseconds. */
export async function measureBlocks(ep: string, get: GetJson, timeoutMs: number): Promise<{ latest: Header; blockMs: number }> {
  const latest = headerOf(await get(`${ep}${BLOCKS}/latest`, timeoutMs));
  if (latest.chainId !== CHAIN_ID) throw new Error(`chain id ${latest.chainId}, expected ${CHAIN_ID}`);
  const old = headerOf(await get(`${ep}${BLOCKS}/${latest.height - BLOCK_SPAN}`, timeoutMs));
  if (old.chainId !== CHAIN_ID) throw new Error(`chain id ${old.chainId}, expected ${CHAIN_ID}`);
  return { latest, blockMs: blockMsBetween(old.time, latest.time, latest.height - old.height) };
}

async function pages<T>(base: string, get: GetJson, timeoutMs: number, pick: (j: Record<string, unknown>) => T[], maxPages = 400): Promise<T[]> {
  const out: T[] = [];
  let key = "";
  for (let i = 0; i < maxPages; i++) {
    const url = key ? `${base}&pagination.key=${encodeURIComponent(key)}` : base;
    const j = obj(await get(url, timeoutMs));
    out.push(...pick(j));
    key = str(obj(j.pagination).next_key);
    if (!key) return out;
  }
  throw new Error(`more than ${maxPages} pages at ${base}`);
}

export function leaseOf(x: unknown): LeaseIn | null {
  const l = obj(obj(x).lease);
  const id = obj(l.id);
  const price = obj(l.price);
  const gseq = Number(str(id.gseq));
  if (!str(id.owner) || !str(id.dseq) || !Number.isSafeInteger(gseq) || !str(id.provider)) return null;
  return { owner: str(id.owner), dseq: str(id.dseq), gseq, provider: str(id.provider), price: { denom: str(price.denom), amount: str(price.amount) } };
}

/** Rule 16.2: every active lease, all pages. */
export async function readLeases(ep: string, get: GetJson, timeoutMs: number): Promise<LeaseIn[]> {
  const raw = await pages(`${ep}${LEASES}?filters.state=active&pagination.limit=1000`, get, timeoutMs, (j) => (Array.isArray(j.leases) ? j.leases : []));
  return raw.map(leaseOf).filter((x): x is LeaseIn => x !== null);
}

/** The resources of one group JSON, GPU fields only (cache form). */
export function groupOf(g: unknown): { key: string; group: GroupIn } | null {
  const id = obj(obj(g).id);
  if (!str(id.owner) || !str(id.dseq) || str(id.gseq) === "") return null;
  const spec = obj(obj(g).group_spec);
  const resources: ResourceIn[] = [];
  for (const r of Array.isArray(spec.resources) ? spec.resources : []) {
    const gpu = obj(obj(obj(r).resource).gpu);
    const units = Number(str(obj(gpu.units).val) || "0");
    const keys = (Array.isArray(gpu.attributes) ? gpu.attributes : []).map(obj).filter((a) => str(a.value) !== "false").map((a) => str(a.key)).filter(Boolean);
    resources.push({ gpuUnits: Number.isSafeInteger(units) ? units : 0, gpuKeys: keys, count: Number(str(obj(r).count) || "0") || 0 });
  }
  return { key: groupKey(str(id.owner), str(id.dseq), str(id.gseq)), group: { resources } };
}

function groupsOfDeployment(d: unknown, into: Record<string, GroupIn>): void {
  for (const g of Array.isArray(obj(d).groups) ? (obj(d).groups as unknown[]) : []) {
    const x = groupOf(g);
    if (x) into[x.key] = x.group;
  }
}

export interface GroupFetchStats {
  cached: number;
  lookedUp: number;
  listed: boolean;
  infoCalls: number;
}

/** Rule 16.3: groups from the cache; missing ones by deployments/info (at most INFO_CAP deployments), or, when more
 *  are missing (the first run), the whole active deployments list in pages of 500. */
export async function readGroups(ep: string, get: GetJson, timeoutMs: number, leases: readonly LeaseIn[], cache: Record<string, GroupIn>, cap = INFO_CAP): Promise<{ groups: Record<string, GroupIn>; stats: GroupFetchStats }> {
  const groups: Record<string, GroupIn> = { ...cache };
  const missing = new Map<string, { owner: string; dseq: string }>();
  for (const l of leases) if (!groups[groupKey(l.owner, l.dseq, l.gseq)]) missing.set(`${l.owner}/${l.dseq}`, { owner: l.owner, dseq: l.dseq });
  const stats: GroupFetchStats = { cached: leases.filter((l) => cache[groupKey(l.owner, l.dseq, l.gseq)]).length, lookedUp: 0, listed: false, infoCalls: 0 };
  if (missing.size > cap) {
    const deps = await pages(`${ep}${DEP_LIST}?filters.state=active&pagination.limit=500`, get, timeoutMs, (j) => (Array.isArray(j.deployments) ? j.deployments : []));
    for (const d of deps) groupsOfDeployment(d, groups);
    stats.listed = true;
  } else {
    for (const { owner, dseq } of missing.values()) {
      stats.infoCalls++;
      const j = await get(`${ep}${DEP_INFO}?id.owner=${encodeURIComponent(owner)}&id.dseq=${encodeURIComponent(dseq)}`, timeoutMs);
      groupsOfDeployment(j, groups);
    }
  }
  stats.lookedUp = missing.size;
  return { groups, stats };
}

export interface RunOptions {
  home: string; // <AGATE_WALL_HOME>/akash
  endpoints?: readonly string[];
  get?: GetJson;
  timeoutMs?: number;
  now?: () => number;
  infoCap?: number;
  /** wait before the one retry of a failed read (ms) */
  retryMs?: number;
}

export interface RunResult {
  ok: boolean;
  file: AkashTradedFile;
  endpoint?: string;
  stats?: GroupFetchStats;
  errors: string[];
}

export const outPath = (home: string) => join(home, "akash-traded.json");
export const cachePath = (home: string) => join(home, "groups.json");

function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
  } catch {
    return null;
  }
}

/** One run: tries each endpoint in order (the whole run on one endpoint, so its numbers are consistent), writes the
 *  output and the history line. A run that fails everywhere keeps the last good file and sets `error`. */
export async function runOnce(o: RunOptions): Promise<RunResult> {
  const base = o.get ?? httpGetJson;
  // one retry on the same endpoint before failing over: a run restarted elsewhere re-reads everything
  const get: GetJson = async (url, t) => {
    try {
      return await base(url, t);
    } catch {
      await Bun.sleep(o.retryMs ?? 1_000);
      return base(url, t);
    }
  };
  const timeoutMs = o.timeoutMs ?? 60_000;
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const cache = readJson<Record<string, GroupIn>>(cachePath(o.home)) ?? {};
  const errors: string[] = [];
  for (const ep of o.endpoints ?? DEFAULT_ENDPOINTS) {
    try {
      const { latest, blockMs } = await measureBlocks(ep, get, timeoutMs);
      const leases = await readLeases(ep, get, timeoutMs);
      const { groups, stats } = await readGroups(ep, get, timeoutMs, leases, cache, o.infoCap ?? INFO_CAP);
      const used: Record<string, GroupIn> = {};
      for (const l of leases) {
        const k = groupKey(l.owner, l.dseq, l.gseq);
        if (groups[k]) used[k] = groups[k]!;
      }
      const traded = computeTraded(leases, used as Groups, blockMs);
      const file = buildFile({ generatedAt: now(), chain: { id: latest.chainId, height: latest.height, time: latest.time }, endpoint: host(ep), blockMs, blocks: BLOCK_SPAN, traded });
      writeAtomic(cachePath(o.home), JSON.stringify(used));
      writeAtomic(outPath(o.home), `${JSON.stringify(file, null, 1)}\n`);
      history(o.home, file, file.generatedAt);
      return { ok: true, file, endpoint: ep, stats, errors };
    } catch (e) {
      errors.push(`${host(ep)}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  }
  const last = readJson<AkashTradedFile>(outPath(o.home));
  const error = `every endpoint failed (${errors.join("; ")})`.slice(0, 600);
  const file: AkashTradedFile = last
    ? { ...last, error }
    : { ...buildFile({ generatedAt: now(), chain: { id: CHAIN_ID, height: 0, time: "" }, endpoint: "", blockMs: 0, blocks: BLOCK_SPAN, traded: { gpus: {}, leasesSeen: 0, missingGroups: 0 } }), error };
  writeAtomic(outPath(o.home), `${JSON.stringify(file, null, 1)}\n`);
  history(o.home, file, now());
  return { ok: false, file, errors };
}

function history(home: string, f: AkashTradedFile, at: number): void {
  const date = new Date(at * 1000).toISOString().slice(0, 10);
  const p = join(home, "history", `${date}.jsonl`);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, `${JSON.stringify(f)}\n`);
}
