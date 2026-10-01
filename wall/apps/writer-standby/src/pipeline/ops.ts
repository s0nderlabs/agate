// Alerts (BUILD-SPEC 9.4: ~/.agate-wall/alerts/alerts.jsonl, type Alert) and the heartbeat file (13.4).
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Alert } from "@agate/report/types";
import type { AlertFn, AlertInput } from "./rpc.ts";

export function alertId(a: AlertInput): string {
  return `${a.code}:${a.gpuId ?? "-"}:${a.day ?? "-"}:${a.slot ?? "-"}:${a.writer ?? "-"}`;
}

/** Appends every alert to <home>/alerts/alerts.jsonl (one line, one write: atomic for concurrent appenders) and
 * prints it. A repeated condition keeps its id, so readers take the newest line per id. */
export function alertSink(o: { home: string; writer: Address; now?: () => number; print?: (line: string) => void }): AlertFn {
  const dir = join(o.home, "alerts");
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const print = o.print ?? ((l: string) => console.log(l));
  return (a) => {
    const full: Alert = { ...a, writer: a.writer ?? o.writer, id: alertId({ ...a, writer: a.writer ?? o.writer }), at: now() };
    const line = JSON.stringify(full);
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "alerts.jsonl"), `${line}\n`);
    } catch (e) {
      print(JSON.stringify({ event: "alert_write_failed", error: e instanceof Error ? e.message : String(e) }));
    }
    print(JSON.stringify({ event: "alert", ...full }));
  };
}

export interface Heartbeat {
  pid: number;
  role: string;
  index: Address;
  at: number;
  tick: number;
  lastAction: string;
}

/** Writes <dir>/heartbeat.json (temp file, then rename: a reader never sees half a file). */
export function writeHeartbeat(dir: string, hb: Heartbeat, extraName?: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ["heartbeat.json", ...(extraName ? [extraName] : [])]) {
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(hb)}\n`);
    renameSync(tmp, join(dir, name));
  }
}
