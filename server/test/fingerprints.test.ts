import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Market, MarketsSnapshot } from "@agate/client";
import { developerApi } from "../src/developer.ts";
import { pagesOfDay, watcherFingerprints } from "../src/fingerprints.ts";

// lines in the watcher's log format (WatcherReading, wall/packages/report): Oct 7 2026 is day 20733, so its hours are
// intervals 497592 to 497615 on the production clock (hourly, epoch 0)
const sha = (c: string) => c.repeat(64);
const T = 1791331200; // 2026-10-07T00:00:00Z
const line = (o: { id: string; k: number; at?: number; attempts?: number; sha256?: string; url?: string; gpus: Record<string, [string, number]> }) =>
  JSON.stringify({
    sourceId: o.id,
    interval: o.k,
    scheduledAt: o.at ?? T + (o.k - 497592) * 3600 + 600,
    fetchedAt: o.attempts === 0 ? 0 : (o.at ?? T + (o.k - 497592) * 3600 + 600),
    attempts: o.attempts ?? 1,
    httpStatus: o.attempts === 0 ? 0 : 200,
    bytes: 1000,
    sha256: o.sha256 ?? "",
    gpus: Object.fromEntries(Object.entries(o.gpus).map(([g, [state, valueU]]) => [g, { state, valueU }])),
    ...(o.url ? { url: o.url } : {}),
  });

