// What the attester, keeper, health and guardian need from an index: views, decoded events and a sender. The viem
// implementation (viem-index.ts) and the in-memory fake (sim/fake-chain.ts) both implement these.
import type { Address, Clocks, GpuConfig, Hex, IndexRecord, Kind, Readings, SlotState } from "@agate/report/types";

export interface Detail {
  rec: IndexRecord;
  p: number[];
  kinds: Kind[];
  counts: number[];
  post: SlotState[];
}

export interface IndexView {
  readonly address: Address;
  blockTime(): Promise<number>;
  clocks(): Promise<Clocks>;
  gpu(g: Hex): Promise<GpuConfig>;
  head(g: Hex): Promise<number>;
  record(g: Hex, d: number): Promise<{ exists: boolean; isFinal: boolean; rec: IndexRecord }>;
  slotStates(g: Hex): Promise<{ base: SlotState[]; last: SlotState[] }>;
  slotWindow(g: Hex, i: number): Promise<{ liveFrom: number; liveUntil: number }>;
  familyOf(g: Hex, i: number): Promise<{ family: number; famQ: number }>;
  readings(g: Hex, d: number, w: Address): Promise<Readings>;
  previewRecord(g: Hex, d: number, w: Address): Promise<{ ok: boolean; detail: Detail }>;
  previewFix(g: Hex): Promise<{ ok: boolean; detail: Detail }>;
  writers(): Promise<readonly [Address, Address]>;
  attester(): Promise<Address>;
  guardians(): Promise<readonly [Address, Address]>;
  isSuspended(w: Address): Promise<boolean>;
  isVoided(g: Hex, d: number, w: Address): Promise<boolean>;
  reopenedAt(g: Hex, d: number): Promise<number>;
  firstRecordDay(g: Hex): Promise<{ exists: boolean; day: number }>;
  balance(a: Address): Promise<bigint>;
}

interface Ev {
  key: string; // unique and ordered: "<block 12 digits>:<logIndex 6 digits>"
  gpuId: Hex;
  day: number;
}
export type WallEvent =
  | (Ev & { name: "ReadingsPosted"; writer: Address; slice: number; readAt: number; values: number[]; validMask: number; late: boolean })
  | (Ev & { name: "RecordSlots"; source: Address; digest: Hex; p: number[]; kinds: Kind[]; counts: number[]; post: SlotState[] })
  | (Ev & { name: "DayClosed"; source: Address; value: number; changed: boolean; needsSign: boolean; digest: Hex; incomplete: boolean })
  | (Ev & { name: "DayCarried"; value: number; carryCase: number; dropped: boolean; missAdvanced: number })
  | (Ev & { name: "DaySkipped"; carryCase: number })
  | (Ev & { name: "FixDropped"; source: Address; value: number; digest: Hex })
  | (Ev & { name: "Vetoed"; by: Address; source: Address; digest: Hex; value: number })
  | (Ev & { name: "Attested"; by: Address; source: Address; digest: Hex; finalAt: number })
  | (Ev & { name: "RecordReplaced"; by: Address; oldSource: Address; newSource: Address; oldValue: number; newValue: number; oldDigest: Hex; newDigest: Hex })
  | (Ev & { name: "WriterSuspended"; writer: Address; by: Address })
  | (Ev & { name: "ActionQueued"; id: Hex; eta: number; kind?: number; addr?: Address; mode?: number });

export type WallEventName = WallEvent["name"];

export interface EventSource {
  /** Pull new events (incremental, restart-safe). Throws on RPC failure; the caller retries next tick. */
  sync(): Promise<void>;
  all(): readonly WallEvent[];
}

export type CallName = "attest" | "closeDay" | "carryDay" | "veto" | "suspend";

export interface SendResult {
  ok: boolean;
  sent: boolean; // false: eth_call said it reverts, or a guard refused (GAS_CAP), nothing was sent
  txHash?: Hex;
  gasLimit?: bigint;
  error?: string;
}

export interface Sender {
  readonly from: Address;
  send(fn: CallName, args: readonly unknown[]): Promise<SendResult>;
  /** eth_call only (the keeper's and the CLI's "would it succeed"). */
  simulate(fn: CallName, args: readonly unknown[]): Promise<{ ok: boolean; error?: string }>;
}

export function evKey(block: number, logIndex: number): string {
  return `${String(block).padStart(12, "0")}:${String(logIndex).padStart(6, "0")}`;
}
