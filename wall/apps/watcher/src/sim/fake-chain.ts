// The in-memory index behind the chain interfaces: views, events and senders over a ModelIndex, with an injected
// clock. Used by the harness, the loop tests and the guardian CLI tests.
import type { Address, Clocks, GpuConfig, Hex, Readings, SlotState } from "@agate/report/types";
import { NEVER } from "@agate/report/types";
import type { CallName, Detail, EventSource, IndexView, Sender, SendResult, WallEvent } from "../chain/types.ts";
import { evKey } from "../chain/types.ts";
import type { Computed } from "../formula.ts";
import { emptyRecord, type ModelIndex, Revert } from "./model-index.ts";

function detailOf(c: Computed | null): Detail {
  if (!c) return { rec: emptyRecord(), p: [], kinds: [], counts: [], post: [] };
  return {
    rec: {
      ...emptyRecord(),
      value: c.value, status: c.status, fresh: c.fresh, quorum: c.quorum, held: c.held, freshMedian: c.freshMedian, late: c.late,
      incomplete: c.incomplete, changed: c.changed, needsSign: c.needsSign, source: c.source, postedAt: BigInt(c.postedAt),
      finalAt: BigInt(c.finalAt), digest: c.digest,
    },
    p: c.p, kinds: c.kinds, counts: c.counts, post: c.post,
  };
}

export class FakeChain implements IndexView, EventSource {
  readonly address: Address;
  /** Make every call fail (an RPC outage) while true. */
  down = false;
  balances = new Map<string, bigint>();

  constructor(
    readonly m: ModelIndex,
    readonly now: () => number,
  ) {
    this.address = m.address;
  }
  private up() {
    if (this.down) throw new Error("rpc down");
  }
  async blockTime() { this.up(); return this.now(); }
  async clocks(): Promise<Clocks> { this.up(); return this.m.clocks; }
  async gpu(g: Hex): Promise<GpuConfig> {
    this.up();
    const x = this.m.gpus.get(g.toLowerCase());
    if (!x) return { recipeHash: `0x${"00".repeat(32)}`, nSlots: 0, nFamilies: 0, firstDay: 0, registeredAt: 0n, lastCarryAt: 0n, head: 0 };
    return { recipeHash: `0x${"11".repeat(32)}`, nSlots: x.nSlots, nFamilies: x.famQ.length, firstDay: x.firstDay, registeredAt: BigInt(x.registeredAt), lastCarryAt: BigInt(x.lastCarryAt), head: x.head };
  }
  async head(g: Hex) { this.up(); return this.m.g(g).head; }
  async record(g: Hex, d: number) { this.up(); return this.m.record(g, d, this.now()); }
  async slotStates(g: Hex): Promise<{ base: SlotState[]; last: SlotState[] }> {
    this.up();
    const x = this.m.g(g);
    return { base: x.base.map((s) => ({ ...s })), last: x.last.map((s) => ({ ...s })) };
  }
  async slotWindow(g: Hex, i: number) { this.up(); const x = this.m.g(g); return { liveFrom: x.liveFrom[i] ?? NEVER, liveUntil: x.liveUntil[i] ?? NEVER }; }
  async familyOf(g: Hex, i: number) { this.up(); const x = this.m.g(g); return { family: x.family[i]!, famQ: x.famQ[x.family[i]!]! }; }
  async readings(g: Hex, d: number, w: Address): Promise<Readings> { this.up(); return this.m.readings(g, d, w); }
  async previewRecord(g: Hex, d: number, w: Address) { this.up(); const r = this.m.previewRecord(g, d, w, this.now()); return { ok: r.ok, detail: detailOf(r.detail) }; }
  async previewFix(g: Hex) {
    this.up();
    const x = this.m.g(g);
    const src = this.m.source(x, x.head, this.now());
    if (!src) return { ok: false, detail: detailOf(null) };
    return { ok: true, detail: detailOf(this.m.compute(x, x.head, src, x.last, this.now())) };
  }
  async writers() { this.up(); return this.m.writers; }
  async attester() { this.up(); return this.m.attester; }
  async guardians() { this.up(); return this.m.guardians; }
  async isSuspended(w: Address) { this.up(); return this.m.suspended.has(w.toLowerCase()); }
  async isVoided(g: Hex, d: number, w: Address) { this.up(); return this.m.g(g).voided.has(`${d}:${w.toLowerCase()}`); }
  async reopenedAt(g: Hex, d: number) { this.up(); return this.m.g(g).reopenedAt.get(d) ?? 0; }
  async firstRecordDay(g: Hex) { this.up(); const f = this.m.g(g).firstRecordDay; return { exists: f !== null, day: f ?? 0 }; }
  async balance(a: Address) { this.up(); return this.balances.get(a.toLowerCase()) ?? 100n * 10n ** 18n; }

