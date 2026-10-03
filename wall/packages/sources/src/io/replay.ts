// Replay server (BUILD-SPEC 7.9): answers GET /<sourceId> (and /fx_ecb) the way the writers' SOURCE_BASE_URL expects,
// with the archived raw page of the real hour mapped from the request's clock, or with a scripted synthetic page.
// Every answer carries X-Agate-Page-Time (the page's own time, for the FX rule and the logs). Raw pages are served
// from the local archive only; nothing is copied anywhere.
//
// Clock: the request's time is X-Agate-Clock (unix s, for e2e) or the server's wall clock. Demo time maps linearly
// onto the archive: one demo day = one real day, real = archiveStart + ((t - t0) * 86400 / daySec) mod archiveSpan,
// served from the latest archived hour at or before that real time.
// Requesters: a path prefix /r/<role>/<sourceId> (or header X-Agate-Role) selects a per-role script, so e2e can show
// one page differently to one writer or to the watcher.
// Oct 3 (7.9): a slot whose reader was swapped still fetches /<sourceId> (the reader decides only the parser); a page
// step "redesigned" renders the scripted prices in a second synthetic layout every "/1" parser reads as NO_ROW; the
// page check's trackers: /t_gputable (the archived t_gputable.all.gz of the mapped hour, or a scripted body) and
// /t_gpu_economy/<file> (one of GPU_ECONOMY_FILES; scripted only, else 404: the logger keeps no GPU Economy data
// files). The archived GPUTable file follows the scripted price steps (the mapped provider's on-demand rows of that GPU).
import type { GpuModel } from "@agate/report/types";
import { parse, reasonOf } from "../pure/parse.ts";
import { ECB, GPUS, SOURCES } from "../pure/recipe.ts";
import { renderEcb, renderPage, type SynthGpu, type SynthPage } from "../synthetic.ts";
import type { FxRate } from "../types.ts";
import { type ArchiveHour, listHours, pageTimeOf, rawDir, readArchived } from "./archive.ts";
import { dayNumber, parseEcb } from "../pure/ecb.ts";
import { fxMicro, parseMicro } from "../pure/money.ts";
import { elements } from "../pure/text.ts";

export interface StepAt {
  day: number;
  slice?: number;
}
export interface GpuStep {
  from: StepAt;
  price?: string; // per-GPU native price
  count?: 1 | 8;
  state?: "not-rentable" | "missing" | "garbled";
}
export interface PageStep {
  from: StepAt;
  state: "ok" | "broken" | "http-503" | "hang" | "gzip-raw" | "redesigned";
}
/** GPUTable's provider name per sourceId and its GPU names (15.1's table; the page check's TRACKER_MAP agrees, a
 *  pagecheck test pins it). */
export const GPUTABLE_PROVIDER: Readonly<Record<string, string>> = { p_verda: "Verda", p_nebius: "Nebius", p_lambda: "Lambda Labs", p_coreweave: "CoreWeave", p_civo: "Civo", p_hyperstack: "Hyperstack" };
export const GPUTABLE_GPU: Readonly<Record<GpuModel, string>> = { H100: "H100 SXM", H200: "H200", B200: "B200", B300: "B300", A100: "A100 SXM", L40S: "L40S" };
/** GPU Economy's per-GPU data file, by the path segment the page check fetches (18.4: b300, a100-80, l40s). */
export const GPU_ECONOMY_FILE = { H100: "h100-sxm", H200: "h200", B200: "b200", B300: "b300", A100: "a100-80", L40S: "l40s" } as const satisfies Record<GpuModel, string>;
export type GpuEconomyFile = (typeof GPU_ECONOMY_FILE)[GpuModel];
/** Every GPU's file, in GPUS order. */
export const GPU_ECONOMY_FILES: readonly GpuEconomyFile[] = GPUS.map((g) => GPU_ECONOMY_FILE[g]);
/** A tracker file from a step on: a JSON body in the tracker's own field names (synthetic numbers only), or an HTTP
 * status (a tracker outage). */
