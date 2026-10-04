// The Alchemy compute-unit meter (Oct 4). Since Oct 4 Alchemy serves the light roles only: each sender's own
// transactions (the send: endpoints of env.ts) and the attester's and the keeper's websocket. Every process that has
// either counts what it sends there (method by method; on a websocket the eth_subscribe calls and the bytes of each
// notification), converts it with Alchemy's price list (a method not in it: 26 CU; a notification: 0.04 CU a byte) and
// writes the day's counts to <wall home>/rpc-meter/<YYYY-MM-DD UTC>/<role>-<index8 or market>.json (atomic, at most
// every 60 s; a restart the same day carries on from its file). Every 60 s it also sums every file of the day against
// AGATE_ALCHEMY_DAILY_CU (default 400,000: the 10.9M CU left to Oct 31 over the days left): at 80% one ALCHEMY_BUDGET
// info alert, at 100% one action alert (one per threshold and day, whichever process gets there first), and from then
// every process leaves its send endpoints and its websocket alone until 00:00 UTC (the read endpoints take the sends,
// polling takes the wake-ups). The next UTC day starts from zero and the endpoints come back.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Alchemy's compute units per call (its price list, Oct 4 2026). Checked against a bill: the read prices (eth_getLogs
 *  60, eth_call and eth_getBlockByNumber 20, eth_blockNumber 10) match what the Alchemy dashboard showed for Oct 4. Not
 *  checked against a bill (no Alchemy call was allowed while this was built): the send path (eth_estimateGas,
 *  eth_getTransactionCount and eth_getTransactionReceipt 20, eth_sendRawTransaction 40) and WS_CU_PER_BYTE, which is
 *  about 70% of the light roles' spend. The RUNBOOK ("Alchemy", the first day) compares a day's meter total with the
 *  dashboard's figure for that UTC day; when the dashboard reads higher, AGATE_ALCHEMY_DAILY_CU is lowered in
 *  proportion (budget x meter total / dashboard total), so the stop still comes before the real spend passes it. */
export const ALCHEMY_CU: Readonly<Record<string, number>> = {
  eth_chainId: 0,
  eth_blockNumber: 10,
  eth_feeHistory: 10,
  eth_subscribe: 10,
  eth_call: 20,
  eth_getBlockByNumber: 20,
  eth_getTransactionReceipt: 20,
  eth_getTransactionCount: 20,
  eth_estimateGas: 20,
  eth_gasPrice: 20,
  eth_sendRawTransaction: 40,
  eth_getLogs: 60,
};
/** A method the list does not name. */
export const UNKNOWN_CU = 26;
/** A websocket subscription event, per byte (Alchemy's list; not yet checked against a bill: see ALCHEMY_CU). */
export const WS_CU_PER_BYTE = 0.04;
export const DEFAULT_DAILY_CU = 400_000;
/** How often a process writes its counts and sums the day's files. */
export const METER_PERIOD_MS = 60_000;
const DAILY = "AGATE_ALCHEMY_DAILY_CU";

export interface MeterCounts {
  /** calls by JSON-RPC method (eth_subscribe included) */
  methods: Record<string, number>;
  /** bytes of websocket subscription events */
  wsBytes: number;
}

/** One process's file of one UTC day. */
export interface MeterFile extends MeterCounts {
  date: string;
  role: string;
  scope: string;
  cu: number;
  /** unix s of the write */
  at: number;
}

export function cuOfMethod(method: string): number {
  return Object.hasOwn(ALCHEMY_CU, method) ? ALCHEMY_CU[method]! : UNKNOWN_CU;
}

/** Compute units of a set of counts, rounded up to a whole unit. */
export function cuOf(c: MeterCounts): number {
  let cu = 0;
  for (const [m, n] of Object.entries(c.methods)) cu += n * cuOfMethod(m);
  const x = cu + c.wsBytes * WS_CU_PER_BYTE;
  return x <= 0 ? 0 : Math.ceil(x - 1e-9);
}

/** "2026-10-04" for a time in ms. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function meterDir(home: string, date: string): string {
  return join(home, "rpc-meter", date);
}

/** AGATE_ALCHEMY_DAILY_CU: a whole number of compute units above 0 (default 400,000). */
export function dailyCuFromEnv(env: Record<string, string | undefined>): number {
  const v = env[DAILY];
  if (v === undefined || v.trim() === "") return DEFAULT_DAILY_CU;
  if (!/^\d+$/.test(v.trim()) || Number(v) <= 0 || !Number.isSafeInteger(Number(v))) throw new Error(`${DAILY} must be a whole number of compute units above 0`);
  return Number(v);
}

