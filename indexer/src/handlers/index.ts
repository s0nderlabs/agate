// AgateIndex (static, both indexes): the daily fixes and their finality, owner actions, reader swaps and
// suspensions (BOTS-SPEC 5.5; MS 8.6). No event fires when a record becomes final, so finalAt is computed here
// (tPend per index from the deployments file) and the clock (clock.ts) moves PENDING to FINAL.
import { indexer, type Entity } from "envio";
import { eventId, fixId, low, orNone, pairId } from "../lib/ids.ts";
import { FIX_STATUS, enumOf } from "../lib/labels.ts";
import { isoOfDay } from "../lib/math.ts";
import { account, priceIndex, seen, type Ctx } from "../lib/store.ts";

type DailyFix = Entity<"DailyFix">;
type Meta = { srcAddress: string; logIndex: number; block: { number: number; timestamp: number }; transaction: { hash: string } };

/** The DailyFix of (index, gpu, day), or a fresh one for a day with no row yet ("open"). */
async function fixOf(context: Ctx, index: string, gpuId: string, day: number, t: bigint): Promise<DailyFix> {
  const id = fixId(index, gpuId, day);
  return (
    (await context.DailyFix.get(id)) ?? {
      id,
      index_id: index,
      gpuId: low(gpuId),
      day,
      date: isoOfDay(day),
      value: 0n,
      status: "NONE",
      fresh: 0,
      held: 0,
      freshMedian: 0n,
      changed: false,
      needsSign: false,
      late: false,
      incomplete: false,
      source: undefined,
      digest: undefined,
      postedAt: undefined,
      finalAt: undefined,
      attestedAt: undefined,
      attestedBy: undefined,
      replaced: false,
      vetoed: false,
      vetoCount: 0,
      dropped: false,
      state: "PENDING",
      updatedAt: t,
    }
  );
}

/** Applies `change` to the day's DailyFix and appends its audit row. */
async function onFix(
  context: Ctx,
  ev: Meta,
  gpuId: string,
  day: bigint,
  kind: string,
  extra: { value?: bigint; by?: string; source?: string },
  change: (f: DailyFix, t: bigint, tPend: number) => DailyFix,
): Promise<void> {
  const ix = await priceIndex(context, ev.srcAddress);
  if (!ix) {
    context.log.warn("index event from an index not in the deployments file", { index: ev.srcAddress });
    return;
  }
  const t = BigInt(ev.block.timestamp);
  if (extra.by !== undefined) await account(context, extra.by, t);
  if (extra.source !== undefined) await account(context, extra.source, t);
  const f = await fixOf(context, ix.id, gpuId, Number(day), t);
  context.DailyFix.set({ ...change(f, t, ix.tPend), updatedAt: t });
  context.FixEvent.set({
    id: eventId(ev.block.number, ev.logIndex),
    fix_id: f.id,
    kind,
    value: extra.value,
    by: extra.by === undefined ? undefined : orNone(extra.by),
    source: extra.source === undefined ? undefined : orNone(extra.source),
    timestamp: t,
    txHash: ev.transaction.hash,
  });
}

indexer.onEvent({ contract: "AgateIndex", event: "GpuRegistered" }, async ({ event, context }) => {
  seen(event, context);
  const ix = await priceIndex(context, event.srcAddress);
  if (!ix) return;
  const p = event.params;
  context.IndexGpu.set({
    id: pairId(ix.id, p.gpuId),
    index_id: ix.id,
    gpuId: low(p.gpuId),
    recipeHash: low(p.recipeHash),
    firstDay: Number(p.firstDay),
    registeredAt: BigInt(event.block.timestamp),
  });
});

// A reopened day (after a veto) is closed again: the new record replaces the old, vetoed and dropped stay.
indexer.onEvent({ contract: "AgateIndex", event: "DayClosed" }, async ({ event, context }) => {
  seen(event, context);
  const p = event.params;
  await onFix(context, event, p.gpuId, p.day, "DayClosed", { value: p.value, source: p.source }, (f, t, tPend) => ({
    ...f,
    value: p.value,
    status: enumOf(FIX_STATUS, p.status, "fix status"),
    fresh: Number(p.fresh),
    held: Number(p.held),
    freshMedian: p.freshMedian,
    changed: p.changed,
    needsSign: p.needsSign,
    late: p.late,
    incomplete: p.incomplete,
    source: orNone(p.source),
    digest: low(p.digest),
    postedAt: t,
    finalAt: p.needsSign ? undefined : t + BigInt(tPend),
    attestedAt: undefined,
    attestedBy: undefined,
    replaced: false,
    state: p.needsSign ? "NEEDS_SIGN" : "PENDING",
  }));
});

