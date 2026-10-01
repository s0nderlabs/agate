import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { archivePresent, listHours, readArchived } from "../src/io/archive.ts";
import { fetchSource } from "../src/io/fetch.ts";
import { checkScenario, type ReplayScenario, startReplay } from "../src/io/replay.ts";
import { parse, parseEcb } from "../src/pure/index.ts";
import { renderEcb, renderPage } from "../src/synthetic.ts";

// A synthetic archive: two real-calendar hours (Sep 30 23 UTC, Oct 1 00 UTC) with Lambda and Seeweb pages.
const root = mkdtempSync(join(tmpdir(), "agate-replay-test-"));
const raw = join(root, "raw");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (d: string, h: string, id: string, body: string) => {
  mkdirSync(join(raw, d, h), { recursive: true });
  writeFileSync(join(raw, d, h, `${id}.all.gz`), gzipSync(body));
};
put("2026-09-30", "23", "p_lambda", renderPage("p_lambda", { H100: { price: "3.99" }, B200: { price: "6.69" } }));
put("2026-10-01", "00", "p_lambda", renderPage("p_lambda", { H100: { price: "4.19" }, B200: { price: "6.69" } }));
put("2026-10-01", "00", "p_seeweb", renderPage("p_seeweb", { H100: { price: "1.89" }, H200: { price: "2.60" } }));
put("2026-10-01", "00", "fx_ecb", renderEcb({ "2026-09-30": "1.1355" }));

const T0 = 1_800_000_000;
const clock = { t0: T0, daySec: 600, slices: 4 };
const get = async (url: string, t: number) => {
  const res = await fetch(url, { headers: { "x-agate-clock": String(t) } });
  return { status: res.status, body: await res.text(), pageTime: Number(res.headers.get("x-agate-page-time")), hour: res.headers.get("x-agate-hour"), scripted: res.headers.get("x-agate-scripted") };
};
const ctxOf = (pageTime: number, fxBody?: string) => {
  const utcDate = new Date(pageTime * 1000).toISOString().slice(0, 10);
  const fx = fxBody ? parseEcb(fxBody, utcDate) : null;
  return { utcDate, nowSec: pageTime, ...(fx ? { fx } : {}) };
};