const OCT7 = [
  line({ id: "p_lambda", k: 497614, sha256: sha("a"), gpus: { H100: ["VALID", 3990000] } }),
  line({ id: "p_lambda", k: 497615, at: 1791415084, sha256: sha("b"), gpus: { H100: ["VALID", 3990000], B200: ["VALID", 6690000] } }),
  // a MISSED line written first (catch-up after a restart) loses to the real reading of the same hour
  line({ id: "p_verda", k: 497615, attempts: 0, gpus: {} }),
  line({ id: "p_verda", k: 497615, sha256: sha("c"), gpus: { H100: ["VALID", 3850000] } }),
  // two loggers' lines for one hour: the first wins, so Civo's newest clean H100 page is the hour before
  line({ id: "p_civo", k: 497614, sha256: sha("f"), gpus: { H100: ["VALID", 2990000] } }),
  line({ id: "p_civo", k: 497615, sha256: sha("d"), gpus: { H100: ["NO_ROW", 0] } }),
  line({ id: "p_civo", k: 497615, sha256: sha("e"), gpus: { H100: ["VALID", 2990000] } }),
  // a failed fetch hashes its error body: never a page behind a price
  line({ id: "p_nebius", k: 497613, sha256: sha("1"), gpus: { H100: ["VALID", 4500000] } }),
  line({ id: "p_nebius", k: 497615, sha256: sha("2"), gpus: { H100: ["FAILED", 0] } }),
  // a reader swap: H100 read from another URL of the source, H200 from the registered one
  line({ id: "p_coreweave", k: 497615, sha256: sha("3"), url: "https://www.coreweave.com/pricing/new", gpus: { H100: ["VALID", 6160000] } }),
  line({ id: "p_coreweave", k: 497615, sha256: sha("4"), gpus: { H200: ["VALID", 6310000] } }),
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "agate-fingerprints-"));
mkdirSync(join(dir, "log"));
writeFileSync(join(dir, "log", "2026-10-07.jsonl"), `${OCT7}\n{"sourceId":"p_lambda","interval":4976`); // a torn last line
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("page fingerprints from the watcher's log", () => {
  test("the newest clean reading of the day per source and GPU, with the watcher's fold rule", () => {
    const p = pagesOfDay(OCT7);
    expect(p.get("p_lambda H100")?.fp).toEqual({ sha256: sha("b"), fetchedAt: "2026-10-07T23:18:04Z", price: 3.99 });
    expect(p.get("p_lambda B200")?.fp.price).toBe(6.69);
    expect(p.get("p_verda H100")?.fp.sha256).toBe(sha("c"));
    expect(p.get("p_civo H100")?.fp.sha256).toBe(sha("f"));
    expect(p.get("p_nebius H100")?.fp.sha256).toBe(sha("1"));
    expect(p.get("p_coreweave H100")?.fp.sha256).toBe(sha("3"));
    expect(p.get("p_coreweave H200")?.fp.sha256).toBe(sha("4"));
    expect(p.has("p_hyperstack H100")).toBe(false);
  });

  test("a panel slot is found by its index and company; anything else has no page", () => {
    const f = watcherFingerprints(dir);
    const date = "2026-10-07";
    expect(f.page({ gpu: "H100", date, slot: 2, company: "Lambda" })?.sha256).toBe(sha("b"));
    expect(f.page({ gpu: "H100", date, slot: 0, company: "Verda" })?.price).toBe(3.85);
    expect(f.page({ gpu: "H200", date, slot: 2, company: "CoreWeave" })?.sha256).toBe(sha("4"));
    expect(f.page({ gpu: "H100", date, slot: 2, company: "Verda" })).toBeNull(); // the slot holds another cloud
    expect(f.page({ gpu: "H100", date, slot: 9, company: "Lambda" })).toBeNull(); // a slot the panels do not know
    expect(f.page({ gpu: "H100", date, slot: 5, company: "Hyperstack" })).toBeNull(); // no reading that day
    expect(f.page({ gpu: "H100", date: "2026-10-08", slot: 2, company: "Lambda" })).toBeNull(); // no file
    expect(f.page({ gpu: "H100", date: "../../etc", slot: 2, company: "Lambda" })).toBeNull();
    expect(watcherFingerprints(join(dir, "nowhere")).page({ gpu: "H100", date, slot: 2, company: "Lambda" })).toBeNull();
  });

  test("a file that grew or appeared is read again after the recheck interval, not before", () => {
    let t = 0;
    const f = watcherFingerprints(dir, { recheckMs: 5_000, now: () => t });
    const q = { gpu: "H100", date: "2026-10-07", slot: 5, company: "Hyperstack" } as const;
    expect(f.page(q)).toBeNull();
    appendFileSync(join(dir, "log", "2026-10-07.jsonl"), `\n${line({ id: "p_hyperstack", k: 497615, sha256: sha("5"), gpus: { H100: ["VALID", 3200000] } })}\n`);
    t = 4_000;
    expect(f.page(q)).toBeNull();
    t = 5_000;
    expect(f.page(q)?.sha256).toBe(sha("5"));
    const later = { gpu: "H100", date: "2026-10-12", slot: 2, company: "Lambda" } as const;
    expect(f.page(later)).toBeNull();
    writeFileSync(join(dir, "log", "2026-10-12.jsonl"), `${line({ id: "p_lambda", k: 497712, sha256: sha("6"), gpus: { H100: ["VALID", 3990000] } })}\n`);
    expect(f.page(later)).toBeNull();
    t = 10_000;
    expect(f.page(later)?.sha256).toBe(sha("6"));
  });

  test("through the developer API: each priced row of the latest final day carries its page", async () => {
    const families = ["Verda", "Nebius", "Lambda", "CoreWeave", "Civo", "Hyperstack"];
    const prices = [3.83, 4.5, 3.99, 6.16, 2.99, null];
    const m = {
      gpu: "H100",
      priceDate: "2026-10-07",
      price: 3.99,
      prevPrice: 3.99,
      history: [],
      panel: families.map((family, i) => ({ family, live: i < 5, reserve: i === 5, price: prices[i] ?? null })),
    } as unknown as Market;
    const s = { v: 1, chainId: 10143, index: "0x4193", readAt: "2026-10-08T14:20:36.461Z", ageMs: 1, markets: [m], books: {} } as MarketsSnapshot;
    const app = developerApi({ snapshots: { get: async () => s, stop: () => {} }, client: () => ({}) as never, log: () => {}, pages: watcherFingerprints(dir) });
    const j = (await (await app.request("/v1/prices/H100")).json()) as { sources: { company: string; page: { sha256: string } | null }[] };
    expect(j.sources.map((r) => [r.company, r.page?.sha256 ?? null])).toEqual([
      ["Verda", sha("c")],
      ["Nebius", sha("1")],
      ["Lambda", sha("b")],
      ["CoreWeave", sha("3")],
      ["Civo", sha("f")],
      ["Hyperstack", null], // no price behind it, so no page, although the watcher read it
    ]);
  });
});