export interface TrackerStep {
  from: StepAt;
  body?: unknown;
  status?: number;
}
export interface TrackerScript {
  gputable?: TrackerStep[];
  gpuEconomy?: Partial<Record<GpuEconomyFile, TrackerStep[]>>;
}
export interface ScriptedSource {
  gpus?: Partial<Record<GpuModel, GpuStep[]>>;
  page?: PageStep[];
}
export interface ReplayScenario {
  scripted?: Record<string, ScriptedSource>;
  roles?: Record<string, Record<string, ScriptedSource>>;
  /** Extra ECB rates (date to USD per EUR) beside the archived ones. */
  fx?: Record<string, string>;
  /** false: never serve archived pages (scripted only; a source with no script answers 404). */
  archive?: boolean;
  /** The page check's tracker files (15.1), scripted. */
  trackers?: TrackerScript;
}
export interface ReplayOptions {
  port?: number; // 0 = any free port
  hostname?: string;
  rawDir?: string;
  clock: { t0: number; daySec: number; slices: number };
  scenario?: ReplayScenario;
  now?: () => number;
  hangMs?: number; // how long a "hang" page waits before answering (default 10 min)
}

export interface Resolved {
  day: number;
  slice: number;
  real: number; // mapped real unix second
  hour?: ArchiveHour;
}

/** The latest step whose start (day, slice) is at or before (day, slice). */
function current<T extends { from: StepAt }>(steps: readonly T[] | undefined, day: number, slice: number): T | undefined {
  const key = (a: StepAt) => a.day * 1_000_000 + (a.slice ?? 0);
  const now = key({ day, slice });
  let best: T | undefined;
  for (const s of steps ?? []) if (key(s.from) <= now && (!best || key(s.from) >= key(best.from))) best = s;
  return best;
}

const PAGE_STATES = ["ok", "broken", "http-503", "hang", "gzip-raw", "redesigned"];
const GPU_STATES = ["not-rentable", "missing", "garbled"];

/** Refuses a scenario that could not be served exactly as written (a typo must fail at start, not mid-demo). */
export function checkScenario(sc: ReplayScenario): void {
  const at = (a: StepAt, where: string) => {
    if (!a || !Number.isSafeInteger(a.day) || a.day < 0 || (a.slice !== undefined && (!Number.isSafeInteger(a.slice) || a.slice < 0))) {
      throw new Error(`${where}: bad step start ${JSON.stringify(a)}`);
    }
  };
  const source = (id: string, x: ScriptedSource, where: string) => {
    const def = SOURCES.find((d) => d.id === id);
    if (!def) throw new Error(`${where}: unknown source ${id}`);
    for (const [g, steps] of Object.entries(x.gpus ?? {})) {
      if (!def.rules[g as GpuModel]) throw new Error(`${where}: ${id} has no rule for ${g}`);
      for (const st of steps ?? []) {
        at(st.from, `${where} ${id} ${g}`);
        if ((st.price === undefined) === (st.state === undefined)) throw new Error(`${where} ${id} ${g}: give exactly one of price or state`);
        if (st.state !== undefined && !GPU_STATES.includes(st.state)) throw new Error(`${where} ${id} ${g}: bad state ${st.state}`);
        if (st.price !== undefined) parseMicro(st.price);
        if (st.count !== undefined && st.count !== 1 && st.count !== 8) throw new Error(`${where} ${id} ${g}: count must be 1 or 8`);
      }
    }
    for (const st of x.page ?? []) {
      at(st.from, `${where} ${id} page`);
      if (!PAGE_STATES.includes(st.state)) throw new Error(`${where} ${id}: bad page state ${st.state}`);
    }
  };
  for (const [id, x] of Object.entries(sc.scripted ?? {})) source(id, x, "scripted");
  for (const [role, m] of Object.entries(sc.roles ?? {})) {
    if (!/^[a-z0-9-]{1,32}$/.test(role)) throw new Error(`bad role ${role}`);
    for (const [id, x] of Object.entries(m)) source(id, x, `role ${role}`);
  }
  for (const [d, r] of Object.entries(sc.fx ?? {})) {
    if (dayNumber(d) === null) throw new Error(`fx: bad date ${d}`);
    fxMicro({ date: d, usdPerEur: r });
  }
  const tracker = (steps: TrackerStep[] | undefined, where: string) => {
    if (steps !== undefined && !Array.isArray(steps)) throw new Error(`${where}: steps must be a list`);
    for (const st of steps ?? []) {
      at(st.from, where);
      const status = st.status ?? 200;
      if (!Number.isSafeInteger(status) || status < 200 || status > 599) throw new Error(`${where}: bad status ${String(st.status)}`);
      if (status === 200 && (st.body === undefined || JSON.stringify(st.body) === undefined)) throw new Error(`${where}: a 200 step needs a JSON body`);
    }
  };
  const tr = sc.trackers;
  if (tr !== undefined) {
    for (const k of Object.keys(tr)) if (k !== "gputable" && k !== "gpuEconomy") throw new Error(`trackers: unknown tracker ${k}`);
    tracker(tr.gputable, "trackers gputable");
    for (const [f, steps] of Object.entries(tr.gpuEconomy ?? {})) {
      if (!(GPU_ECONOMY_FILES as readonly string[]).includes(f)) throw new Error(`trackers gpuEconomy: unknown file ${f}`);
      tracker(steps, `trackers gpuEconomy ${f}`);
    }
  }
}