describe("replay server", () => {
  const scenario: ReplayScenario = {
    scripted: { p_lambda: { gpus: { H100: [{ from: { day: 3 }, price: "3.49" }] } } },
    roles: { standby: { p_lambda: { page: [{ from: { day: 0 }, state: "http-503" }] } } },
  };
  const s = startReplay({ rawDir: raw, clock, scenario, hangMs: 50 });
  afterAll(() => s.stop());

  test("maps demo time onto the archive: one demo day = one real day, wrapping", () => {
    expect(s.replay.resolve(T0)).toMatchObject({ day: 0, slice: 0, hour: { date: "2026-09-30", hour: "23" } });
    expect(s.replay.resolve(T0 + 25)).toMatchObject({ day: 0, slice: 0, hour: { date: "2026-10-01", hour: "00" } }); // 25 s = 1 real hour
    expect(s.replay.resolve(T0 + 50)).toMatchObject({ day: 0, slice: 0, hour: { date: "2026-09-30", hour: "23" } }); // wrapped
    expect(s.replay.resolve(T0 + 600 * 3 + 160)).toMatchObject({ day: 3, slice: 1 });
  });

  test("serves the archived page with the page's own time; the writers' parser reads it", async () => {
    const r = await get(`${s.url}/p_lambda`, T0 + 30);
    expect(r).toMatchObject({ status: 200, hour: "2026-10-01T00", scripted: null });
    expect(new Date(r.pageTime * 1000).toISOString().slice(0, 13)).toBe("2026-10-01T00");
    expect(parse("p_lambda", r.body, ctxOf(r.pageTime)).H100).toMatchObject({ state: "VALID", valueU: 4_190_000 });
  });

  test("the scripted step: from demo day 3 one GPU changes, the source's other GPUs keep their archived values", async () => {
    const before = await get(`${s.url}/p_lambda`, T0 + 600 * 2 + 30);
    expect(parse("p_lambda", before.body, ctxOf(before.pageTime)).H100!.valueU).toBe(4_190_000);
    const after = await get(`${s.url}/p_lambda`, T0 + 600 * 3 + 30);
    expect(after.scripted).toBe("1");
    const rows = parse("p_lambda", after.body, ctxOf(after.pageTime));
    expect(rows.H100).toMatchObject({ state: "VALID", valueU: 3_490_000 });
    expect(rows.B200).toMatchObject({ state: "VALID", valueU: 6_690_000 });
  });

  test("per-role views: the standby sees an outage the others do not", async () => {
    expect((await get(`${s.url}/r/standby/p_lambda`, T0 + 30)).status).toBe(503);
    expect((await get(`${s.url}/r/watcher/p_lambda`, T0 + 30)).status).toBe(200);
  });

  test("ECB file and EUR pages: converted with the rate the archive holds", async () => {
    const fx = await get(`${s.url}/fx_ecb`, T0 + 30);
    expect(parseEcb(fx.body, "2026-10-01")).toEqual({ date: "2026-09-30", usdPerEur: "1.1355" });
    const p = await get(`${s.url}/p_seeweb`, T0 + 30);
    expect(parse("p_seeweb", p.body, ctxOf(p.pageTime, fx.body)).H100).toMatchObject({ state: "VALID", valueU: 2_150_000 });
  });

  test("unknown sources and hours without a page are 404, never a made-up page", async () => {
    expect((await get(`${s.url}/p_runpod`, T0)).status).toBe(404);
    expect((await get(`${s.url}/p_seeweb`, T0)).status).toBe(404); // Sep 30 23 has no Seeweb page
    expect((await get(`${s.url}/a/b`, T0)).status).toBe(404);
  });

  test("fetchSource over the replay carries X-Agate-Page-Time", async () => {
    const r = await fetchSource(`${s.url}/p_lambda`, { role: "watcher", sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(r.pageTime).toBeGreaterThan(1_790_000_000);
  });
});

describe("replay chaos pages", () => {
  const sc: ReplayScenario = {
    archive: false,
    scripted: {
      p_verda: { gpus: { H100: [{ from: { day: 0 }, price: "3.63" }, { from: { day: 1 }, state: "not-rentable" }] } },
      p_civo: { gpus: { H100: [{ from: { day: 0 }, price: "2.99" }] }, page: [{ from: { day: 1 }, state: "broken" }, { from: { day: 2 }, state: "gzip-raw" }, { from: { day: 3 }, state: "hang" }] },
    },
  };
  const s = startReplay({ rawDir: raw, clock, scenario: sc, hangMs: 30 });
  afterAll(() => s.stop());
  const ctx = (t: number) => ({ utcDate: new Date(t * 1000).toISOString().slice(0, 10), nowSec: t });

  test("scripted-only pages, state changes, layout breaks, compressed bodies and hangs", async () => {
    const d0 = await get(`${s.url}/p_verda`, T0 + 10);
    expect(parse("p_verda", d0.body, ctx(T0)).H100).toMatchObject({ state: "VALID", valueU: 3_630_000 });
    const d1 = await get(`${s.url}/p_verda`, T0 + 610);
    expect(parse("p_verda", d1.body, ctx(T0)).H100!.state).toBe("NO_ROW"); // the API shows no sold-out state
    const broken = await get(`${s.url}/p_civo`, T0 + 610);
    expect(parse("p_civo", broken.body, ctx(T0)).H100!.detail).toMatch(/^layout-changed/);
    const gz = await get(`${s.url}/p_civo`, T0 + 1210);
    expect(parse("p_civo", gz.body, ctx(T0)).H100!.detail).toMatch(/^not-text/);
    const hang = await fetchSource(`${s.url}/p_civo`, { role: "watcher", timeoutMs: 5_000, sleep: async () => {}, fetchImpl: (u, i) => fetch(u, { ...i, headers: { ...(i?.headers as Record<string, string>), "x-agate-clock": String(T0 + 1810) } }) });
    expect(hang).toMatchObject({ ok: false, httpStatus: 504 });
    expect((await get(`${s.url}/p_lambda`, T0)).status).toBe(404); // no script, archive off
  });
});

describe("the real archive through the replay (skipped without AGATE_RAW_DIR)", () => {
  test.skipIf(!archivePresent())("serves each archived hour byte for byte with the demo scenario", async () => {
    const hours = listHours();
    const scenario = JSON.parse(readFileSync(join(import.meta.dir, "..", "replay", "demo.json"), "utf8")) as ReplayScenario;
    const s = startReplay({ clock, scenario });
    try {
      const h = hours[0]!;
      const r = await get(`${s.url}/p_nebius`, T0);
      expect(r.hour).toBe(`${h.date}T${h.hour}`);
      expect(r.body).toBe(readArchived(h, "p_nebius")!);
      const day3 = await get(`${s.url}/p_lambda`, T0 + 600 * 3);
      expect(day3.scripted).toBe("1");
      expect(parse("p_lambda", day3.body, ctxOf(day3.pageTime)).H100).toMatchObject({ state: "VALID", valueU: 3_490_000 });
    } finally {
      s.stop();
    }
  });
});

describe("replay scenarios are checked at start", () => {
  test("a typo fails loudly instead of serving something else mid-demo", () => {
    const bad: unknown[] = [
      { scripted: { p_runpod: { gpus: { H100: [{ from: { day: 0 }, price: "3.00" }] } } } },
      { scripted: { p_lambda: { gpus: { H200: [{ from: { day: 0 }, price: "3.00" }] } } } }, // Lambda has no H200 rule
      { scripted: { p_lambda: { gpus: { H100: [{ from: { day: 0 } }] } } } }, // neither price nor state
      { scripted: { p_lambda: { gpus: { H100: [{ from: { day: 0 }, price: "3.00", state: "missing" }] } } } },
      { scripted: { p_lambda: { gpus: { H100: [{ from: { day: -1 }, price: "3.00" }] } } } },
      { scripted: { p_lambda: { gpus: { H100: [{ from: { day: 0 }, price: "3,00" }] } } } },
      { scripted: { p_lambda: { gpus: { H100: [{ from: { day: 0 }, price: "3.00", count: 4 }] } } } },
      { scripted: { p_lambda: { page: [{ from: { day: 0 }, state: "down" }] } } },
      { roles: { "Bad Role": {} } },
      { fx: { "2026-02-30": "1.1" } },
      { fx: { "2026-09-30": "11.1" } },
    ];
    for (const sc of bad) expect(() => checkScenario(sc as ReplayScenario), JSON.stringify(sc)).toThrow();
    expect(() => startReplay({ clock, scenario: bad[0] as ReplayScenario })).toThrow();
    expect(() => checkScenario(JSON.parse(readFileSync(join(import.meta.dir, "..", "replay", "demo.json"), "utf8")))).not.toThrow();
  });
});
