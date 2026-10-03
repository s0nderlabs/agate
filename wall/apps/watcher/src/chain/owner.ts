// Owner actions and reader swaps as the watcher and the guardian see them (BUILD-SPEC 4.11, 4.15, 10): their ids,
// their fields by kind, and which queued entries are live (queuedEta(id) != 0), waiting, executable or expired. The
// chain's queuedEta is the authority; events only say which ids exist and what they hold.
import { encodeAbiParameters, keccak256 } from "viem";
import type { Address, Hex } from "@agate/report/types";
import { ActionKind } from "@agate/report/types";
import type { WallEvent } from "./types.ts";

/** Mirrors IAgateIndex's ACTION_WINDOW_DAYS (4.11): an entry is executable from eta to eta + 14 DAY. */
export const ACTION_WINDOW_DAYS = 14;
/** keccak256("agate.ReaderSwap.v1") (4.15). */
export const READER_SWAP_TAG: Hex = keccak256(new TextEncoder().encode("agate.ReaderSwap.v1"));

export const ACTION_KIND_NAME = ["WRITER", "ATTESTER", "GUARDIAN", "FORWARDER", "LIVE_FROM", "LIVE_UNTIL", "OWNER"] as const;

export interface ActionFields {
  kind: number;
  slot: number;
  addr: Address;
  gpuId: Hex;
  day: number;
  mode: number;
}

const ACTION_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "kind", type: "uint8" },
      { name: "slot", type: "uint8" },
      { name: "addr", type: "address" },
      { name: "gpuId", type: "bytes32" },
      { name: "day", type: "uint32" },
      { name: "mode", type: "uint8" },
    ],
  },
] as const;

/** actionId(a) = keccak256(abi.encode(a)). */
export function actionIdOf(a: ActionFields): Hex {
  return keccak256(encodeAbiParameters(ACTION_TUPLE, [a]));
}

export function readerHashOf(url: string, parserVersion: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], [url, parserVersion]));
}

/** readerSwapId = keccak256(abi.encode(READER_SWAP_TAG, gpuId, slot, readerHash)). */
export function readerSwapIdOf(gpuId: Hex, slot: number, url: string, parserVersion: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }], [READER_SWAP_TAG, gpuId, slot, readerHashOf(url, parserVersion)]));
}

/** The fields a kind uses, by name (4.11's table): "slot 1 addr 0x..", "gpu 0x.. slot 3 day 20788", ... */
export function actionFieldsText(a: Partial<ActionFields>, gpuName?: (g: Hex) => string): string {
  const g = a.gpuId ? (gpuName?.(a.gpuId) ?? a.gpuId) : "-";
  switch (a.kind) {
    case ActionKind.WRITER:
    case ActionKind.GUARDIAN:
      return `slot ${a.slot} addr ${a.addr}`;
    case ActionKind.ATTESTER:
    case ActionKind.OWNER:
      return `addr ${a.addr}`;
    case ActionKind.FORWARDER:
      return `addr ${a.addr} mode ${a.mode === 1 ? "WORKFLOW_OWNER" : "TX_ORIGIN"}`;
    case ActionKind.LIVE_FROM:
    case ActionKind.LIVE_UNTIL:
      return `gpu ${g} slot ${a.slot} day ${a.day}`;
    default:
      return `kind ${a.kind}`;
  }
}

export type OwnerEntryState = "waiting" | "executable" | "expired";

export interface OwnerEntry {
  type: "action" | "reader";
  id: Hex;
  eta: number;
  windowEnd: number;
  state: OwnerEntryState;
  /** an action's fields (type "action") */
  action?: Partial<ActionFields>;
  /** a reader swap's fields (type "reader") */
  reader?: { gpuId: Hex; slot: number; url: string; parserVersion: string; reason: string };
}

/**
 * Every queued entry the events name that is not executed or cancelled since its newest queue event: live ones by
 * the chain's queuedEta (!= 0), and, with nothing live under the id, the ones whose window passed unexecuted
 * (expired). An executed or cancelled id is never listed. queuedEta is read once per candidate id.
 */
export async function ownerEntries(events: readonly WallEvent[], queuedEta: (id: Hex) => Promise<number>, day: number, now: number): Promise<OwnerEntry[]> {
  const window = ACTION_WINDOW_DAYS * day;
  const last = new Map<string, WallEvent>(); // id -> its newest queue, execute or cancel event
  for (const e of events) {
    if (e.name === "ActionQueued" || e.name === "ActionExecuted" || e.name === "ActionCancelled" || e.name === "ReaderSwapQueued" || e.name === "ReaderSwapped" || e.name === "ReaderSwapCancelled")
      last.set(e.id.toLowerCase(), e);
  }
  const out: OwnerEntry[] = [];
  for (const e of last.values()) {
    if (e.name !== "ActionQueued" && e.name !== "ReaderSwapQueued") continue; // executed or cancelled: gone
    const live = await queuedEta(e.id);
    const eta = live !== 0 ? live : e.eta;
    const windowEnd = eta + window;
    const state: OwnerEntryState = live === 0 ? "expired" : now < eta ? "waiting" : "executable";
    if (live === 0 && now <= windowEnd) continue; // the chain says not queued although no event says so: trust it
    const base = { id: e.id, eta, windowEnd, state };
    if (e.name === "ActionQueued") out.push({ ...base, type: "action", action: { kind: e.kind ?? -1, slot: e.slot ?? 0, addr: e.addr ?? ("0x" as Address), gpuId: e.actionGpuId ?? ("0x" as Hex), day: e.actionDay ?? 0, mode: e.mode ?? 0 } });
    else out.push({ ...base, type: "reader", reader: { gpuId: e.gpuId, slot: e.slot, url: e.url, parserVersion: e.parserVersion, reason: e.reason } });
  }
  return out.sort((a, b) => a.eta - b.eta);
}

/** "in N s" / "executable, window ends in N s" / "expired at T". */
export function entryWhen(x: OwnerEntry, now: number): string {
  if (x.state === "waiting") return `in ${x.eta - now} s (window ends ${x.windowEnd})`;
  if (x.state === "executable") return `executable, window ends in ${x.windowEnd - now} s`;
  return `expired at ${x.windowEnd} (queue again to use)`;
}
