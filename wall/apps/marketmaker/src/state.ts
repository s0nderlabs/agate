// BOTS-SPEC 3.10: the maker's persisted state (state.json, written atomically after every receipt). Only what the chain
// cannot tell is trusted from it: which order ids are the maker's, what it quoted, the series it held, the baseline;
// balances, inventory and books are read from the chain each tick, and every order id is re-checked by s_orders.
import { existsSync, readFileSync } from "node:fs";
import type { Address } from "viem";
import { writeAtomic } from "@agate/watcher";
import type { OwnOrder } from "./book.ts";
import type { QuotedRec } from "./decide.ts";
import type { V2Quoted } from "./v2.ts";

export interface HeldSeries {
  series: Address;
  factory: string; // deployments name
  market: Address | null;
  token: Address;
}

/** A batchUpdate between its send and its receipt: on restart, ids above counterBefore are scanned for the maker's. */
export interface PendingSend {
  counterBefore: bigint;
  at: number;
  fair: bigint | null; // the requote's fair (null: a cancel), so a recovered ladder needs no second requote
  lo?: bigint; // the requote's band (M-H1)
  hi?: bigint;
}

/** What a state file belongs to (the P-M3 rule, for the maker too): a state of another chain or deployment (a fork
 *  rehearsal with the same AGATE_WALL_HOME, a testnet reset) is set aside, never trusted. */
export interface MakerIdentity {
  chainId: number;
  dollar: string;
  marginAccount: string;
  factories: string[]; // every factory of the deployments file, lowercase, sorted
}

export interface MmState {
  version: 1;
  orders: Record<string, OwnOrder[]>; // market (lowercase) -> the maker's active orders
  markets: Record<string, string>; // market (lowercase) -> its series (lowercase), so a replaced book is wound down
  quoted: Record<string, QuotedRec>; // market -> the last requote
  series: Record<string, HeldSeries>; // series (lowercase) -> held until settled
  baseline: bigint | null;
  lossArm: bigint | null; // after a loss kill is cleared: the value under which the loss limit engages again
  killed: { reason: string; at: number } | null; // mirror of the KILL file
  pending: Record<string, PendingSend>; // market -> an unconfirmed batchUpdate
  failures: Record<string, number>; // market -> failed sends in a row
  settled: string[]; // series dropped after settlement
  lastFair: Record<string, bigint>; // series -> its last fair value, for the mark when its index walk finds none (M-M4)
  identity?: MakerIdentity;
  v2?: Record<string, V2Quoted>; // Kuru Spot V2 market (lowercase) -> its last requote (v2.ts)
}

export function emptyState(): MmState {
  return { version: 1, orders: {}, markets: {}, quoted: {}, series: {}, baseline: null, lossArm: null, killed: null, pending: {}, failures: {}, settled: [], lastFair: {} };
}

export function makerIdentity(d: { chainId: number; dollar: string; kuru: { marginAccount: string }; factories: Record<string, { factory: string }> }): MakerIdentity {
  return { chainId: d.chainId, dollar: d.dollar.toLowerCase(), marginAccount: d.kuru.marginAccount.toLowerCase(), factories: [...new Set(Object.values(d.factories).map((f) => f.factory.toLowerCase()))].sort() };
}

/** null when the state file's identity matches (or it has none: an older file, adopted); else the fields that differ. */
export function identityDiffers(want: MakerIdentity, got: MakerIdentity | undefined): string | null {
  if (!got) return null;
  const out: string[] = [];
  if (got.chainId !== want.chainId) out.push("chainId");
  if (String(got.dollar).toLowerCase() !== want.dollar) out.push("dollar");
  if (String(got.marginAccount).toLowerCase() !== want.marginAccount) out.push("marginAccount");
  if (JSON.stringify([...(got.factories ?? [])].map((f) => String(f).toLowerCase()).sort()) !== JSON.stringify(want.factories)) out.push("factories");
  return out.length ? out.join(", ") : null;
}

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);
const unbig = (_k: string, v: unknown) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

export function serialize(s: MmState): string {
  return JSON.stringify(s, big, 1);
}

/** null: missing or unreadable (the caller then rebuilds from the chain, 3.10). */
export function deserialize(text: string): MmState | null {
  try {
    const j = JSON.parse(text, unbig) as MmState;
    if (!j || j.version !== 1 || typeof j.orders !== "object") return null;
    return { ...emptyState(), ...j };
  } catch {
    return null;
  }
}

export class StateFile {
  constructor(readonly path: string) {}
  load(): MmState | null {
    if (!existsSync(this.path)) return null;
    try {
      return deserialize(readFileSync(this.path, "utf8"));
    } catch {
      return null;
    }
  }
  save(s: MmState): void {
    writeAtomic(this.path, serialize(s));
  }
}
