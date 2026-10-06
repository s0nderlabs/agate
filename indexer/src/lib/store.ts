// Shared entity helpers for the handlers. Every handler first calls `seen` (the clock's notion of chain time, 5.6).
import type { EvmOnEventContext } from "envio";
import { FACTORIES, INDEXES } from "./deployments.ts";
import { isZero, low } from "./ids.ts";

export type Ctx = EvmOnEventContext;

/** The fields every handler reads from its event. */
export interface EvMeta {
  readonly block: { readonly number: number; readonly timestamp: number };
  readonly logIndex: number;
  readonly srcAddress: string;
  readonly transaction: { readonly hash: string; readonly from: string | undefined };
}

// The newest event time seen in processing order. Envio's block handlers get a block number but no timestamp, so the
// clock (5.6) uses this: never later than its own block, at most as stale as the last event before it. Written only
// on the real run (not the preload pass, which can run ahead of a batch's block handlers); a lower block number
// means a new run or a rollback, so it simply replaces the value.
let last: { block: number; t: bigint } | null = null;

export function seen(event: EvMeta, context: Ctx): void {
  if (context.isPreload) return;
  last = { block: event.block.number, t: BigInt(event.block.timestamp) };
}
/** The chain time the clock may use at `block`: the newest event time at or before it, else null. */
export function timeAt(block: number): bigint | null {
  return last !== null && last.block <= block ? last.t : null;
}

export async function account(context: Ctx, addr: string, t: bigint): Promise<string | undefined> {
  if (isZero(addr)) return undefined;
  const id = low(addr);
  await context.Account.getOrCreate({ id, firstSeenAt: t, nextDripAt: undefined });
  return id;
}

export function factoryInfo(addr: string) {
  return FACTORIES[low(addr)];
}

/** The PriceIndex row of an index address, created from the generated deployments on first use. */
export async function priceIndex(context: Ctx, addr: string): Promise<{ id: string; tPend: number } | undefined> {
  const id = low(addr);
  const info = INDEXES[id];
  if (!info) return undefined;
  await context.PriceIndex.getOrCreate({ id, names: [...info.names], tPend: info.tPend });
  return { id, tPend: info.tPend };
}
