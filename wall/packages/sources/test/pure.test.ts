// The pure layer runs inside CRE's WASM: no Node, Bun or DOM APIs, nothing impure imported, no float money math.
// Also: the writers' own pipeline accepts this package and builds correct report entries from it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as pure from "../src/pure/index.ts";
import { renderEcb, renderPage } from "../src/synthetic.ts";
import type { Panel } from "../src/types.ts";

const PKG = join(import.meta.dir, "..");
const PURE = join(PKG, "src", "pure");

function files(dir: string, ext = ".ts"): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), ext) : e.name.endsWith(ext) ? [join(dir, e.name)] : []));
}

describe("pure layer", () => {
  test("imports only the pure layer, @agate/report/types and viem; uses no host API", () => {
    for (const f of files(PURE)) {
      const src = readFileSync(f, "utf8");
      const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of code.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        const ok = spec === "viem" || spec === "@agate/report/types" || spec === "../types.ts" || spec === "../../types.ts" || (spec.startsWith(".") && !spec.includes("/io/") && !spec.includes("synthetic") && !spec.includes("panelTool"));
        expect(ok, `${relative(PKG, f)} imports ${spec}`).toBe(true);
      }
      for (const banned of [/\bnode:/, /\bBun\./, /\bprocess\./, /\brequire\(/, /\bfetch\(/, /\bTextEncoder\b/, /\bTextDecoder\b/, /\bdocument\./, /\bwindow\./, /\bDOMParser\b/, /\bBuffer\b/, /parseFloat|Number\.parseFloat|toFixed\(/]) {
        expect(banned.test(code), `${relative(PKG, f)} uses ${banned}`).toBe(false);
      }
    }
  });

  test("typechecks under tsconfig.pure.json (no Node, Bun or DOM types)", () => {
    const tsc = join(PKG, "..", "..", "node_modules", ".bin", "tsc");
    const r = Bun.spawnSync([tsc, "-p", join(PKG, "tsconfig.pure.json"), "--noEmit"], { cwd: PKG });
    expect(r.stdout.toString() + r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });

  test("no em dash and only printable ASCII in the package's source, tests and data", () => {
    const all = [...files(join(PKG, "src")), ...files(join(PKG, "test")), ...files(join(PKG, "scripts")), ...files(PKG, ".json").filter((f) => !f.includes("node_modules"))];
    for (const f of all) {
      const s = readFileSync(f, "utf8");
      expect(s.includes("\u2014"), `${relative(PKG, f)} has an em dash`).toBe(false);
      expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(s), `${relative(PKG, f)} has a non-ASCII character`).toBe(false);
    }
  });
});

describe("the writers' pipeline with the real sources API", () => {
  test("asSourcesApi accepts it; a reading builds entries in slot order, EUR converted with the ECB file", async () => {
    const core = await import("../../../apps/writer-standby/src/core/reading.ts");
    const api = core.asSourcesApi(pure);
    const spec = pure.specOf("H100");
    const panel: Panel = {
      gpu: "H100",
      spec,
      gpuId: pure.gpuIdOf(spec),
      families: ["Verda", "Lambda", "Civo", "Seeweb", "Hyperstack"].map((name) => ({ name, famQ: 1 })),
      slots: ["p_verda", "p_lambda", "p_civo", "p_seeweb", "p_hyperstack"].map((sourceId, i) => ({ slot: i, sourceId, family: i, liveAtStart: true })),
    };
    const defs = core.neededSources(api, [panel]);
    const ok = (body: string) => ({ ok: true, httpStatus: 200, body, bytes: body.length });
    const pages = {
      p_verda: ok(renderPage("p_verda", { H100: { price: "3.627" } })),
      p_lambda: ok(renderPage("p_lambda", { H100: { price: "3.99" } })),
      p_civo: ok(renderPage("p_civo", { H100: { state: "not-rentable" } })),
      p_seeweb: ok(renderPage("p_seeweb", { H100: { price: "1.89" } })),
      p_hyperstack: { ok: false, httpStatus: 503, body: "", bytes: 0 },
    };
    const readAt = Date.UTC(2026, 9, 1, 5, 17) / 1000;
    const fx = ok(renderEcb({ "2026-09-29": "1.1355", "2026-09-30": "1.1355" }));
    const reading = core.takeReading(api, [panel], defs, { dayId: 20_727, slice: 5, readAt }, pages, fx);
    expect(reading.entries).toHaveLength(1);
    expect(reading.entries[0]!.values).toEqual([3_630_000, 3_990_000, 0, 2_150_000, 0]);
    const log = Object.fromEntries(reading.sources.map((s) => [s.sourceId, s]));
    expect(log.p_civo!.rows.H100).toEqual({ state: "NOT_RENTABLE", valueU: 0 });
    expect(log.p_hyperstack!.rows.H100).toEqual({ state: "FAILED", valueU: 0 });
    expect(log.p_seeweb!.fxDate).toBe("2026-09-30");
  });
});
