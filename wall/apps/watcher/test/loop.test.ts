// The attester and keeper loops against the fake index (BUILD-SPEC 9.2, 9.3, 13.4): the formula self-check refuses
// to act on a chain that differs from formula.ts, a restart is idempotent, an RPC outage is survived.
import { describe, expect, test } from "bun:test";
import { AlertCode } from "@agate/report/types";
import { AlertSink } from "../src/alerts.ts";
import { Attester } from "../src/attester.ts";
import { Keeper } from "../src/keeper.ts";
import { ATTESTER, KEEPER, Pages, World } from "../src/sim/world.ts";

const OCT1 = 20_727;
const T = 2_400;
const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];

async function pendingChanged() {
  const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: (OCT1 + 2) * T, v: b + 600_000 })));
  const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1" }, { net: "w2" }], attester: { down: (t) => t >= (OCT1 + 2) * T }, guardian: null });
  await w.run((OCT1 + 3) * T + 500); // past the settle point (k(d,11) + 1 + GAP ends 400 s after the day)
  const g = w.m.g(w.panel.gpuId);
  const d = g.head - 1;
  return { w, g, d };
}

function freshAttester(w: World, alerts = new AlertSink(null, { now: () => w.now, print: false })) {
  return {
    alerts,
    a: new Attester({ view: w.chain, events: w.chain, log: w.log, alerts, sender: w.chain.sender(ATTESTER), clock: w.c, panels: [w.panel], decisionsPath: null, tickS: 10 }),
  };
}

describe("attester loop", () => {
  test("signs a settled changed record once; a restarted attester sends nothing twice", async () => {
    const { w, g, d } = await pendingChanged();
    expect(g.records.get(d)!.needsSign).toBe(true);
    const { a } = freshAttester(w);
    await a.tick(w.now);
    expect(g.records.get(d)!.attestedBy).toBe(ATTESTER);
    const { a: b } = freshAttester(w);
    await b.tick(w.now + 10);
    expect(b.decisions).toEqual([]);
  });

  test("refuses when previewRecord differs from the offchain formula (9.2)", async () => {
    const { w, g, d } = await pendingChanged();
    const r = g.records.get(d)!;
    r.digest = `0x${"ab".repeat(32)}`; // the chain now disagrees with every recomputation
    const { a, alerts } = freshAttester(w);
    await a.tick(w.now);
    expect(r.attestedAt).toBe(0);
    expect(alerts.all().some((x) => x.code === AlertCode.R1_NO_CANDIDATE && x.message.includes("refuses"))).toBe(true);
  });

  test("refuses when slotStates differ from the post-state rebuilt from events", async () => {
    const { w, g, d } = await pendingChanged();
    g.last = g.last.map((x, i) => (i === 0 ? { ...x, e: 1_230_000 } : x));
    const { a, alerts } = freshAttester(w);
    await a.tick(w.now);
    expect(g.records.get(d)!.attestedAt).toBe(0);
    expect(alerts.all().some((x) => x.code === AlertCode.R1_NO_CANDIDATE && x.message.includes("slotStates"))).toBe(true);
  });

  test("an RPC outage is survived: no throw, no action; it acts once the chain answers", async () => {
    const { w, g, d } = await pendingChanged();
    const { a } = freshAttester(w);
    w.chain.down = true;
    await a.tick(w.now);
    expect(g.records.get(d)!.attestedAt).toBe(0);
    w.chain.down = false;
    await a.tick(w.now + 10);
    expect(g.records.get(d)!.attestedBy).toBe(ATTESTER);
  });
});