indexer.onEvent({ contract: "AgateIndex", event: "Attested" }, async ({ event, context }) => {
  seen(event, context);
  const p = event.params;
  await onFix(context, event, p.gpuId, p.day, "Attested", { by: p.by, source: p.source }, (f, t) => ({
    ...f,
    finalAt: p.finalAt,
    attestedAt: t,
    attestedBy: low(p.by),
    state: "PENDING",
  }));
});

// The attester's select: final at max(postedAt + tPend, now) (MS 8.6).
indexer.onEvent({ contract: "AgateIndex", event: "RecordReplaced" }, async ({ event, context }) => {
  seen(event, context);
  const p = event.params;
  await onFix(context, event, p.gpuId, p.day, "RecordReplaced", { value: p.newValue, by: p.by, source: p.newSource }, (f, t, tPend) => {
    const due = (f.postedAt ?? t) + BigInt(tPend);
    return {
      ...f,
      value: p.newValue,
      source: orNone(p.newSource),
      digest: low(p.newDigest),
      replaced: true,
      attestedAt: t,
      attestedBy: low(p.by),
      finalAt: due > t ? due : t,
      state: "PENDING",
    };
  });
});

indexer.onEvent({ contract: "AgateIndex", event: "Vetoed" }, async ({ event, context }) => {
  seen(event, context);
  const p = event.params;
  await onFix(context, event, p.gpuId, p.day, "Vetoed", { value: p.value, by: p.by, source: p.source }, (f) => ({
    ...f,
    state: "VETOED",
    finalAt: undefined,
    vetoed: true,
    vetoCount: f.vetoCount + 1,
  }));
});

indexer.onEvent({ contract: "AgateIndex", event: "FixDropped" }, async ({ event, context }) => {
  seen(event, context);
  const p = event.params;
  await onFix(context, event, p.gpuId, p.day, "FixDropped", { value: p.value, source: p.source }, (f) => ({
    ...f,
    state: "DROPPED",
    finalAt: undefined,
    dropped: true,
  }));
});

// Final at once; "carried, unverified" when a record of that day was dropped or vetoed (Oct 2 14:04).
indexer.onEvent({ contract: "AgateIndex", event: "DayCarried" }, async ({ event, context }) => {
  seen(event, context);
  const p = event.params;
  await onFix(context, event, p.gpuId, p.day, "DayCarried", { value: p.value }, (f, t) => {
    const dropped = f.dropped || p.dropped;
    return {
      ...f,
      // the carried record is a new one (IndexDays.carry): only value, status, times and dropped are set
      value: p.value,
      status: "CARRIED",
      fresh: 0,
      held: 0,
      freshMedian: 0n,
      changed: false,
      needsSign: false,
      late: false,
      incomplete: false,
      source: undefined,
      digest: undefined,
      attestedAt: undefined,
      attestedBy: undefined,
      postedAt: t,
      finalAt: t,
      dropped,
      state: dropped || f.vetoed ? "CARRIED_UNVERIFIED" : "CARRIED",
    };
  });
});

indexer.onEvent({ contract: "AgateIndex", event: "DaySkipped" }, async ({ event, context }) => {
  seen(event, context);
  const p = event.params;
  // a skipped day has no record: a dropped or vetoed record's figures are cleared (audit L-1); dropped and vetoed stay
  await onFix(context, event, p.gpuId, p.day, "DaySkipped", {}, (f) => ({ ...f, value: 0n, status: "NONE", needsSign: false, state: "SKIPPED", finalAt: undefined }));
});

indexer.onEvent({ contract: "AgateIndex", event: "WriterSuspended" }, async ({ event, context }) => {
  seen(event, context);
  const ix = await priceIndex(context, event.srcAddress);
  if (!ix) return;
  const t = BigInt(event.block.timestamp);
  await account(context, event.params.by, t);
  await account(context, event.params.writer, t);
  context.WriterSuspension.set({
    id: eventId(event.block.number, event.logIndex),
    index_id: ix.id,
    writer: low(event.params.writer),
    by: low(event.params.by),
    timestamp: t,
  });
});

type Action = { kind: bigint; slot: bigint; addr: string; gpuId: string; day: bigint; mode: bigint };

/** OwnerAction.day is Int (Postgres integer). A LIVE_UNTIL day is bounded only from below by IndexAdmin, so the owner
 *  can queue NEVER (2^32 - 1) or any far day: stored as INT32_MAX (read: "beyond 2^31 - 1, see the action on chain"),
 *  so a write never fails and halts the indexer (audit M-3). The action id is keccak256 of the whole action. */