const FILE = /^[A-Za-z0-9_.-]+\.json$/;

function readMeterFile(path: string): MeterFile | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Partial<MeterFile>;
    if (typeof j !== "object" || j === null) return null;
    const methods: Record<string, number> = {};
    for (const [m, n] of Object.entries(j.methods ?? {})) if (typeof n === "number" && Number.isFinite(n) && n >= 0) methods[m] = n;
    const wsBytes = typeof j.wsBytes === "number" && Number.isFinite(j.wsBytes) && j.wsBytes >= 0 ? j.wsBytes : 0;
    return { date: String(j.date ?? ""), role: String(j.role ?? ""), scope: String(j.scope ?? ""), methods, wsBytes, cu: cuOf({ methods, wsBytes }), at: Number(j.at ?? 0) };
  } catch {
    return null;
  }
}

/** Every process's compute units of one UTC day, by file name (<role>-<scope>.json), and their total. */
export function meterDay(home: string, date: string): { total: number; files: { name: string; cu: number }[] } {
  const dir = meterDir(home, date);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => FILE.test(f)).sort();
  } catch {
    return { total: 0, files: [] };
  }
  const files: { name: string; cu: number }[] = [];
  for (const name of names) {
    const f = readMeterFile(join(dir, name));
    if (f) files.push({ name, cu: f.cu });
  }
  return { total: files.reduce((s, f) => s + f.cu, 0), files };
}

export interface MeterAlert {
  severity: "info" | "action";
  message: string;
  /** the UTC day (YYYY-MM-DD) and its day number since 1970 */
  date: string;
  day: number;
  threshold: 80 | 100;
}

export interface RpcMeterOptions {
  home: string;
  /** the process's role: attest, keep, primary, standby, marketmaker, payer, ... */
  role: string;
  /** index8 (the first 8 hex digits of the index) or "market" */
  scope: string;
  dailyCu?: number;
  nowMs?: () => number;
  /** raises ALCHEMY_BUDGET in the process's alert sink */
  alert?: (a: MeterAlert) => void;
  /** clears the ALCHEMY_BUDGET alerts of the days before `day` (a new UTC day: that stop is over) */
  clearBefore?: (day: number) => void;
  say?: (event: string, data: Record<string, unknown>) => void;
}

const empty = (): MeterCounts => ({ methods: {}, wsBytes: 0 });

export class RpcMeter {
  private date: string;
  private counts: MeterCounts;
  private dirty = false;
  private lastFlush = -Infinity;
  private lastSum = -Infinity;
  private dayTotal = 0;
  private stopped = false;
  private said = new Set<number>();
  readonly dailyCu: number;

  constructor(readonly o: RpcMeterOptions) {
    if (!/^[A-Za-z0-9_.-]+$/.test(o.role) || !/^[A-Za-z0-9_.-]+$/.test(o.scope)) throw new Error("the meter's role and scope are letters, digits, dots, dashes and underscores");
    this.dailyCu = o.dailyCu ?? DEFAULT_DAILY_CU;
    this.date = utcDate(this.now());
    this.counts = this.load();
  }

  private now(): number {
    return this.o.nowMs ? this.o.nowMs() : Date.now();
  }

  get file(): string {
    return join(meterDir(this.o.home, this.date), `${this.o.role}-${this.o.scope}.json`);
  }

  /** The file this process wrote earlier today (a restart carries on from it), else nothing. */
  private load(): MeterCounts {
    const f = readMeterFile(this.file);
    return f && f.date === this.date ? { methods: { ...f.methods }, wsBytes: f.wsBytes } : empty();
  }