export class Replay {
  readonly hours: ArchiveHour[];
  private readonly ids = new Set<string>(SOURCES.map((s) => s.id));
  private readonly rates: Record<string, string>;
  constructor(private readonly o: ReplayOptions) {
    if (!(o.clock.daySec > 0) || !Number.isSafeInteger(o.clock.slices) || o.clock.slices < 1 || !Number.isSafeInteger(o.clock.t0)) throw new Error("bad replay clock");
    if (o.scenario) checkScenario(o.scenario);
    this.hours = o.scenario?.archive === false ? [] : listHours(o.rawDir ?? rawDir());
    this.rates = this.archivedRates();
  }

  resolve(t: number): Resolved {
    const { t0, daySec, slices } = this.o.clock;
    const dt = Math.max(0, t - t0);
    const day = Math.floor(dt / daySec);
    const slice = Math.min(slices - 1, Math.floor((dt % daySec) / (daySec / slices)));
    if (this.hours.length === 0) return { day, slice, real: t };
    const start = this.hours[0]!.startSec;
    const span = this.hours.at(-1)!.startSec + 3600 - start;
    const real = start + (Math.floor((dt * 86_400) / daySec) % span);
    let hour = this.hours[0]!;
    for (const h of this.hours) if (h.startSec <= real) hour = h;
    return { day, slice, real, hour };
  }

  private script(id: string, role: string | undefined): ScriptedSource | undefined {
    return (role ? this.o.scenario?.roles?.[role]?.[id] : undefined) ?? this.o.scenario?.scripted?.[id];
  }