describe("keeper loop", () => {
  test("closes a complete day, carries a no-data day at GRACE, never sends what eth_call refuses", async () => {
    const pages = new Pages(BASE);
    const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1", close: "never", skip: (d) => d === OCT1 + 2 }], keeper: false, guardian: null });
    await w.run((OCT1 + 1) * T + 10);
    const k = new Keeper({ view: w.chain, sender: w.chain.sender(KEEPER), clock: w.c, gpuIds: [w.panel.gpuId], tickS: 10 });
    await k.tick(w.now);
    expect(w.m.g(w.panel.gpuId).head).toBe(OCT1); // incomplete source? no: complete, but C1 not reached yet
    await w.run((OCT1 + 1) * T + w.c.closeGrace + 10);
    await k.tick(w.now);
    expect(w.m.g(w.panel.gpuId).head).toBe(OCT1 + 1);
    expect(k.sent.at(-1)).toMatchObject({ fn: "closeDay", ok: true });
    // day OCT1+2 has no data: carried at graceStart + GRACE
    for (let t = w.now; t < (OCT1 + 5) * T; t += 20) {
      await w.run(t);
      await k.tick(t);
    }
    const r = w.m.g(w.panel.gpuId).records.get(OCT1 + 2)!;
    expect(r.carried).toBe(true);
    expect(r.postedAt).toBeGreaterThanOrEqual((OCT1 + 3) * T + w.c.grace);
    expect(k.sent.every((s) => s.ok || s.error !== undefined)).toBe(true);
    expect(w.chain.sender(KEEPER).calls.filter((c) => !c.ok)).toEqual([]);
  });
});

describe("LV-3: the keeper never races the attester's signature", () => {
  async function droppable() {
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: (OCT1 + 2) * T, v: b + 600_000 })));
    const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1" }, { net: "w2" }], attester: { down: (t) => t >= (OCT1 + 2) * T }, keeper: false, guardian: null });
    await w.run((OCT1 + 3) * T + 500);
    const g = w.m.g(w.panel.gpuId);
    const d = g.head - 1;
    expect(g.records.get(d)!.needsSign).toBe(true);
    await w.run((OCT1 + 3) * T + w.c.holdMove + w.c.slice); // the case-1 time has come
    return { w, g, d };
  }

  /** ticks the keeper every 10 s (its period here) from w.now to `until` */
  async function tickTo(w: World, k: Keeper, until: number) {
    for (; w.now <= until; w.now += 10) await k.tick(w.now);
    w.now -= 10;
  }

  test("no case-1 drop within one slice of the keeper's wake; the drop follows after it", async () => {
    const { w, g, d } = await droppable();
    const k = new Keeper({ view: w.chain, sender: w.chain.sender(KEEPER), clock: w.c, gpuIds: [w.panel.gpuId], tickS: 10 });
    const woke = w.now;
    await tickTo(w, k, woke + w.c.slice - 10); // a start counts as a wake
    expect(g.records.get(d)!.carried).toBe(false);
    await tickTo(w, k, woke + w.c.slice + 30);
    expect(g.records.get(d)!.dropped).toBe(true);
  });

  test("no drop while the attester's pick for that record is fresh; a stale pick does not hold it", async () => {
    const { w, g, d } = await droppable();
    const r = g.records.get(d)!;
    const k = new Keeper({ view: w.chain, sender: w.chain.sender(KEEPER), clock: w.c, gpuIds: [w.panel.gpuId], tickS: 10, attesterPick: () => ({ day: d, digest: r.digest, at: noted }) });
    let noted = w.now;
    const t0 = w.now;
    for (; w.now <= t0 + 3 * w.c.slice; w.now += 10) {
      noted = w.now - 5; // the attester notes its pick every interval while it tries to send
      await k.tick(w.now);
    }
    expect(g.records.get(d)!.carried).toBe(false);
    // the attester stopped noting it: once the note is two slices old the keeper drops
    await tickTo(w, k, noted + 2 * w.c.slice + 30);
    expect(g.records.get(d)!.dropped).toBe(true);
  });

  test("an attester with a pick it cannot send raises RPC_DOWN for that record (action, GUARD_ACT)", async () => {
    const { w, g, d } = await pendingChanged();
    const alerts = new AlertSink(null, { now: () => w.now, print: false });
    const real = w.chain.sender(ATTESTER);
    const sender = { from: real.from, simulate: real.simulate.bind(real), send: async () => ({ ok: false, sent: false, error: "every RPC URL failed: timeout" }) };
    const a = new Attester({ view: w.chain, events: w.chain, log: w.log, alerts, sender, clock: w.c, panels: [w.panel], decisionsPath: null, tickS: 10 });
    await a.tick(w.now);
    expect(g.records.get(d)!.attestedAt).toBe(0);
    const x = alerts.all().find((y) => y.code === AlertCode.RPC_DOWN && y.day === d);
    expect(x?.severity).toBe("action");
    expect(x?.deadline).toBe(w.now + w.c.guardAct);
  });
});
