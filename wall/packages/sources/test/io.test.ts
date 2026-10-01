import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { archivedFx, listHours, pageTimeOf, readArchived } from "../src/io/archive.ts";
import { fetchSource, sha256Hex, userAgent } from "../src/io/fetch.ts";
import { parse } from "../src/pure/index.ts";
import { renderEcb, renderPage } from "../src/synthetic.ts";

let server: ReturnType<typeof Bun.serve>;
let base = "";
let fails = 0;
const seenUa: string[] = [];
const page = renderPage("p_lambda", { H100: { price: "3.99" }, B200: { price: "6.69" } });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      seenUa.push(req.headers.get("user-agent") ?? "");
      const p = new URL(req.url).pathname;
      if (p === "/gzip") return new Response(gzipSync(page), { headers: { "content-encoding": "gzip", "content-type": "text/html", "x-agate-page-time": "1790830000" } });
      if (p === "/flaky") return ++fails % 2 === 1 ? new Response("busy", { status: 503 }) : new Response(page);
      if (p === "/down") return new Response("", { status: 500 });
      if (p === "/empty") return new Response("", { status: 200 });
      if (p === "/big") return new Response("x".repeat(260_000));
      if (p === "/slow") {
        await Bun.sleep(400);
        return new Response(page);
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const noSleep = async () => {};

describe("fetchSource", () => {
  test("a gzip response is decoded; bytes and sha256 are of the decoded body; page time header read", async () => {
    const r = await fetchSource(`${base}/gzip`, { role: "watcher", sleep: noSleep });
    expect(r).toMatchObject({ ok: true, httpStatus: 200, attempts: 1, pageTime: 1_790_830_000, overCap: false });
    expect(r.body).toBe(page);
    expect(r.bytes).toBe(new TextEncoder().encode(page).length);
    expect(r.sha256).toBe(sha256Hex(new TextEncoder().encode(page)));
    const rows = parse("p_lambda", r.body, { utcDate: "2026-10-01", nowSec: 1_790_830_000 });
    expect(rows.H100).toMatchObject({ state: "VALID", valueU: 3_990_000 });
    expect(seenUa.at(-1)).toBe("agate-wall/watcher/0.1 (+https://github.com/s0nderlabs/agate)");
  });

  test("one retry after a failure, only when it still starts inside the interval", async () => {
    fails = 0;
    const slept: number[] = [];
    const r = await fetchSource(`${base}/flaky`, { role: "watcher", sleep: async (ms) => void slept.push(ms), rand: () => 0.5, retryGapMs: [30_000, 120_000] });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(slept).toEqual([75_000]);
    fails = 0;
    const late = await fetchSource(`${base}/flaky`, { role: "watcher", sleep: noSleep, now: () => 1000, retryBefore: 1010, rand: () => 0 });
    expect(late).toMatchObject({ ok: false, httpStatus: 503, attempts: 1 });
    const down = await fetchSource(`${base}/down`, { role: "watcher", sleep: noSleep });
    expect(down).toMatchObject({ ok: false, httpStatus: 500, attempts: 2, error: "HTTP 500, empty body" });
    expect((await fetchSource(`${base}/empty`, { role: "watcher", sleep: noSleep })).ok).toBe(false);
  });

  test("timeouts and refused connections are failures, never exceptions", async () => {
    const t = await fetchSource(`${base}/slow`, { role: "watcher", timeoutMs: 50, sleep: noSleep });
    expect(t).toMatchObject({ ok: false, httpStatus: 0, attempts: 2 });
    expect(t.error).toMatch(/Timeout|abort/i);
    const c = await fetchSource("http://127.0.0.1:1/x", { role: "watcher", sleep: noSleep });
    expect(c).toMatchObject({ ok: false, httpStatus: 0 });
  });

  test("a body over CRE's cap is flagged", async () => {
    const r = await fetchSource(`${base}/big`, { role: "watcher", sleep: noSleep });
    expect(r).toMatchObject({ ok: true, bytes: 260_000, overCap: true });
  });

  test("the user agent is honest and the role is checked", () => {
    expect(userAgent("standby")).toBe("agate-wall/standby/0.1 (+https://github.com/s0nderlabs/agate)");
    expect(() => userAgent("Mozilla/5.0")).toThrow();
  });
});

describe("archive reader (a synthetic archive in a temp dir)", () => {
  const root = mkdtempSync(join(tmpdir(), "agate-sources-test-"));
  const raw = join(root, "raw");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("lists hours, gunzips pages, reads the logger's fetch time, applies the FX rule", () => {
    for (const [d, h] of [
      ["2026-09-30", "23"],
      ["2026-10-01", "00"],
    ]) {
      mkdirSync(join(raw, d, h), { recursive: true });
      writeFileSync(join(raw, d, h, "p_lambda.all.gz"), gzipSync(page));
    }
    mkdirSync(join(raw, "notadate"), { recursive: true });
    writeFileSync(join(raw, "2026-10-01", "00", "fx_ecb.all.gz"), gzipSync(renderEcb({ "2026-09-30": "1.1355" })));
    writeFileSync(
      join(root, "readings.jsonl"),
      `${JSON.stringify({ slice_utc: "2026-10-01T00", source: "p_lambda", fetches: [{ key: "all", fetched_at_utc_s: Date.UTC(2026, 9, 1, 0, 12) / 1000 }] })}\n{"torn`,
    );
    const hours = listHours(raw);
    expect(hours.map((h) => `${h.date}T${h.hour}`)).toEqual(["2026-09-30T23", "2026-10-01T00"]);
    expect(readArchived(hours[0]!, "p_lambda")).toBe(page);
    expect(readArchived(hours[0]!, "p_nebius")).toBeNull();
    writeFileSync(join(raw, "2026-09-30", "23", "p_civo.all.gz"), gzipSync(page).subarray(0, 40)); // torn while written
    expect(readArchived(hours[0]!, "p_civo")).toBeNull();
    expect(pageTimeOf(hours[1]!, "p_lambda", raw)).toBe(Date.UTC(2026, 9, 1, 0, 12) / 1000);
    expect(pageTimeOf(hours[0]!, "p_lambda", raw)).toBe(Date.UTC(2026, 8, 30, 23, 30) / 1000); // no log line: mid-hour
    expect(archivedFx("2026-10-01", raw)).toEqual({ date: "2026-09-30", usdPerEur: "1.1355" });
    expect(archivedFx("2026-09-30", raw)).toBeNull();
    expect(listHours(join(root, "absent"))).toEqual([]);
  });
});
