// The guardian's own log (BUILD-SPEC 10): looks, hand signatures (R11, R12) and R8 memos, under
// <home>/guardian/. The CLI writes it; the attester and the CLI read it (vouched anchors, hand ranges, R8).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, GpuModel, Hex, ReadState } from "@agate/report/types";
import { appendLine } from "./fsutil.ts";
import type { R8Memo } from "./rule/types.ts";

export interface LookRow {
  gpu: GpuModel;
  gpuId: Hex;
  sourceId: string;
  interval: number;
  at: number;
  state: ReadState;
  valueU: number;
  region: string;
  writerRegion: boolean;
}

export interface SignatureRow {
  gpuId: Hex;
  day: number;
  writer: Address;
  digest: Hex;
  rule: "R11" | "R12";
  at: number;
  txHash?: Hex;
  note?: string;
}

export interface R8Row extends R8Memo {
  gpuId: Hex;
  day: number;
  at: number;
}

/** R4b: a slot a person found readable from the writer's region while the watcher sees it dark. */
export interface BlockFlagRow {
  gpuId: Hex;
  sourceId: string;
  from: number; // first day
  to: number; // last day (4294967295 = until the watcher reads it again and the flag is closed)
  at: number;
}

export interface GuardianLogView {
  looks(gpuId: Hex): LookRow[];
  flags?(gpuId: Hex): BlockFlagRow[];
  handSigned(gpuId: Hex, day: number, digest?: Hex): boolean;
  r8(gpuId: Hex, day: number): R8Memo[];
}

function readJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  const out: T[] = [];
  for (const ln of readFileSync(p, "utf8").split("\n")) {
    if (!ln.trim()) continue;
    try {
      out.push(JSON.parse(ln) as T);
    } catch {
      // skip a torn or corrupt line
    }
  }
  return out;
}

export class GuardianLog implements GuardianLogView {
  constructor(readonly dir: string) {}
  get looksPath() {
    return join(this.dir, "looks.jsonl");
  }
  get sigPath() {
    return join(this.dir, "signatures.jsonl");
  }
  get r8Path() {
    return join(this.dir, "r8.jsonl");
  }
  get flagPath() {
    return join(this.dir, "flags.jsonl");
  }
  /** The newest row per (gpu, source) wins, so a flag is closed by writing it again with its last day. */
  flags(gpuId: Hex): BlockFlagRow[] {
    const by = new Map<string, BlockFlagRow>();
    for (const r of readJsonl<BlockFlagRow>(this.flagPath)) if (r.gpuId.toLowerCase() === gpuId.toLowerCase()) by.set(`${r.sourceId}:${r.from}`, r);
    return [...by.values()];
  }
  addFlag(r: BlockFlagRow) {
    appendLine(this.flagPath, r);
  }
  looks(gpuId: Hex): LookRow[] {
    return readJsonl<LookRow>(this.looksPath).filter((l) => l.gpuId.toLowerCase() === gpuId.toLowerCase());
  }
  signatures(): SignatureRow[] {
    return readJsonl<SignatureRow>(this.sigPath);
  }
  handSigned(gpuId: Hex, day: number, digest?: Hex): boolean {
    return this.signatures().some((s) => s.gpuId.toLowerCase() === gpuId.toLowerCase() && s.day === day && (!digest || s.digest.toLowerCase() === digest.toLowerCase()));
  }
  /** The latest memo per writer for that day. */
  r8(gpuId: Hex, day: number): R8Memo[] {
    const by = new Map<string, R8Row>();
    for (const r of readJsonl<R8Row>(this.r8Path)) if (r.gpuId.toLowerCase() === gpuId.toLowerCase() && r.day === day) by.set(r.writer.toLowerCase(), r);
    return [...by.values()];
  }
  addLook(r: LookRow) {
    appendLine(this.looksPath, r);
  }
  addSignature(r: SignatureRow) {
    appendLine(this.sigPath, r);
  }
  addR8(r: R8Row) {
    appendLine(this.r8Path, r);
  }
}

/** An in-memory guardian log (the harness's scripted guardian). */
export class MemGuardianLog implements GuardianLogView {
  readonly lookRows: LookRow[] = [];
  readonly sigRows: SignatureRow[] = [];
  readonly r8Rows: R8Row[] = [];
  looks(gpuId: Hex) {
    return this.lookRows.filter((l) => l.gpuId.toLowerCase() === gpuId.toLowerCase());
  }
  handSigned(gpuId: Hex, day: number, digest?: Hex) {
    return this.sigRows.some((s) => s.gpuId.toLowerCase() === gpuId.toLowerCase() && s.day === day && (!digest || s.digest.toLowerCase() === digest.toLowerCase()));
  }
  r8(gpuId: Hex, day: number) {
    return this.r8Rows.filter((r) => r.gpuId.toLowerCase() === gpuId.toLowerCase() && r.day === day);
  }
}
