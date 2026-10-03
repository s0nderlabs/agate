// Fixes found by the phase 2b integration run (wall/e2e reader-swap and owner-action-expired), on the fake index:
// an attester restarted after a reader swap was queued still announces it (9.4); two swaps of one slot raise two
// alerts and the execute of one clears only its own (8.6: one alert per swap id); a swap that expires unexecuted
// leaves no install reminder open.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import { AlertCode } from "@agate/report/types";
import { AlertSink } from "../src/alerts.ts";
import { Attester, readAnnounced } from "../src/attester.ts";
import { ACTION_WINDOW_DAYS } from "../src/chain/owner.ts";
import type { EventSource, WallEvent } from "../src/chain/types.ts";
import { ATTESTER, Pages, World } from "../src/sim/world.ts";

const OCT1 = 20_727;
const T = 2_400;
const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];

/** An event store as the EventIndexer keeps it: what a previous process synced is on disk at start. */
class DiskStore implements EventSource {
  private evs: WallEvent[];
  constructor(
    private readonly src: { all(): readonly WallEvent[] },
    onDisk: number,
  ) {
    this.evs = src.all().slice(0, onDisk);
  }
  all(): readonly WallEvent[] {
    return this.evs;
  }
  async sync(): Promise<void> {
    this.evs = [...this.src.all()];
  }
}

const world = () => new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1" }], attester: false, guardian: null });
const attester = (w: World, alerts: AlertSink, events: EventSource, check: (v: string) => "ok" | "missing" | "refused" = () => "missing", announcedPath?: string) =>
  new Attester({ view: w.chain, events, log: w.log, alerts, sender: w.chain.sender(ATTESTER), clock: w.c, panels: [w.panel], decisionsPath: null, tickS: 10, readerCheck: (_s, r) => check(r.parserVersion), ...(announcedPath ? { announcedPath } : {}) });
const swapAlerts = (a: AlertSink) => a.open().filter((x) => x.code === AlertCode.ONCHAIN_EVENT && x.severity === "action");