  // ------------------------------------------------------------------ events
  async sync() { this.up(); }
  private cache: { n: number; out: WallEvent[] } = { n: 0, out: [] };
  all(): readonly WallEvent[] {
    const evs = this.m.events;
    if (this.cache.n === evs.length) return this.cache.out;
    for (let j = this.cache.n; j < evs.length; j++) {
      const e = evs[j]!;
      this.cache.out.push({ key: evKey(e.seq, 0), gpuId: e.gpuId, day: e.day, name: e.name, ...e.args } as unknown as WallEvent);
    }
    this.cache.n = evs.length;
    return this.cache.out;
  }

  /** A sender acting as `from` (the model checks every role). */
  sender(from: Address): Sender & { calls: { fn: CallName; args: readonly unknown[]; at: number; ok: boolean; error?: string }[] } {
    const self = this;
    const calls: { fn: CallName; args: readonly unknown[]; at: number; ok: boolean; error?: string }[] = [];
    const run = (fn: CallName, args: readonly unknown[], dry: boolean): SendResult => {
      if (self.down) return { ok: false, sent: false, error: "rpc down" };
      const now = self.now();
      try {
        const m = self.m;
        if (dry) {
          // run on a structural copy so a dry run never mutates
          const snap = snapshot(m, fn === "suspend" ? null : String(args[0]));
          try {
            applyCall(m, fn, args, from, now);
          } finally {
            restore(m, snap);
          }
          return { ok: true, sent: false };
        }
        applyCall(m, fn, args, from, now);
        calls.push({ fn, args, at: now, ok: true });
        return { ok: true, sent: true, txHash: `0x${String(calls.length).padStart(64, "0")}` };
      } catch (e) {
        if (!(e instanceof Revert)) throw e;
        if (!dry) calls.push({ fn, args, at: now, ok: false, error: e.message });
        return { ok: false, sent: false, error: e.message };
      }
    };
    return {
      from,
      calls,
      send: async (fn, args) => run(fn, args, false),
      simulate: async (fn, args) => {
        const r = run(fn, args, true);
        return r.ok ? { ok: true } : { ok: false, error: r.error ?? "" };
      },
    };
  }
}

function applyCall(m: ModelIndex, fn: CallName, args: readonly unknown[], from: Address, now: number): void {
  const a = args as never[];
  if (fn === "attest") m.attest(a[0], Number(a[1]), a[2], a[3], from, now);
  else if (fn === "closeDay") m.closeDay(a[0], from, now);
  else if (fn === "carryDay") m.carryDay(a[0], from, now);
  else if (fn === "veto") m.veto(a[0], Number(a[1]), a[2], a[3], from, now);
  else m.suspend(a[0], from, now);
}

function snapshot(m: ModelIndex, gpuId: string | null): unknown {
  const k = gpuId?.toLowerCase() ?? null;
  return {
    k,
    gpu: k && m.gpus.has(k) ? structuredClone(m.gpus.get(k)) : null,
    suspended: [...m.suspended],
    events: m.events.length,
  };
}
function restore(m: ModelIndex, s: unknown): void {
  const x = s as { k: string | null; gpu: unknown; suspended: string[]; events: number };
  if (x.k && x.gpu) m.gpus.set(x.k, x.gpu as never);
  m.suspended.clear();
  for (const w of x.suspended) m.suspended.add(w);
  m.events.length = x.events;
}
