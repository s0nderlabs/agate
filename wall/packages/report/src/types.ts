// Mirrors contracts/src/interfaces/IAgateIndex.sol exactly (names, order, widths).
// Widths: viem decodes uint8..uint48 as number and uint56+ as bigint, so uint64 and uint256 are bigint here.
// Shared offchain types (watcher log, alerts) follow at the end. See docs/wall/BUILD-SPEC.md.

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

// ---------------------------------------------------------------- constants (file-level in IAgateIndex.sol)

export const TICK = 10_000; // $0.01 in u (1 u = $0.000001)
export const P_MIN = 100_000; // $0.10
export const P_MAX = 1_000_000_000; // $1,000
export const MAX_SLOTS = 15;
export const HOLD_DAYS = 5;
export const SHADOW_DAYS = 5;
export const NEVER = 0xffffffff;
export const REPORT_VERSION = 1;
export const N_WRITERS = 2;
export const N_GUARDIANS = 2;
/** A queued owner action or reader swap is executable from eta to eta + ACTION_WINDOW_DAYS * DAY (4.11, Oct 3). */
export const ACTION_WINDOW_DAYS = 14;
/** keccak256("agate.ReaderSwap.v1"): separates reader swap ids from Action ids (4.15). */
export const READER_SWAP_TAG: Hex = "0xf3d8c20af718394f49eed11d4b00c6e4ca01daa8294a7dd61b0faf5d5aa0ed35";

// ---------------------------------------------------------------- enums (uint8 on the wire)

