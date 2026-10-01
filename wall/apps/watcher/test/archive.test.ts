// The watcher's logger on real archived pages (read from AGATE_RAW_DIR, never copied): through the real @agate/sources
// parsers it must log exactly the values builder B's archive reader gives for the same hour. Skips without the archive.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GpuModel } from "@agate/report/types";
import { archivePresent, listHours, pageTimeOf, readArchived, valuesOfHour } from "@agate/sources/io";
import * as pure from "@agate/sources/pure";
import { AlertSink } from "../src/alerts.ts";
import { Logger, type LoggerApi, type Page } from "../src/log/logger.ts";
import { cellOf, LogStore } from "../src/log/store.ts";

test.skipIf(!archivePresent())("logger on archived hours equals the sources archive reader", async () => {
  const hours = listHours().slice(-4, -1); // the newest hour may still be being written
  let compared = 0;
  for (const h of hours) {
    const dir = mkdtempSync(join(tmpdir(), "agate-archive-"));
    const store = new LogStore(dir);
    let now = h.startSec;
    const fx = listHours().map((x) => readArchived(x, "fx_ecb")).filter((b): b is string => b !== null).at(-1) ?? null;
    const lg = new Logger({
      clock: { slice: 3_600, epochTs: 0 },
      api: pure as unknown as LoggerApi,
      fetchPage: async (url) => {
        const id = url.split("/").pop()!;
        const body = id === "fx_ecb" ? fx : readArchived(h, id);
        if (body === null) return { ok: false, httpStatus: 404, body: "", bytes: 0, sha256: "", error: "not archived" } as Page;
        return { ok: true, httpStatus: 200, body, bytes: body.length, sha256: "", pageTime: id === "fx_ecb" ? h.startSec : pageTimeOf(h, id) };
      },
      baseUrl: "http://archive.invalid",
      dir,
      store,
      alerts: new AlertSink(null, { now: () => now, print: false }),
      rand: Math.random,
      timeoutMs: 1_000,
      tickS: 60,
      writeRaw: false,
      now: () => now,
    });
    for (now = h.startSec; now < h.startSec + 3_600; now += 60) {
      await lg.tick(now);
      await lg.drain();
    }
    const want = valuesOfHour(h);
    const k = Math.floor(h.startSec / 3_600);
    for (const [id, src] of Object.entries(want.sources)) {
      if (!src) continue;
      for (const [g, row] of Object.entries(src.rows) as [GpuModel, { s: string; v: number }][]) {
        const cell = cellOf(store.get(id, k), g);
        const expected = row.s === "VALID" ? row.v : row.s;
        // an EUR row without an ECB rate is FAILED in the watcher's log by design (missing evidence, not a dark page)
        if (cell === "FAILED" && row.s === "NO_ROW") continue;
        expect([id, g, cell]).toEqual([id, g, expected]);
        compared++;
      }
    }
  }
  console.log(`archive: ${compared} (source, GPU) cells compared over ${hours.length} hours`);
  expect(compared).toBeGreaterThan(0);
}, 120_000);
