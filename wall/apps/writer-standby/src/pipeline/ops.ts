// Alerts (BUILD-SPEC 9.4: ~/.agate-wall/alerts/alerts.jsonl, type Alert) and the heartbeat file (13.4).
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "@agate/report/env";
import type { Address, Alert } from "@agate/report/types";
import type { AlertFn, AlertInput } from "./rpc.ts";

export function alertId(a: AlertInput & { index?: string }): string {
  const id = `${a.code}:${a.gpuId ?? "-"}:${a.day ?? "-"}:${a.slot ?? "-"}:${a.writer ?? "-"}`;
  return a.index ? `${id}@${a.index.toLowerCase()}` : id;
}

/** Appends every alert to <home>/alerts/alerts.jsonl (one line, one write: atomic for concurrent appenders) and
 * prints it. A repeated condition keeps its id, so readers take the newest line per id. With `index` (13.7, 9.4) the
 * alert and its id carry the index, as the watcher's do (two indexes share the file and the gpuIds); with `scrub`
 * (13.6) the serialized alert passes through it before it is written or printed. */
/** Runs AGATE_NOTIFY_CMD with one alert's JSON on stdin; PATH and HOME are its whole environment (no key, no URL). */
export function runNotify(cmd: string, json: string): void {
  try {
    const p = Bun.spawn(["/bin/sh", "-c", cmd], { env: childEnv(), stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    p.stdin.write(json);
    p.stdin.end();
  } catch {
    // a broken notifier never stops the writer; the alert is in the file and on stdout
  }
}

export function alertSink(o: { home: string; writer: Address; now?: () => number; print?: (line: string) => void; index?: Address; scrub?: (s: string) => string; notifyCmd?: string; notify?: (cmd: string, json: string) => void }): AlertFn {
  const dir = join(o.home, "alerts");
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const print = o.print ?? ((l: string) => console.log(l));
  const scrub = o.scrub ?? ((x: string) => x);
  const index = o.index?.toLowerCase();
  // 13.4 (fix round M2): every action alert a writer raises (KEY_MISMATCH above all) reaches the operator's phone, once
  // per alert id per process, like the watcher's AlertSink
  const notified = new Set<string>();
  const notify = o.notify ?? runNotify;
  return (a) => {
    const writer = a.writer ?? o.writer;
    const full: Alert & { index?: string } = { ...a, writer, id: alertId({ ...a, writer, ...(index ? { index } : {}) }), at: now(), ...(index ? { index } : {}) };
    const line = scrub(JSON.stringify(full, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "alerts.jsonl"), `${line}\n`);
    } catch (e) {
      print(scrub(JSON.stringify({ event: "alert_write_failed", error: e instanceof Error ? e.message : String(e) })));
    }
    print(`{"event":"alert",${line.slice(1)}`);
    if (o.notifyCmd && a.severity === "action" && !notified.has(full.id)) {
      notified.add(full.id);
      notify(o.notifyCmd, line);
    }
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