export const Kind = { OUT: 0, FRESH: 1, HELD: 2 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export const Status = { NONE: 0, FULL: 1, DEGRADED: 2, DEMO: 3, CARRIED: 4 } as const;
export type Status = (typeof Status)[keyof typeof Status];

export const WriterMode = { TX_ORIGIN: 0, WORKFLOW_OWNER: 1 } as const;
export type WriterMode = (typeof WriterMode)[keyof typeof WriterMode];

export const ActionKind = {
  WRITER: 0,
  ATTESTER: 1,
  GUARDIAN: 2,
  FORWARDER: 3,
  LIVE_FROM: 4,
  LIVE_UNTIL: 5,
  OWNER: 6,
} as const;
export type ActionKind = (typeof ActionKind)[keyof typeof ActionKind];

export const Skip = {
  NONE: 0,
  E1_GPU_OR_LENGTH: 1,
  E2_SLICE: 2,
  E3_DAY_CLOSED: 3,
  E4_VOIDED: 4,
  E5_READ_AT_OUTSIDE_SLICE: 5,
  E6_READ_AT_FUTURE: 6,
  E7_DUPLICATE: 7,
} as const;
export type Skip = (typeof Skip)[keyof typeof Skip];

// ---------------------------------------------------------------- structs

/** One slice of readings of one GPU. values[i] = slot i's reading in u, 0 = no reading. */
export interface Entry {
  gpuId: Hex; // bytes32
  dayId: number; // uint32
  slice: number; // uint8
  readAt: bigint; // uint64, unix seconds
  values: readonly number[]; // uint32[], length = the GPU's nSlots
}

/** report = abi.encode(uint8 version, uint64 chainSelector, address index, Entry[] entries) */
export interface Report {
  version: number; // uint8, always REPORT_VERSION
  chainSelector: bigint; // uint64
  index: Address;
  entries: readonly Entry[];
}

export interface InitParams {
  day: number;
  slices: number;
  minReadings: number;
  qMin: number;
  demoLabel: boolean;
  signAll: boolean; // every computed record needs a countersign; required when PEND_FLOOR > day/2 (FAST)
  epochTs: bigint;
  epochDay: number;
  chainSelector: bigint;
  owner: Address;
  writers: readonly [Address, Address];
  attester: Address;
  guardians: readonly [Address, Address];
  forwarder: Address;
  writerMode: WriterMode;
}

/** BUILD-SPEC 2.2 (rule R v4.3): tPend = max(day/4, gap*slice + 60), or day/4 when signAll and that floor > day/2;
 *  grace = day; reopenWait = day/4. */
export interface Clocks {
  day: number;
  slice: number;
  tPend: number;
  closeGrace: number;
  grace: number;
  holdMove: number;
  holdMin: number;
  step: number;
  reopenWait: number;
  timelock: number;
  slices: number;
  minReadings: number;
  qMin: number;
  demoLabel: boolean;
  signAll: boolean;
  epochTs: bigint;
  epochDay: number;
  chainSelector: bigint;
}

export interface GpuConfig {
  recipeHash: Hex;
  nSlots: number;
  nFamilies: number;
  firstDay: number;
  registeredAt: bigint;
  lastCarryAt: bigint;
  head: number;
}

export interface SlotState {
  e: number; // uint32 held value, u
  miss: number; // uint8, 0..HOLD_DAYS+1
  inMedian: boolean;
  wasIn: boolean;
}

/** Named IndexRecord to avoid clashing with TypeScript's built-in Record<K, V>. Solidity name: Record. */
export interface IndexRecord {
  value: number;
  status: Status;
  fresh: number;
  quorum: number;
  held: number;
  freshMedian: number;
  late: boolean;
  incomplete: boolean;
  changed: boolean; // value, membership or entry changed (4.6)
  needsSign: boolean; // changed, or signAll, or source is not the day's first writer: finalAt 0n until attested
  dropped: boolean;
  source: Address;
  postedAt: bigint;
  finalAt: bigint; // 0n = not final yet
  attestedAt: bigint;
  attestedBy: Address;
  digest: Hex;
}

export interface RecordDetail {
  rec: IndexRecord;
  p: readonly number[];
  kinds: readonly Kind[];
  counts: readonly number[];
  post: readonly SlotState[];
}

export interface Readings {
  sums: readonly number[]; // uint40[]
  counts: readonly number[]; // uint8[]
  sliceBits: bigint; // uint256
  late: boolean;
  anyValid: boolean;
  lastPostAt: bigint;
}

export interface Action {
  kind: ActionKind;
  slot: number;
  addr: Address;
  gpuId: Hex;
  day: number;
  mode: WriterMode;
}

/** A slot's reader: the page it fetches and the parser version that reads it (4.15, 7.6). */
export interface Reader {
  url: string; // "https://...", 9 to 256 bytes
  parserVersion: string; // 1 to 32 bytes, e.g. "lambda/2"
}

/** One executed swap of a slot's reader (readerHistory, readerAt). Before the first entry the registered recipe's
 *  reader applies. readerHash = keccak256(abi.encode(url, parserVersion)). */
export interface ReaderVersion {
  fromDay: number; // uint32: the first index day read with this reader
  executedAt: bigint; // uint64
  readerHash: Hex;
  url: string;
  parserVersion: string;
  reason: string;
}

/** Decoded ReadingsPosted event: the public per-slice view the watcher's VETO side and R8 tooling need. */
export interface ReadingsPosted {
  gpuId: Hex;
  day: number;
  writer: Address;
  slice: number;
  readAt: bigint;
  values: readonly number[];
  validMask: number; // bit i: values[i] entered the writer's sums
  late: boolean;
}

// ---------------------------------------------------------------- shared offchain types

/** One page read as the rule-R log sees it (BUILD-SPEC section 6.1, rule R v4.3). */
export const ReadState = {
  VALID: "VALID", // fetched, row found, rentable, price inside [P_MIN, P_MAX]
  NOT_RENTABLE: "NOT_RENTABLE", // row found, shown sold out / waitlist / contact sales
  NO_ROW: "NO_ROW", // page served and parsed, the recipe's row is absent (removed, layout change, other currency)
  BAD_VALUE: "BAD_VALUE", // row found, price outside the absolute bounds or unparseable
  FAILED: "FAILED", // HTTP error, timeout or network error after the one retry
  MISSED: "MISSED", // no attempt in that interval (process down, not started)
} as const;
export type ReadState = (typeof ReadState)[keyof typeof ReadState];

export type GpuModel = "H100" | "H200" | "B200";

/** One line of the watcher's log: one source page, one interval, all GPUs read from that page. */
export interface WatcherReading {
  sourceId: string;
  interval: number; // absolute interval k: [EPOCH_TS + k*slice, +slice)
  scheduledAt: number; // unix s, the randomised minute
  fetchedAt: number; // unix s of the attempt that produced the state (0 if MISSED)
  attempts: number; // 0, 1 or 2
  httpStatus: number; // 0 if no response
  bytes: number;
  sha256: string; // of the raw body, "" if none
  fxDate?: string; // ECB rate date used for an EUR source (YYYY-MM-DD)
  gpus: Partial<Record<GpuModel, { state: ReadState; valueU: number }>>; // valueU = 0 unless VALID
  error?: string;
  url?: string; // the URL fetched, when not the registered one (a reader swap, 8.6)
  parsers?: Partial<Record<GpuModel, string>>; // parserVersion per GPU, when any is not the registered one (8.6)
  location?: string; // the final URL when the fetch followed a redirect to another URL (15.2's "moved" diagnosis)
}

export const AlertCode = {
  R1_SIGNED: "R1_SIGNED", // info: attester countersigned a changed record
  R1_SELECTED: "R1_SELECTED", // info: attester selected another writer's record
  R1_NO_CANDIDATE: "R1_NO_CANDIDATE", // action: a needsSign record nothing can sign automatically (R11, R12)
  R3_VETO_REASON: "R3_VETO_REASON", // action: a pending record shows a veto reason (fix, slot or dark)
  R4_WRITER_FETCH: "R4_WRITER_FETCH", // action: fresh for the watcher, not for a writer, 2 computed days
  R4B_WATCHER_DARK: "R4B_WATCHER_DARK", // action: dark in the watcher's log 2 computed days (look within T_PEND)
  R5_HEAD_LAG: "R5_HEAD_LAG", // action: the oldest day without a final record ended one DAY ago (deadline dayEnd + LAG_MAX)
  R8_SUSPEND_REASON: "R8_SUSPEND_REASON", // action: R8 conditions met for a writer
  R9_UNCHANGED_NOT_STRICT: "R9_UNCHANGED_NOT_STRICT", // info if the attester selected, else action
  R9_HELD_MISMATCH: "R9_HELD_MISMATCH", // action: a HELD slot's onchain value is outside the watcher's memory (F9)
  R9_HELD_UNVOUCHED: "R9_HELD_UNVOUCHED", // action: a HELD slot taken at its onchain value; its anchor day is unknowable
  R9_MISS_MISMATCH: "R9_MISS_MISMATCH", // action: the watcher's walked count differs from the onchain miss count (6.3)
  R9_UNCLASSIFIABLE: "R9_UNCLASSIFIABLE", // info (partial range); action when unverifiable for every candidate (F5, D2)
  R9B_BLIND_SLOT_SPLIT: "R9B_BLIND_SLOT_SPLIT", // action: writers differ on a slot the watcher cannot read fresh (F3)
  FREEZE_LOOP: "FREEZE_LOOP", // action: a FixDropped; carries the drops in a row and the next record's refusal reasons (R12)
  R10_SPLIT_STEP: "R10_SPLIT_STEP", // action: fewer than two families beyond the median moved with a recent move
  TRACKER_GAP: "TRACKER_GAP", // info: superseded Oct 3 by PAGECHECK_REVIEW (kept so old alert files parse; nothing raises it)
  PAGECHECK_REVIEW: "PAGECHECK_REVIEW", // info: a panel cloud's reading differs from its tracker row by more than 10% (15.1)
  PAGECHECK_FAULT: "PAGECHECK_FAULT", // action: that gap has lasted one DAY: a likely parser fault (15.1)
  PAGECHECK_TRACKERS_DOWN: "PAGECHECK_TRACKERS_DOWN", // info: no tracker row for any pair for DAY/4 of intervals
  KEY_MISMATCH: "KEY_MISMATCH", // action: a writer's onchain readings differ from its own log: a second user of its key (8.5)
  KEY_UNVERIFIED: "KEY_UNVERIFIED", // info: an onchain post of a slice whose CRE run output the writer could not parse (8.5)
  READER_MISSING: "READER_MISSING", // action: a reader in force (or queued) whose parserVersion this process lacks (8.6)
  READER_REFUSED: "READER_REFUSED", // action: a reader in force (or queued) not https or off the source's host allowlist (8.6)
  REPAIR_INCIDENT: "REPAIR_INCIDENT", // info: the repair agent opened an incident (15.2)
  REPAIR_NOTE: "REPAIR_NOTE", // action: an approval note is ready (15.2)
  REPAIR_REFUSED: "REPAIR_REFUSED", // action: a draft failed a guard (15.2)
  REPAIR_WINDOW: "REPAIR_WINDOW", // action: a proposed reader swap past its eta, unexecuted, under 2 DAY of its window left
  WATCHER_GAP: "WATCHER_GAP", // action: the watcher missed intervals (its own health)
  WRITER_GAP: "WRITER_GAP", // action: a writer's slice bits are missing past the repost window
  HEARTBEAT_LOST: "HEARTBEAT_LOST", // action: a role's heartbeat is older than three of its tick periods
  RPC_FAILOVER: "RPC_FAILOVER", // info: a process moved to its next RPC URL
  RPC_DOWN: "RPC_DOWN", // action: every RPC URL failed on two ticks running
  RPC_SINGLE: "RPC_SINGLE", // action: only one RPC URL configured
  RPC_WS_DOWN: "RPC_WS_DOWN", // info: no websocket subscription live for 3 ticks (polling only; 13.6)
  GAS_CAP: "GAS_CAP", // action: a call's needed gas limit exceeds its cap; not sent
  NONCE_STUCK: "NONCE_STUCK", // action: a transaction still unmined after three replacements
  CLOCK_JUMP: "CLOCK_JUMP", // info: a process woke after a clock jump (sleep, suspend)
  CLOCK_SKEW: "CLOCK_SKEW", // action: local clock and chain head time differ beyond max(5 s, slice/20)
  KEY_LOW: "KEY_LOW", // action: a role key holds less than 10 MON
  ONCHAIN_EVENT: "ONCHAIN_EVENT", // info: veto, suspension, drop, carry, owner action or reader swap (action: a ReaderSwapQueued)
} as const;
export type AlertCode = (typeof AlertCode)[keyof typeof AlertCode];

export interface Alert {
  id: string; // stable: `${code}:${gpuId}:${day}:${slot ?? "-"}:${writer ?? "-"}`
  code: AlertCode;
  severity: "info" | "action";
  gpuId?: Hex;
  day?: number;
  slot?: number;
  writer?: Address;
  at: number; // unix s raised
  deadline?: number; // unix s by which a person must act (rule text)
  message: string;
  data?: unknown;
}
