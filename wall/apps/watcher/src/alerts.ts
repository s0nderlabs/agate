// Alerts (BUILD-SPEC 9.4): one JSONL file shared by every process, ids stable so a repeated condition updates the
// open alert instead of duplicating it. Also printed to stdout; an optional notifier command per new action alert.
// Every index's processes share the file (one AGATE_WALL_HOME, same gpuIds), so a sink given its index stamps it on
// its alerts and ids, sees only its own index's alerts and unscoped ones (the writers'), and clears only its own.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { childEnv } from "@agate/report/env";
import type { Alert, AlertCode, Address, Hex } from "@agate/report/types";
import { appendLine, scrubText } from "./fsutil.ts";

export interface StoredAlert extends Alert {
  /** the index whose process raised it (lowercase); absent: unscoped (a writer, a logger started before the index) */
  index?: string;
  cleared?: number;
  updated?: number;
}

export interface RaiseInput {
  code: AlertCode | string;
  severity: "info" | "action";
  gpuId?: Hex;
  day?: number;
  slot?: number;
  writer?: Address;
  deadline?: number;
  message: string;
  data?: unknown;
  /** one alert per owner action or reader swap id (9.4, 8.6): two entries of one slot never share an alert */
  key?: string;
}

export function alertId(a: { code: string; gpuId?: string; day?: number; slot?: number; writer?: string; index?: string; key?: string }): string {
  const id = `${a.code}:${a.gpuId ?? "-"}:${a.day ?? "-"}:${a.slot ?? "-"}:${a.writer?.toLowerCase() ?? "-"}${a.key ? `:${a.key.toLowerCase()}` : ""}`;
  return a.index ? `${id}@${a.index.toLowerCase()}` : id;
}

export interface AlertSinkOptions {
  now: () => number;
  print?: boolean;
  /** Shell command run once per new action alert, with the alert JSON on stdin (AGATE_NOTIFY_CMD). */
  notifyCmd?: string;
  role?: string;
  /** The index this process serves (AGATE_INDEX): scopes what it raises, reads and clears. */
  index?: string;
}

/** Line breaks and tabs become spaces, every other C0 or C1 control and DEL becomes "?". */
export function oneLine(s: string): string {
  return s.replace(/\r\n|[\n\r\t\u2028\u2029]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

/** The notifier's whole environment. */
export function notifyEnv(): Record<string, string> {
  return childEnv();
}

export class AlertSink {
  private readonly byId = new Map<string, StoredAlert>();
  private offset = 0;
  private tail = "";
  readonly raised: StoredAlert[] = []; // every new or changed alert this process wrote (tests read it)

  constructor(
    readonly path: string | null,
    readonly o: AlertSinkOptions,
  ) {
    this.reload();
  }

  /** Fold lines other processes appended (the newest line of an id wins). */
  reload(): void {
    if (!this.path || !existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size <= this.offset) return;
    const fd = openSync(this.path, "r");
    const buf = Buffer.alloc(size - this.offset);
    readSync(fd, buf, 0, buf.length, this.offset);
    closeSync(fd);
    this.offset = size;
    const parts = (this.tail + buf.toString("utf8")).split("\n");
    this.tail = parts.pop() ?? "";
    for (const ln of parts) {
      if (!ln.trim()) continue;
      try {
        const a = JSON.parse(ln) as StoredAlert;
        this.byId.set(a.id, a);
      } catch {
        // skip a corrupt line
      }
    }
  }

  private write(a: StoredAlert): void {
    this.byId.set(a.id, a);
    this.raised.push(a);
    if (this.path) {
      appendLine(this.path, a);
      this.offset = existsSync(this.path) ? statSync(this.path).size : this.offset;
    }
  }

  private get scope(): string | undefined {
    return this.o.index?.toLowerCase();
  }

  /** Its own index's alerts and unscoped ones (every alert for a sink without an index). */
  private sees(a: StoredAlert): boolean {
    return !this.scope || a.index === undefined || a.index === this.scope;
  }

  raise(x: RaiseInput): StoredAlert {
    this.reload();
    const scope = this.scope;
    const id = alertId({ ...x, ...(scope ? { index: scope } : {}) });
    const now = this.o.now();
    const old = this.byId.get(id);
    const open = old && old.cleared === undefined ? old : undefined;
    const deadline = open?.deadline !== undefined && x.deadline !== undefined ? Math.min(open.deadline, x.deadline) : (x.deadline ?? open?.deadline);
    // 13.6: an alert never carries a configured RPC URL (message and data are scrubbed before they are stored)
    // one printable line: a chain string in a message (a swap's url or reason) can carry no terminal escape (M1)
    const a: StoredAlert = { id, code: x.code as AlertCode, severity: x.severity, at: open ? open.at : now, message: scrubText(oneLine(x.message)) };
    if (scope) a.index = scope;
    if (x.gpuId) a.gpuId = x.gpuId;
    if (x.day !== undefined) a.day = x.day;
    if (x.slot !== undefined) a.slot = x.slot;
    if (x.writer) a.writer = x.writer;
    if (deadline !== undefined && Number.isFinite(deadline)) a.deadline = deadline;
    if (x.data !== undefined) a.data = JSON.parse(scrubText(JSON.stringify(x.data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))) as unknown;
    if (open && open.severity === a.severity && open.message === a.message && open.deadline === a.deadline) return open;
    if (open) a.updated = now;
    this.write(a);
    if (this.o.print !== false) console.log(JSON.stringify({ t: now, role: this.o.role, alert: a }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    if (!open && a.severity === "action" && this.o.notifyCmd) this.notify(a);
    return a;
  }

  clear(id: string): void {
    this.reload();
    const old = this.byId.get(id);
    if (!old || old.cleared !== undefined) return;
    this.write({ ...old, cleared: this.o.now() });
  }

  /** Clears matching open alerts; a sink with an index only those its index raised (never another's, never a writer's). */
  clearWhere(pred: (a: StoredAlert) => boolean): void {
    for (const a of this.open()) if ((!this.scope || a.index === this.scope) && pred(a)) this.clear(a.id);
  }

  open(): StoredAlert[] {
    return this.all().filter((a) => a.cleared === undefined);
  }

  all(): StoredAlert[] {
    this.reload();
    return [...this.byId.values()].filter((a) => this.sees(a));
  }

  get(id: string): StoredAlert | undefined {
    this.reload();
    return this.byId.get(id);
  }

  private notify(a: StoredAlert): void {
    try {
      // PATH and HOME only: a role key or an RPC URL in this process's environment never reaches the notifier (M3)
      const p = Bun.spawn(["/bin/sh", "-c", this.o.notifyCmd!], { env: notifyEnv(), stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      p.stdin.write(JSON.stringify(a));
      p.stdin.end();
    } catch {
      // a broken notifier never stops the process; the alert is already in the file and on stdout
    }
  }
}