describe("integration fixes (phase 2b)", () => {
  test("a swap queued while no attester ran is announced by the next attester process (events on disk from the last one)", async () => {
    const w = world();
    await w.run(w.now + 2 * T); // some history: posts and closes
    const alerts = new AlertSink(null, { now: () => w.now, print: false });
    const first = attester(w, alerts, new DiskStore(w.chain, 0));
    await first.tick(w.now);
    const onDisk = w.chain.all().length; // what the first process synced and announced
    expect(onDisk).toBeGreaterThan(0);
    const id = w.m.queueReaderSwap(w.panel.gpuId, 2, "https://s2.example/v2", "s2/2", "queued while the attester was down", w.now + 5);
    // a new process: the disk holds the old events, its first sync brings the queue
    const second = attester(w, alerts, new DiskStore(w.chain, onDisk));
    await second.tick(w.now + 10);
    expect(swapAlerts(alerts).map((a) => (a.data as { id?: string }).id)).toEqual([id]);
    expect(alerts.open().filter((a) => a.code === AlertCode.READER_MISSING).length).toBe(1);
  });

  test("a swap the guardian CLI synced to the shared store while no attester ran is still announced (announcedPath, not the store, says what was announced)", async () => {
    const w = world();
    await w.run(w.now + 2 * T);
    const path = join(mkdtempSync(join(tmpdir(), "agate-announced-")), "announced.json");
    const alerts = new AlertSink(null, { now: () => w.now, print: false });
    await attester(w, alerts, new DiskStore(w.chain, 0), undefined, path).tick(w.now);
    const saved = readAnnounced(path);
    expect(saved).not.toBeNull();
    const id = w.m.queueReaderSwap(w.panel.gpuId, 2, "https://s2.example/v2", "s2/2", "queued while the attester was down", w.now + 5);
    // `guardian status` ran meanwhile: the shared events.jsonl already holds the queue when the attester restarts
    const second = attester(w, alerts, new DiskStore(w.chain, w.chain.all().length), undefined, path);
    await second.tick(w.now + 10);
    expect(swapAlerts(alerts).map((a) => (a.data as { id?: string }).id)).toEqual([id]);
    expect(alerts.open().filter((a) => a.code === AlertCode.READER_MISSING).length).toBe(1);
    expect(readAnnounced(path)! > saved!).toBe(true);
    // a third start announces nothing twice (a fresh sink would show any repeat)
    const fresh = new AlertSink(null, { now: () => w.now, print: false });
    await attester(w, fresh, new DiskStore(w.chain, w.chain.all().length), undefined, path).tick(w.now + 20);
    expect(swapAlerts(fresh)).toEqual([]);
    expect(fresh.open().filter((a) => a.code === AlertCode.READER_MISSING)).toEqual([]);
  });

  test("owner actions keep one info alert per action id: another action's queue or cancel never overwrites a queued change (9.4)", async () => {
    const w = world();
    const alerts = new AlertSink(null, { now: () => w.now, print: false });
    const att = attester(w, alerts, w.chain);
    await att.tick(w.now);
    const a = { kind: 0, slot: 1, addr: "0x00000000000000000000000000000000000000b1" as Address, gpuId: `0x${"00".repeat(32)}` as Hex, day: 0, mode: 0 };
    const b = { ...a, addr: "0x00000000000000000000000000000000000000b2" as Address };
    w.m.queueAction(a, w.now);
    w.m.queueAction(b, w.now);
    w.m.cancelAction(b, w.now + 5);
    await att.tick(w.now + 10);
    const infos = alerts.open().filter((x) => x.code === AlertCode.ONCHAIN_EVENT && x.severity === "info" && /^Action(Queued|Cancelled) /.test(x.message));
    expect(infos.length).toBe(2); // one per action, its newest event
    expect(infos.filter((x) => x.message.startsWith("ActionQueued")).map((x) => x.message.includes(a.addr))).toEqual([true]); // a's queue, not hidden by b's
    expect(infos.filter((x) => x.message.startsWith("ActionCancelled")).length).toBe(1);
  });

  test("a first start (nothing on disk) announces no history", async () => {
    const w = world();
    w.m.queueReaderSwap(w.panel.gpuId, 2, "https://s2.example/v2", "s2/2", "before any attester", w.now);
    const alerts = new AlertSink(null, { now: () => w.now, print: false });
    await attester(w, alerts, new DiskStore(w.chain, 0)).tick(w.now + 10);
    expect(swapAlerts(alerts)).toEqual([]);
  });

  test("two swaps of one slot: one action alert and one READER_MISSING each; executing one clears only its own", async () => {
    const w = world();
    const alerts = new AlertSink(null, { now: () => w.now, print: false });
    const att = attester(w, alerts, w.chain);
    await att.tick(w.now);
    const a = w.m.queueReaderSwap(w.panel.gpuId, 2, "https://s2.example/v2", "s2/2", "the real one", w.now);
    const b = w.m.queueReaderSwap(w.panel.gpuId, 2, "https://s2.example/v2?x=1", "s2/2", "a second one", w.now);
    await att.tick(w.now + 1);
    expect(swapAlerts(alerts).map((x) => (x.data as { id?: string }).id).sort()).toEqual([a, b].sort());
    expect(alerts.open().filter((x) => x.code === AlertCode.READER_MISSING).map((x) => (x.data as { id?: string }).id).sort()).toEqual([a, b].sort());
    w.m.executeReaderSwap(w.panel.gpuId, 2, "https://s2.example/v2", "s2/2", w.now + w.c.timelock);
    await att.tick(w.now + w.c.timelock + 1);
    expect(swapAlerts(alerts).map((x) => (x.data as { id?: string }).id)).toEqual([b]);
  });

  test("a swap that expires unexecuted leaves no READER_MISSING open", async () => {
    const w = world();
    const alerts = new AlertSink(null, { now: () => w.now, print: false });
    const att = attester(w, alerts, w.chain);
    await att.tick(w.now);
    const id = w.m.queueReaderSwap(w.panel.gpuId, 1, "https://s1.example/v2", "s1/2", "never executed", w.now);
    await att.tick(w.now + 1);
    expect(alerts.open().filter((x) => x.code === AlertCode.READER_MISSING).length).toBe(1);
    await att.tick(w.now + w.c.timelock + ACTION_WINDOW_DAYS * T + 5);
    expect(alerts.open().filter((x) => x.code === AlertCode.READER_MISSING || (x.code === AlertCode.ONCHAIN_EVENT && x.severity === "action"))).toEqual([]);
    expect(alerts.open().some((x) => (x.data as { id?: string; expired?: boolean } | undefined)?.id === id && (x.data as { expired?: boolean }).expired)).toBe(true);
  });
});
