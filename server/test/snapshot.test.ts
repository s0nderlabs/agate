import { describe, expect, test } from "bun:test";
import { type AgateClient, GPUS, snapshotOf } from "@agate/client";
import { publicApp } from "../src/app.ts";
import { snapshotCache } from "../src/snapshot.ts";
import { Store } from "../src/store.ts";

const INDEX = "0x4193000000000000000000000000000000000000";
const markets = () => GPUS.map((gpu) => ({ gpu, price: 4, series: [], history: [] }));
const books = { "H100 2026-11": { asks: [], bids: [], spread: 0 } };

/** A client whose marketsAndBooks is counted and can be held or made to fail. */
function client(o: { fail?: () => boolean; hold?: () => Promise<void> } = {}) {
  let reads = 0;
  const c = {
    chain: { id: 10143 },
    index: INDEX,
    marketsAndBooks: async () => {
      reads++;
      await o.hold?.();
      if (o.fail?.()) throw new Error("rpc down");
      return { markets: markets(), books };
    },
  } as unknown as AgateClient;
  return { c: () => c, reads: () => reads };
}

describe("the markets snapshot cache", () => {
  test("the first ask reads; a fresh one is served without reading again; the answer passes the client's check", async () => {
    let t = 1_000_000;
    const k = client();
    const cache = snapshotCache(k.c, { now: () => t, warmEveryMs: 3_600_000 });
    const a = await cache.get();
    t += 2_000;
    const b = await cache.get();
    expect(k.reads()).toBe(1);
    expect(b!.ageMs).toBe(2_000);
    expect(snapshotOf(JSON.parse(JSON.stringify(b)), 10143, INDEX)).not.toBeNull();
    expect(a!.readAt).toBe(new Date(1_000_000).toISOString());
    cache.stop();
  });

  test("an older one is served at once while one read refreshes it in the background", async () => {
    let t = 1_000_000;
    let release!: () => void;
    let held = false;
    const k = client({ hold: () => (held ? new Promise((ok) => (release = ok)) : Promise.resolve()) });
    const cache = snapshotCache(k.c, { now: () => t, warmEveryMs: 3_600_000 });
    await cache.get();
    held = true;
    t += 6_000;
    const stale = await cache.get();
    const again = await cache.get();
    expect(stale!.ageMs).toBe(6_000);
    expect(again!.ageMs).toBe(6_000);
    expect(k.reads()).toBe(2); // one background read for both asks
    release();
    await new Promise((ok) => setTimeout(ok, 0));
    const after = await cache.get();
    expect(after!.ageMs).toBe(0);
    cache.stop();
  });

  test("past the serving limit a request waits for a read; a failed read with nothing young enough is null", async () => {
    let t = 1_000_000;
    let fail = false;
    const k = client({ fail: () => fail });
    const cache = snapshotCache(k.c, { now: () => t, serveMaxMs: 50_000, warmEveryMs: 3_600_000 });
    await cache.get();
    fail = true;
    t += 20_000;
    expect((await cache.get())!.ageMs).toBe(20_000); // stale, still served; the refresh fails quietly
    t += 40_000;
    expect(await cache.get()).toBeNull();
    fail = false;
    expect((await cache.get())!.ageMs).toBe(0);
    cache.stop();
  });

  test("never read and failing: null", async () => {
    const cache = snapshotCache(client({ fail: () => true }).c, { warmEveryMs: 3_600_000 });
    expect(await cache.get()).toBeNull();
    cache.stop();
  });
});

describe("GET /api/markets", () => {
  test("200 with the snapshot, no-store, and the app's origin allowed", async () => {
    const k = client();
    const snapshots = snapshotCache(k.c, { warmEveryMs: 3_600_000 });
    const app = publicApp({ store: new Store(":memory:"), log: () => {}, agateClient: k.c, snapshots });
    const r = await app.request("/api/markets", { headers: { origin: "http://localhost:3317" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:3317");
    const j = await r.json();
    expect(j.markets.map((m: { gpu: string }) => m.gpu)).toEqual(GPUS);
    expect(j.books["H100 2026-11"]).toEqual(books["H100 2026-11"]);
    snapshots.stop();
  });

  test("503 when the markets cannot be read", async () => {
    const snapshots = snapshotCache(client({ fail: () => true }).c, { warmEveryMs: 3_600_000 });
    const app = publicApp({ store: new Store(":memory:"), log: () => {}, agateClient: () => ({}) as never, snapshots });
    const r = await app.request("/api/markets");
    expect(r.status).toBe(503);
    expect((await r.json()).error).toContain("chain");
    snapshots.stop();
  });
});