  /** A new UTC day: the old day's counts are written, the counts start again and the endpoints come back. */
  private roll(): void {
    const d = utcDate(this.now());
    if (d === this.date) return;
    this.flush(true);
    this.date = d;
    this.counts = this.load();
    this.dirty = false;
    this.lastSum = -Infinity;
    this.dayTotal = 0;
    if (this.stopped) this.o.say?.("alchemy_budget_resumed", { date: d });
    this.stopped = false;
    this.said.clear();
    this.o.clearBefore?.(Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000));
  }

  /** One call to a send endpoint or the websocket (eth_subscribe). */
  count(method: string, n = 1): void {
    this.roll();
    this.counts.methods[method] = (this.counts.methods[method] ?? 0) + n;
    this.dirty = true;
    this.tick();
  }

  /** One websocket subscription event of `bytes` bytes. */
  wsEvent(bytes: number): void {
    this.roll();
    this.counts.wsBytes += Math.max(0, bytes);
    this.dirty = true;
    this.tick();
  }

  /** May this process use its send endpoints and its websocket now (false from 100% of the day's budget to 00:00 UTC). */
  allowed(): boolean {
    this.tick();
    return !this.stopped;
  }

  /** At most every 60 s: the counts written and the day's files summed (force: both now). */
  tick(force = false): void {
    this.roll();
    const t = this.now();
    if (force || t - this.lastFlush >= METER_PERIOD_MS) this.flush();
    if (force || t - this.lastSum >= METER_PERIOD_MS) this.check();
  }

  /** This process's compute units today. */
  ownCu(): number {
    return cuOf(this.counts);
  }

  /** The day's total at the last sum (every process). */
  get total(): number {
    return this.dayTotal;
  }

  get budgetStopped(): boolean {
    return this.stopped;
  }

  snapshot(): { date: string; methods: Record<string, number>; wsBytes: number; cu: number; total: number; dailyCu: number; stopped: boolean } {
    return { date: this.date, methods: { ...this.counts.methods }, wsBytes: this.counts.wsBytes, cu: this.ownCu(), total: this.dayTotal, dailyCu: this.dailyCu, stopped: this.stopped };
  }

  /** Writes the day's counts (temp file, then rename), when they changed since the last write. */
  flush(force = false): void {
    this.lastFlush = this.now();
    if (!this.dirty && !force) return;
    if (!this.dirty && Object.keys(this.counts.methods).length === 0 && this.counts.wsBytes === 0) return;
    const body: MeterFile = { date: this.date, role: this.o.role, scope: this.o.scope, methods: this.counts.methods, wsBytes: this.counts.wsBytes, cu: this.ownCu(), at: Math.floor(this.now() / 1000) };
    try {
      mkdirSync(meterDir(this.o.home, this.date), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body)}\n`);
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      this.o.say?.("rpc_meter_write_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** The day's total (the other processes' files and this process's own counts) against the budget. */
  private check(): void {
    this.lastSum = this.now();
    const own = `${this.o.role}-${this.o.scope}.json`;
    const others = meterDay(this.o.home, this.date).files.filter((f) => f.name !== own);
    this.dayTotal = others.reduce((s, f) => s + f.cu, 0) + this.ownCu();
    const pct = (100 * this.dayTotal) / this.dailyCu;
    if (pct >= 80) this.crossed(80);
    if (pct >= 100) {
      this.crossed(100);
      this.stopped = true;
    }
  }

  /** Once per threshold, day and process: a log line; once per threshold and day across processes: the alert. */
  private crossed(t: 80 | 100): void {
    if (this.said.has(t)) return;
    this.said.add(t);
    const data = { date: this.date, total: this.dayTotal, dailyCu: this.dailyCu, threshold: t };
    this.o.say?.(t === 100 ? "alchemy_budget_stop" : "alchemy_budget_80", data);
    if (!this.claim(t)) return;
    const budget = this.dailyCu.toLocaleString("en-US");
    const message =
      t === 100
        ? `Alchemy compute units of ${this.date} (UTC) reached AGATE_ALCHEMY_DAILY_CU (${budget}): every process sends through its read endpoints and polls without the websocket until 00:00 UTC`
        : `Alchemy compute units of ${this.date} (UTC) passed 80% of AGATE_ALCHEMY_DAILY_CU (${budget}); at 100% every process stops using Alchemy until 00:00 UTC`;
    this.o.alert?.({ severity: t === 100 ? "action" : "info", message, date: this.date, day: Math.floor(Date.parse(`${this.date}T00:00:00Z`) / 86_400_000), threshold: t });
  }

  /** The first process to cross a threshold today raises its alert: an exclusively created marker file decides. */
  private claim(t: 80 | 100): boolean {
    try {
      mkdirSync(meterDir(this.o.home, this.date), { recursive: true });
      const fd = openSync(join(meterDir(this.o.home, this.date), `.alert-${t}`), "wx");
      writeSync(fd, `${this.o.role}-${this.o.scope} ${Math.floor(this.now() / 1000)}\n`);
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }

  /** In a long-running process: a tick every 60 s (unref: it never holds the process) and a last write at exit.
   *  Returns the stop function. */
  start(): () => void {
    const timer = setInterval(() => this.tick(), METER_PERIOD_MS);
    (timer as { unref?: () => void }).unref?.();
    const last = () => this.flush();
    process.on("exit", last);
    return () => {
      clearInterval(timer);
      process.off("exit", last);
      this.flush();
    };
  }
}
