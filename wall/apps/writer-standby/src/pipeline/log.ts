// The writer's local log: ~/.agate-wall/<role>/readings/<UTC date>.jsonl (8.1 step 1). A reading line is written
// before the chain is checked; reposts and the launch backfill read entries back from it. The same files carry the
// transaction journal (signed bytes written before each broadcast), abandoned entries and skipped slices, so the
// chain plus this log are a writer's whole state.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Address, Entry, Hex } from "@agate/report/types";
import { type Clock, dayEnd, dayStart, type EntryJson, entryFromJson, type SourceLog, utcDate } from "../core/index.ts";
import type { TxJournal, TxLine } from "./sender.ts";

export type Role = "primary" | "standby";

export interface ReadingLine {
  kind: "reading";
  index: Address;
  role: Role;
  dayId: number;
  slice: number;
  readAt: number;
  entries: EntryJson[];
  sources: SourceLog[];
  via: "cre" | "direct";
  txHash?: Hex;
  ms?: number; // how long the reading (or the whole CRE simulate run) took
  error?: string;
}

export interface SendLine {
  kind: "send";
  index: Address;
  role: Role;
  at: number;
  action: "post" | "repost" | "close" | "backfill";
  dayId: number;
  slice?: number;
  gpuIds: Hex[];
  ok: boolean;
  sent: boolean;
  pending?: boolean;
  txHash?: Hex;
  nonce?: number;
  gasLimit?: string;
  gasUsed?: string;
  error?: string;
}

/** A logged entry whose slice bit was still missing when its send window (F1) closed: never sent again. */
export interface AbandonLine {
  kind: "abandon";
  index: Address;
  role: Role;
  at: number;
  dayId: number;
  slice: number;
  gpuIds: Hex[];
  reason: string;
}

/** A slice not read: the process woke or started after the slice's read window (8.1 step 5). */
export interface SkipLine {
  kind: "skip";
  index: Address;
  role: Role;
  at: number;
  dayId: number;
  slice: number;
  reason: string;
}

export interface WakeLine {
  kind: "wake";
  index: Address;
  role: Role;
  at: number;
  slept: number | null; // null: a fresh start
}

export type LogLine = ReadingLine | SendLine | TxLine | AbandonLine | SkipLine | WakeLine;

export function wallHome(): string {
  return process.env.AGATE_WALL_HOME || join(homedir(), ".agate-wall");
}

function timeOf(l: LogLine): number {
  return l.kind === "reading" ? l.readAt : l.at;
}

export class ReadingLog implements TxJournal {
  readonly dir: string;
  constructor(
    home: string,
    readonly role: Role,
    private readonly wallNow: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.dir = join(home, role, "readings");
    mkdirSync(this.dir, { recursive: true });
  }

  append(line: LogLine): void {
    appendFileSync(join(this.dir, `${utcDate(timeOf(line))}.jsonl`), `${JSON.stringify(line)}\n`);
  }

  private *lines(from: number, to: number): Generator<LogLine> {
    for (let day = Math.floor(from / 86_400); day * 86_400 < to; day++) {
      const f = join(this.dir, `${utcDate(day * 86_400)}.jsonl`);
      if (!existsSync(f)) continue;
      for (const raw of readFileSync(f, "utf8").split("\n")) {
        if (!raw) continue;
        try {
          yield JSON.parse(raw) as LogLine;
        } catch {
          // a torn last line after a crash
        }
      }
    }
  }

  /** Reading lines of one index whose readAt falls in [from, to), oldest first. */
  readings(index: Address, from: number, to: number): ReadingLine[] {
    const out: ReadingLine[] = [];
    for (const l of this.lines(from, to)) {
      if (l.kind === "reading" && l.index.toLowerCase() === index.toLowerCase() && l.readAt >= from && l.readAt < to) out.push(l);
    }
    return out;
  }

  /** The logged entries of one index day: slice -> gpuId -> the first entry logged for it. */
  entriesOf(index: Address, c: Clock, d: number): Map<number, Map<Hex, Entry>> {
    const out = new Map<number, Map<Hex, Entry>>();
    for (const l of this.readings(index, dayStart(c, d), dayEnd(c, d))) {
      for (const e of l.entries) {
        if (e.dayId !== d) continue;
        const m = out.get(e.slice) ?? new Map<Hex, Entry>();
        if (!m.has(e.gpuId)) m.set(e.gpuId, entryFromJson(e));
        out.set(e.slice, m);
      }
    }
    return out;
  }

  /** TxJournal: this key's journaled transactions of the last two UTC days (by the wall clock), oldest first. */
  recent(from: Address): TxLine[] {
    const now = this.wallNow();
    const out: TxLine[] = [];
    for (const l of this.lines(now - 2 * 86_400, now + 86_400)) {
      if (l.kind === "tx" && l.from.toLowerCase() === from.toLowerCase()) out.push(l);
    }
    return out;
  }
}