export const INT32_MAX = 2_147_483_647;
export function actionDay(day: bigint): number {
  return day > BigInt(INT32_MAX) ? INT32_MAX : Number(day);
}

async function action(context: Ctx, ev: Meta, id: string, a: Action | undefined, change: (o: Entity<"OwnerAction">, t: bigint) => Entity<"OwnerAction">) {
  const ix = await priceIndex(context, ev.srcAddress);
  if (!ix) return;
  const t = BigInt(ev.block.timestamp);
  if (a) await account(context, a.addr, t);
  const key = pairId(ix.id, id);
  const cur = await context.OwnerAction.get(key);
  const base: Entity<"OwnerAction"> = cur ?? {
    id: key,
    index_id: ix.id,
    actionId: low(id),
    kind: Number(a?.kind ?? 0n),
    slot: Number(a?.slot ?? 0n),
    addr: low(a?.addr ?? "0x0000000000000000000000000000000000000000"),
    gpuId: low(a?.gpuId ?? `0x${"0".repeat(64)}`),
    day: actionDay(a?.day ?? 0n),
    mode: Number(a?.mode ?? 0n),
    eta: undefined,
    status: "QUEUED",
    queuedAt: undefined,
    executedAt: undefined,
    cancelledAt: undefined,
  };
  context.OwnerAction.set(change(base, t));
}

indexer.onEvent({ contract: "AgateIndex", event: "ActionQueued" }, async ({ event, context }) => {
  seen(event, context);
  const p = event.params;
  // a queued action past its window may be queued afresh under the same id: the row restarts
  await action(context, event, p.id, p.action, (o, t) => ({ ...o, eta: p.eta, status: "QUEUED", queuedAt: t, executedAt: undefined, cancelledAt: undefined }));
});

indexer.onEvent({ contract: "AgateIndex", event: "ActionExecuted" }, async ({ event, context }) => {
  seen(event, context);
  await action(context, event, event.params.id, event.params.action, (o, t) => ({ ...o, status: "EXECUTED", executedAt: t }));
});

indexer.onEvent({ contract: "AgateIndex", event: "ActionCancelled" }, async ({ event, context }) => {
  seen(event, context);
  await action(context, event, event.params.id, undefined, (o, t) => ({ ...o, status: "CANCELLED", cancelledAt: t }));
});

async function swap(
  context: Ctx,
  ev: Meta,
  id: string,
  gpuId: string,
  slot: bigint,
  change: (o: Entity<"ReaderSwap">, t: bigint) => Entity<"ReaderSwap">,
) {
  const ix = await priceIndex(context, ev.srcAddress);
  if (!ix) return;
  const t = BigInt(ev.block.timestamp);
  const key = pairId(ix.id, id);
  const cur = await context.ReaderSwap.get(key);
  const base: Entity<"ReaderSwap"> = cur ?? {
    id: key,
    index_id: ix.id,
    swapId: low(id),
    gpuId: low(gpuId),
    slot: Number(slot),
    url: "",
    parserVersion: "",
    reason: "",
    eta: undefined,
    fromDay: undefined,
    readerHash: undefined,
    status: "QUEUED",
    queuedAt: undefined,
    executedAt: undefined,
    cancelledAt: undefined,
  };
  context.ReaderSwap.set(change(base, t));
}

indexer.onEvent({ contract: "AgateIndex", event: "ReaderSwapQueued" }, async ({ event, context }) => {
  seen(event, context);
  const p = event.params;
  await swap(context, event, p.id, p.gpuId, p.slot, (o, t) => ({
    ...o,
    url: p.url,
    parserVersion: p.parserVersion,
    reason: p.reason,
    eta: p.eta,
    status: "QUEUED",
    queuedAt: t,
    executedAt: undefined,
    cancelledAt: undefined,
  }));
});

indexer.onEvent({ contract: "AgateIndex", event: "ReaderSwapped" }, async ({ event, context }) => {
  seen(event, context);
  const p = event.params;
  await swap(context, event, p.id, p.gpuId, p.slot, (o, t) => ({
    ...o,
    url: p.url,
    parserVersion: p.parserVersion,
    reason: p.reason,
    fromDay: Number(p.fromDay),
    readerHash: low(p.readerHash),
    status: "EXECUTED",
    executedAt: t,
  }));
});

indexer.onEvent({ contract: "AgateIndex", event: "ReaderSwapCancelled" }, async ({ event, context }) => {
  seen(event, context);
  const p = event.params;
  await swap(context, event, p.id, p.gpuId, p.slot, (o, t) => ({ ...o, status: "CANCELLED", cancelledAt: t }));
});