  private archivedRates(): Record<string, string> {
    const rates: Record<string, string> = {};
    for (const h of this.hours) {
      const body = readArchived(h, ECB.id);
      if (!body) continue;
      for (const d of elements(body, /<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']\s*>/g, "</Cube>")) {
        const usd = /<Cube\s+currency=["']USD["']\s+rate=["']([0-9.]+)["']/.exec(d.inner);
        if (usd) rates[d.open[1]!] = usd[1]!;
      }
    }
    return { ...rates, ...(this.o.scenario?.fx ?? {}) };
  }

  /** The page a source shows at t to role, as a Response. */
  async answer(id: string, t: number, role?: string): Promise<Response> {
    const r = this.resolve(t);
    const headers: Record<string, string> = { "x-agate-demo": `${r.day}/${r.slice}`, "content-type": "text/plain; charset=utf-8" };
    if (id === ECB.id) {
      headers["x-agate-page-time"] = String(Math.floor(r.real));
      headers["content-type"] = "text/xml";
      return new Response(renderEcb(this.rates), { headers });
    }
    if (!this.ids.has(id)) return new Response("unknown source", { status: 404, headers });
    const sc = this.script(id, role);
    const pageStep = current(sc?.page, r.day, r.slice);
    const pageTime = r.hour ? pageTimeOf(r.hour, id, this.o.rawDir ?? rawDir()) : Math.floor(r.real);
    headers["x-agate-page-time"] = String(pageTime);
    if (r.hour) headers["x-agate-hour"] = `${r.hour.date}T${r.hour.hour}`;
    if (pageStep?.state === "http-503") return new Response("scripted outage", { status: 503, headers });
    if (pageStep?.state === "hang") {
      await Bun.sleep(this.o.hangMs ?? 600_000);
      return new Response("late", { status: 504, headers });
    }
    const gpuSteps = Object.fromEntries(
      Object.entries(sc?.gpus ?? {})
        .map(([g, steps]) => [g, current(steps, r.day, r.slice)])
        .filter(([, s]) => s !== undefined),
    ) as Partial<Record<GpuModel, GpuStep>>;
    const archived = r.hour ? readArchived(r.hour, id) : null;
    const scripted = Object.keys(gpuSteps).length > 0 || (pageStep !== undefined && pageStep.state !== "ok");
    let body: string;
    if (!scripted) {
      if (archived === null) return new Response("no archived page for this hour", { status: 404, headers });
      body = archived;
    } else {
      const base: SynthPage = archived !== null ? this.synthOf(id, archived, pageTime) : {};
      for (const [g, s] of Object.entries(gpuSteps) as [GpuModel, GpuStep][]) {
        base[g] = s.state ? { state: s.state } : { price: s.price!, count: s.count ?? 8 };
      }
      body = renderPage(id, base, { broken: pageStep?.state === "broken", redesigned: pageStep?.state === "redesigned" });
      headers["x-agate-scripted"] = "1";
    }
    if (pageStep?.state === "gzip-raw") {
      const { gzipSync } = await import("node:zlib");
      return new Response(gzipSync(body), { headers }); // compressed bytes without Content-Encoding
    }
    headers["content-type"] = body.startsWith("[") || body.startsWith("{") ? "application/json" : "text/html; charset=utf-8";
    return new Response(body, { headers });
  }

  /** A tracker file at t: GPUTable's (`file` undefined) or one GPU Economy file. Scripted steps win; GPUTable falls
   * back to the archived hour; anything else is 404. */
  tracker(name: string, file: string | undefined, t: number): Response {
    const r = this.resolve(t);
    const headers: Record<string, string> = { "x-agate-demo": `${r.day}/${r.slice}`, "x-agate-page-time": String(Math.floor(r.real)), "content-type": "application/json" };
    if (r.hour) headers["x-agate-hour"] = `${r.hour.date}T${r.hour.hour}`;
    const tr = this.o.scenario?.trackers;
    let steps: TrackerStep[] | undefined;
    if (name === "t_gputable" && file === undefined) steps = tr?.gputable;
    else if (name === "t_gpu_economy" && file !== undefined && (GPU_ECONOMY_FILES as readonly string[]).includes(file)) steps = tr?.gpuEconomy?.[file as GpuEconomyFile];
    else return new Response("unknown tracker file", { status: 404, headers });
    const step = current(steps, r.day, r.slice);
    if (step) {
      headers["x-agate-scripted"] = "1";
      const status = step.status ?? 200;
      if (status !== 200) return new Response("scripted tracker outage", { status, headers });
      return new Response(JSON.stringify(step.body), { headers });
    }
    if (name === "t_gputable" && r.hour) {
      const archived = readArchived(r.hour, "t_gputable");
      if (archived !== null) {
        headers["x-agate-page-time"] = String(pageTimeOf(r.hour, "t_gputable", this.o.rawDir ?? rawDir()));
        const adjusted = this.followScriptedPrices(archived, r.day, r.slice);
        if (adjusted !== archived) headers["x-agate-scripted"] = "1";
        return new Response(adjusted, { headers });
      }
    }
    return new Response("no tracker file for this hour", { status: 404, headers });
  }

  /** The archived GPUTable file with every scripted price step in force applied to the mapped provider's on-demand
   *  rows of that GPU (7.9 item 4): a scripted page step is a price change the trackers show too, so the
   *  demo's step raises no false "likely parser fault". The real-calendar index never reads the replay. */
  followScriptedPrices(archived: string, day: number, slice: number): string {
    const changes: { provider: string; gpu: string; price: number }[] = [];
    for (const [id, x] of Object.entries(this.o.scenario?.scripted ?? {})) {
      const provider = GPUTABLE_PROVIDER[id];
      if (!provider) continue;
      for (const [g, steps] of Object.entries(x.gpus ?? {}) as [GpuModel, GpuStep[]][]) {
        const st = current(steps, day, slice);
        if (st?.price !== undefined && st.state === undefined) changes.push({ provider, gpu: GPUTABLE_GPU[g], price: Number(st.price) });
      }
    }
    if (changes.length === 0) return archived;
    let j: { data?: unknown };
    try {
      j = JSON.parse(archived) as { data?: unknown };
    } catch {
      return archived;
    }
    if (!Array.isArray(j.data)) return archived;
    for (const row of j.data as Record<string, unknown>[]) {
      const c = changes.find((x) => row && row.provider === x.provider && row.gpu === x.gpu && row.pricing_type === "on_demand" && row.commitment_months === null);
      if (c) row.price_per_hour_usd = c.price;
    }
    return JSON.stringify(j);
  }

  /** The archived page's own rows as synthetic cells, so a scripted step changes one GPU and keeps the others. */
  private synthOf(id: string, page: string, pageTime: number): SynthPage {
    const utcDate = new Date(pageTime * 1000).toISOString().slice(0, 10);
    const fx: FxRate | null = parseEcb(renderEcb(this.rates), utcDate);
    const rows = parse(id, page, { utcDate, nowSec: pageTime, ...(fx ? { fx } : {}) });
    const out: SynthPage = {};
    for (const [g, row] of Object.entries(rows) as [GpuModel, NonNullable<(typeof rows)[GpuModel]>][]) {
      const keep = row.raw !== undefined && row.gpuCount !== undefined && (row.state === "VALID" || reasonOf(row) === "no-fx");
      const cell: SynthGpu = keep ? { instance: row.raw!, count: row.gpuCount! } : row.state === "NOT_RENTABLE" ? { state: "not-rentable" } : { state: "missing" };
      out[g] = cell;
    }
    return out;
  }
}

/** Starts the replay server. GET /<sourceId>, /fx_ecb, /r/<role>/<sourceId>, /t_gputable, /t_gpu_economy/<file>
 * (also under /r/<role>/); GET /_at returns the clock mapping. */
export function startReplay(o: ReplayOptions): { url: string; port: number; replay: Replay; stop: () => void } {
  const replay = new Replay(o);
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const server = Bun.serve({
    port: o.port ?? 0,
    hostname: o.hostname ?? "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const clock = req.headers.get("x-agate-clock");
      const t = clock && /^\d{9,11}$/.test(clock) ? Number(clock) : now();
      let parts = url.pathname.split("/").filter(Boolean);
      let role = req.headers.get("x-agate-role") ?? undefined;
      if (parts[0] === "r" && parts.length >= 3) {
        role = parts[1];
        parts = parts.slice(2);
      }
      if (parts.length === 1 && parts[0] === "_at") return Response.json(replay.resolve(t));
      if (parts[0] === "t_gputable" || parts[0] === "t_gpu_economy") {
        if (parts.length > 2) return new Response("not found", { status: 404 });
        return replay.tracker(parts[0], parts[1], t);
      }
      if (parts.length !== 1) return new Response("not found", { status: 404 });
      return replay.answer(parts[0]!, t, role);
    },
  });
  return { url: `http://${server.hostname}:${server.port}`, port: server.port!, replay, stop: () => server.stop(true) };
}
