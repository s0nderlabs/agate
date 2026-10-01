// Launch backfill (8.4): post a writer's logged readings for days from firstDay on, with their original readAt,
// within GRACE (one DAY, "24 h", v4.3) of registration. The only path allowed to send a day after it ended.
import type { Entry, Hex } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import { type Clock, dayIdAt, reportHex } from "../core/index.ts";
import type { IndexChain } from "./chain.ts";
import type { ReadingLog, Role } from "./log.ts";

export interface BackfillResult {
  posted: { dayId: number; slice: number; gpuIds: Hex[]; ok: boolean; txHash?: Hex; error?: string }[];
  skipped: string[];
}

export async function backfill(o: {
  chain: IndexChain;
  clock: Clock;
  chainSelector: bigint;
  panels: readonly Panel[];
  log: ReadingLog;
  role: Role;
  now: number;
  dryRun?: boolean;
}): Promise<BackfillResult> {
  const { chain, clock, log } = o;
  const out: BackfillResult = { posted: [], skipped: [] };
  const today = dayIdAt(clock, o.now);
  const heads = new Map<Hex, number>();
  const until = new Map<Hex, number>();
  let from = Infinity;
  for (const p of o.panels) {
    const g = p.gpuId as Hex;
    const cfg = await chain.gpu(g);
    if (Number(cfg.nSlots) === 0) {
      out.skipped.push(`${p.gpu}: not registered`);
      continue;
    }
    const end = Number(cfg.registeredAt) + clock.grace;
    if (o.now >= end) {
      out.skipped.push(`${p.gpu}: registered more than GRACE (${clock.grace} s) ago, no backfill`);
      continue;
    }
    const head = await chain.head(g);
    heads.set(g, head);
    until.set(g, end);
    from = Math.min(from, Math.max(head, Number(cfg.firstDay)));
  }
  for (let d = from; d <= today; d++) {
    const logged = log.entriesOf(chain.index, clock, d);
    const bits = new Map<Hex, bigint>();
    for (const g of heads.keys()) bits.set(g, BigInt((await chain.readings(g, d, chain.writer)).sliceBits));
    for (const [h, byGpu] of [...logged].sort((a, b) => a[0] - b[0])) {
      const missing: Entry[] = [];
      for (const [g, e] of byGpu) {
        const head = heads.get(g);
        if (head === undefined || d < head) continue;
        if (((bits.get(g) ?? 0n) >> BigInt(h)) & 1n) continue;
        if (chain.inFlight().has(`${g}:${d}:${h}`)) continue;
        missing.push(e);
      }
      if (missing.length === 0) continue;
      const gpuIds = missing.map((e) => e.gpuId);
      if (o.dryRun) {
        out.posted.push({ dayId: d, slice: h, gpuIds, ok: false, error: "dry run" });
        continue;
      }
      const deadline = Math.min(...gpuIds.map((g) => until.get(g)!));
      const r = await chain.postReport(reportHex(o.chainSelector, chain.index, missing), { action: "backfill", tags: gpuIds.map((g) => `${g}:${d}:${h}`), deadline, dayId: d, slice: h });
      log.append({
        kind: "send",
        index: chain.index,
        role: o.role,
        at: o.now,
        action: "backfill",
        dayId: d,
        slice: h,
        gpuIds,
        ok: r.ok,
        sent: r.sent,
        ...(r.pending ? { pending: true } : {}),
        ...(r.txHash ? { txHash: r.txHash } : {}),
        ...(r.error ? { error: r.error } : {}),
      });
      out.posted.push({ dayId: d, slice: h, gpuIds, ok: r.ok, ...(r.txHash ? { txHash: r.txHash } : {}), ...(r.error ? { error: r.error } : {}) });
    }
  }
  return out;
}
