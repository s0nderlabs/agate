// The price-only GPUs B300, A100 and L40S (BUILD-SPEC 18): what must not move for H100, H200 and B200, the new rules
// on the archived pages and on synthetic pages, the deploy configs, and the market side (three GPUs). The archive
// parts skip when the archive is absent; the cross-check against an independent reader's readings of the same hours
// runs only with AGATE_PRICE_ONLY_READINGS set (the path of that JSONL file; it lives outside the repo).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GpuModel } from "@agate/report/types";
import { archivePresent, listHours, pageTimeOf, readArchived, archivedFx } from "../src/io/archive.ts";
import { canonicalJson, GPUS, gpuIdOf, parse, reasonOf, recipeHash, SOURCES, specOf } from "../src/pure/index.ts";
import { type DeployEntry, deployGpus, liveFamilyCount, panelFileFor, withGpus } from "../src/panelTool.ts";
import { renderPage } from "../src/synthetic.ts";
import type { Panel, ParseContext, ParseResult } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PANELS = join(import.meta.dir, "..", "panels");
const CONFIG = join(ROOT, "contracts", "script", "config");
const OLD: readonly GpuModel[] = ["H100", "H200", "B200"];
const NEW: readonly GpuModel[] = ["B300", "A100", "L40S"];
/** The commit before the price-only GPUs: the three registered entries must read the same bytes as there. */
const BASE = "0e7a080";

type Deploy = { gpu: GpuModel; spec: string; gpuId: string; recipeHash: string; family: number[]; famQ: number[]; liveAtStartMask: number };
const panelFile = (name: string) => JSON.parse(readFileSync(join(PANELS, name), "utf8")) as { panels: Panel[]; deploy: Deploy[] };
const DEPLOY_CONFIGS = readdirSync(CONFIG).filter((f) => /^local-[a-z]+\.json$/.test(f) || f === "fork-demo.json").sort();
const MARKET_CONFIGS = readdirSync(CONFIG).filter((f) => /^market-[a-z]+\.json$/.test(f)).sort();

/** The registered entries of the first three GPUs (recipeHash, family, liveAtStartMask), from the commit before. */
const REGISTERED: Record<"default.json" | "launch.json", Record<string, [string, number[], number]>> = {
  "default.json": {
    H100: ["0xe6514fa7e4a54edccdd868c38bd5a4e0632bea709fcb4b477d227e5954b31e25", [0, 1, 2, 3, 4], 31],
    H200: ["0x6f9f14b5ea35886704228cc4905ac7d4d7574a42fd76e2b5a1c3e7f393ae6447", [0, 1, 2, 3], 7],
    B200: ["0x4fa64929588d7edd7603a46469c812c2a4079b51590628a64dc9a3221e2e6839", [0, 1, 2, 3], 7],
  },
  "launch.json": {
    H100: ["0x815a2dac8891801a0d68af0edb442e086871641c09841e15b171dfb986f25b1a", [0, 1, 2, 3, 4, 5], 31],
    H200: ["0x827d522003fde1517f16f3ea1e4633de3bbfa8af77802e00db8c0942fd8dc1cc", [0, 1, 2, 3, 4], 31],
    B200: ["0x333a1e28323786643a1196031972483841e4e6d9621c6e287947be2ca1b26474", [0, 1, 2, 3, 4], 31],
  },
};
/** keccak256 of the canonical JSON of every source's H100, H200 and B200 rules (Seeweb's and Gcore's included). */
const OLD_RULES_HASH = "0x97daaebbfceb5ea1cfc095fbd0a9d1ac3b7385facc7ca625bfb74012c4eea3a8";

/** `git show <BASE>:<path>`, or null when git or that commit is not available here. */
function atBase(path: string): string | null {
  const r = Bun.spawnSync(["git", "show", `${BASE}:${path}`], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

describe("H100, H200 and B200 do not move", () => {
  test("specs, gpuIds, recipeHashes, families, famQ and live masks in both panel files", () => {
    for (const name of ["default.json", "launch.json"] as const) {
      const doc = panelFile(name);
      expect(doc.panels.map((p) => p.gpu)).toEqual([...GPUS]);
      for (const [i, g] of OLD.entries()) {
        const [hash, family, mask] = REGISTERED[name][g]!;
        const d = doc.deploy[i]!;
        expect({ name, ...d } as Record<string, unknown>).toEqual({ name, gpu: g, spec: specOf(g), gpuId: gpuIdOf(`${g}-SXM/on-demand-list/neocloud/v1`), recipeHash: hash, family, famQ: family.map(() => 1), liveAtStartMask: mask });
        expect(recipeHash(doc.panels[i]!) as string).toBe(hash);
      }
    }
  });

  test("every rule text of the first three GPUs is unchanged (Seeweb's and Gcore's too)", () => {
    const old = Object.fromEntries(SOURCES.map((s) => [s.id, Object.fromEntries(OLD.filter((g) => s.rules[g]).map((g) => [g, s.rules[g]]))]));
    expect(gpuIdOf(canonicalJson(old))).toBe(OLD_RULES_HASH);
    for (const s of SOURCES) expect(s.parserVersion).toBe(`${s.parserVersion.split("/")[0]}/1`);
  });

  test("the deploy configs register the six entries of panels/default.json; the first three are the registered ones", () => {
    const six = panelFile("default.json").deploy;
    expect(DEPLOY_CONFIGS).toEqual(["fork-demo.json", "local-demo.json", "local-fast.json", "local-production.json", "local-test.json"]);
    for (const f of DEPLOY_CONFIGS) {
      const c = JSON.parse(readFileSync(join(CONFIG, f), "utf8")) as { gpus: Deploy[] };
      expect({ f, gpus: c.gpus }).toEqual({ f, gpus: six });
      for (const [i, g] of OLD.entries()) expect(c.gpus[i]!.recipeHash).toBe(REGISTERED["default.json"][g]![0]);
    }
  });

  test("byte for byte against the commit before: panel entries, deploy configs and the archive fixture's cells", () => {
    const base = atBase("wall/packages/sources/panels/default.json");
    if (base === null) {
      console.log(`git or commit ${BASE} not available: skipping the byte comparison (the constants above still pin the entries)`);
      return;
    }
    for (const name of ["default.json", "launch.json"]) {
      const was = JSON.parse(atBase(`wall/packages/sources/panels/${name}`)!) as { panels: Panel[]; deploy: Deploy[] };
      const now = panelFile(name);
      for (let i = 0; i < 3; i++) {
        expect(JSON.stringify(now.panels[i], null, 1)).toBe(JSON.stringify(was.panels[i], null, 1));
        expect(JSON.stringify(now.deploy[i], null, 1)).toBe(JSON.stringify(was.deploy[i], null, 1));
      }
    }
    for (const f of DEPLOY_CONFIGS) {
      const was = atBase(`contracts/script/config/${f}`)!;
      const now = readFileSync(join(CONFIG, f), "utf8");
      // the file up to the end of its third GPU entry is unchanged; only entries were appended after it
      const cut = was.lastIndexOf("\n  }") + 4;
      expect(now.startsWith(was.slice(0, cut)), f).toBe(true);
    }
    for (const f of MARKET_CONFIGS) expect(readFileSync(join(CONFIG, f), "utf8"), f).toBe(atBase(`contracts/script/config/${f}`)!);
    // the archive fixture's cells of the first three GPUs, hour for hour, as the commit before wrote them
    type Fix = { hours: { hour: string; fx: unknown; sources: Record<string, { rows: Record<string, unknown> } | null> }[] };
    const was = JSON.parse(atBase("wall/packages/sources/test/fixtures/archive-values.json")!) as Fix;
    const now = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "archive-values.json"), "utf8")) as Fix;
    let cells = 0;
    for (const h of was.hours) {
      const n = now.hours.find((x) => x.hour === h.hour)!;
      expect(n.fx).toEqual(h.fx);
      for (const [id, src] of Object.entries(h.sources)) {
        for (const g of OLD) {
          if (src?.rows[g] === undefined) continue;
          expect({ hour: h.hour, id, g, cell: n.sources[id]!.rows[g] }).toEqual({ hour: h.hour, id, g, cell: src.rows[g] });
          cells++;
        }
      }
    }
    expect(cells).toBeGreaterThanOrEqual(15 * 19);
  });
});

describe("testnet deploy configs register panels/launch.json", () => {
  const launch = panelFile("launch.json").deploy as unknown as DeployEntry[];
  const flagless = panelFile("default.json").deploy as unknown as DeployEntry[];

  test("every testnet-*.json present registers launch.json's entries exactly (scripts/deploy-gpus.ts writes them)", () => {
    const testnet = readdirSync(CONFIG).filter((f) => /^testnet-.*\.json$/.test(f));
    if (testnet.length === 0) console.log("no contracts/script/config/testnet-*.json yet: nothing to compare (write them with scripts/deploy-gpus.ts)");
    for (const f of testnet) {
      const c = JSON.parse(readFileSync(join(CONFIG, f), "utf8")) as { gpus: Deploy[] };
      expect({ f, gpus: c.gpus }).toEqual({ f, gpus: launch });
    }
  });

  test("deploy-gpus refuses a market config and anything that is not an index deploy config, writing nothing", () => {
    const script = join(import.meta.dir, "..", "scripts", "deploy-gpus.ts");
    for (const name of ["market-testnet", "market-local", "market-fork"]) {
      const path = join(CONFIG, `${name}.json`);
      const before = readFileSync(path, "utf8");
      const r = Bun.spawnSync([process.execPath, "run", script, name], { stdout: "pipe", stderr: "pipe" });
      expect({ name, code: r.exitCode }).toEqual({ name, code: 2 });
      expect(r.stderr.toString()).toContain("market config");
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  test("a testnet config never takes default.json: its L40S has one live source and its A100 is another set", () => {
    expect(panelFileFor("testnet-demo.json")).toBe("launch.json");
    expect(panelFileFor("testnet-production.json")).toBe("launch.json");
    for (const f of DEPLOY_CONFIGS) expect(panelFileFor(f)).toBe("default.json");
    expect(() => deployGpus("testnet-demo.json", "default.json", flagless)).toThrow(/registers panels\/launch.json, not default.json/);
    // even forced through, default.json's one-live L40S would be refused on a testnet config
    expect(liveFamilyCount(flagless.find((d) => d.gpu === "L40S")!)).toBe(1);
    expect(() => deployGpus("testnet-demo.json", "launch.json", flagless)).toThrow(/L40S has 1 live family; a testnet index needs at least three/);
    expect(deployGpus("testnet-demo.json", "launch.json", launch)).toEqual(launch);
    expect(launch.map(liveFamilyCount)).toEqual([5, 5, 5, 3, 3, 3]);
    // local chains keep default.json's six (the degenerate L40S is for tests only, 18.3)
    expect(deployGpus("local-demo.json", "default.json", flagless)).toEqual(flagless);
    const even = { ...launch[0]!, liveAtStartMask: 0b1111 };
    expect(() => deployGpus("local-demo.json", "default.json", [even])).toThrow(/even live family count \(4\)/);
  });

  test("withGpus replaces only the gpus array: the chainSelector above 2^53 and every other byte stay", () => {
    const text = readFileSync(join(CONFIG, "local-demo.json"), "utf8");
    const out = withGpus(text, launch);
    expect(out.slice(0, out.indexOf('"gpus":'))).toBe(text.slice(0, text.indexOf('"gpus":')));
    expect(out).toContain('"chainSelector": 2183018362218727504,');
    expect((JSON.parse(out) as { gpus: Deploy[] }).gpus).toEqual(launch);
    expect(out.slice(out.lastIndexOf("]") + 1)).toBe(text.slice(text.lastIndexOf("]") + 1)); // the file's own ending
    // a config written without gpus gets them appended
    const bare = text.slice(0, text.indexOf(',\n "gpus":')) + "\n}\n";
    const added = withGpus(bare, launch);
    expect((JSON.parse(added) as { gpus: Deploy[]; writerMode: number }).gpus).toEqual(launch);
    expect(added.startsWith(bare.slice(0, -3))).toBe(true);
  });
});

describe("the market side keeps three GPUs", () => {
  test("market configs list H100, H200 and B200 only", () => {
    expect(MARKET_CONFIGS.length).toBeGreaterThanOrEqual(3);
    for (const f of MARKET_CONFIGS) {
      const c = JSON.parse(readFileSync(join(CONFIG, f), "utf8")) as { gpus: { label: string; gpuId: string }[] };
      expect({ f, gpus: c.gpus }).toEqual({ f, gpus: OLD.map((g) => ({ label: g, gpuId: gpuIdOf(specOf(g)) })) });
    }
  });
});

describe("the GPU list lives in one place", () => {
  test("no source file of this package or @agate/report spells out the GPU list outside recipe.ts and the GpuModel type", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
    // the whole list as a literal (a source's own subset, such as Nebius's platforms, is a rule, not the list)
    const list = /\[\s*"H100",\s*"H200",\s*"B200"\s*\]|\[\s*"H100",\s*"H200",\s*"B200",\s*"B300",\s*"A100",\s*"L40S"\s*\]/;
    const hits: string[] = [];
    for (const f of [...files(join(import.meta.dir, "..", "src")), ...files(join(import.meta.dir, "..", "..", "report", "src"))]) {
      const code = readFileSync(f, "utf8");
      if (list.test(code) && !f.endsWith(join("pure", "recipe.ts"))) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});

// ------------------------------------------------------------------ the archived pages

const present = archivePresent();
const FROM = "2026-09-30T17";
const TO = "2026-10-03T08"; // the fixture's range: the hours the values below were checked over
const hours = present ? listHours().filter((h) => `${h.date}T${h.hour}` >= FROM && `${h.date}T${h.hour}` <= TO) : [];
const covered = hours.length > 0 && `${hours[0]!.date}T${hours[0]!.hour}` === FROM && `${hours.at(-1)!.date}T${hours.at(-1)!.hour}` === TO;
if (!covered) console.log(`archive absent or not covering ${FROM} to ${TO}: skipping the price-only GPU checks on archived pages (set AGATE_RAW_DIR)`);

function parsed(id: string): { hour: string; body: string; rows: ParseResult }[] {
  return hours.flatMap((h) => {
    const body = readArchived(h, id);
    if (body === null) return [];
    const t = pageTimeOf(h, id);
    const fx = archivedFx(h.date);
    const ctx: ParseContext = { utcDate: new Date(t * 1000).toISOString().slice(0, 10), nowSec: t, ...(fx ? { fx } : {}) };
    return [{ hour: `${h.date}T${h.hour}`, body, rows: parse(id, body, ctx) }];
  });
}

describe("the new rules on every archived hour of the fixture's range", () => {
  test.skipIf(!covered)("every source reads exactly the GPUs it has a rule for", () => {
    const want: Record<string, GpuModel[]> = {
      p_verda: [...OLD, ...NEW],
      p_nebius: [...OLD, "B300"],
      p_lambda: ["H100", "B200", "A100"],
      p_coreweave: [...OLD, ...NEW],
      p_civo: [...OLD, "B300", "L40S"],
      p_hyperstack: [...OLD, "B300", "A100"],
      p_seeweb: ["H100", "H200", "L40S"],
      p_gcore: ["H100", "H200"],
    };
    for (const s of SOURCES) {
      expect(GPUS.filter((g) => s.rules[g]), s.id).toEqual(want[s.id]!);
      for (const p of parsed(s.id)) expect(Object.keys(p.rows).sort(), `${p.hour} ${s.id}`).toEqual([...want[s.id]!].sort());
    }
    expect(hours.length).toBe(64);
  });

  test.skipIf(!covered)("Verda: never the B300 CC row, never the A100 40GB row; L40S its 8x row", () => {
    for (const p of parsed("p_verda")) {
      const rows = JSON.parse(p.body) as { model: string; price_per_hour: string; gpu: { number_of_gpus: number } }[];
      const eight = (model: string) => rows.filter((r) => r.model === model && r.gpu.number_of_gpus === 8).map((r) => r.price_per_hour);
      expect(eight("B300 CC").length, p.hour).toBe(1);
      expect(eight("A100 40GB").length, p.hour).toBe(1);
      expect(p.rows.B300).toMatchObject({ state: "VALID", gpuCount: 8, raw: eight("B300")[0] });
      expect(p.rows.B300!.raw).not.toBe(eight("B300 CC")[0]);
      expect(p.rows.A100).toMatchObject({ state: "VALID", gpuCount: 8, raw: eight("A100 80GB")[0] });
      expect(p.rows.A100!.raw).not.toBe(eight("A100 40GB")[0]);
      expect(p.rows.L40S).toMatchObject({ state: "VALID", gpuCount: 8, raw: eight("L40S")[0] });
      expect(["68.98", "69.66", "70.36"]).toContain(p.rows.B300!.raw!);
      expect(["14.30", "14.38"]).toContain(p.rows.A100!.raw!);
      expect(["12.34", "12.46"]).toContain(p.rows.L40S!.raw!);
    }
  });

  test.skipIf(!covered)("Nebius B300: the before-October-1 block until Oct 1 00 UTC, then the from block", () => {
    for (const p of parsed("p_nebius")) expect(p.rows.B300, p.hour).toMatchObject({ state: "VALID", gpuCount: 1, raw: p.hour < "2026-10-01T00" ? "7.85" : "9.50" });
  });

  test.skipIf(!covered)("Lambda A100: the 80 GB row of the 8x tab, never the 40 GB row that shares its plan name", () => {
    for (const p of parsed("p_lambda")) {
      expect(p.rows.A100, p.hour).toMatchObject({ state: "VALID", valueU: 2_790_000, raw: "2.79" });
      // the 40 GB row is there with the same plan name, and alone it is never read
      const forty = p.body.replace(/(data-plan="NVIDIA A100 SXM"><th\b[^<>]*>NVIDIA A100 SXM<\/th><td data-label="VRAM\/GPU">)80 GB/g, "$140 GB");
      expect(forty).not.toBe(p.body);
      const r = parse("p_lambda", forty, { utcDate: "2026-10-02", nowSec: Date.UTC(2026, 9, 2) / 1000 });
      expect(r.A100?.state).toBe("NO_ROW");
      expect(reasonOf(r.A100)).toBe("missing-row");
      expect(r.H100).toEqual(parse("p_lambda", p.body, { utcDate: "2026-10-02", nowSec: Date.UTC(2026, 9, 2) / 1000 }).H100);
    }
  });

  test.skipIf(!covered)('CoreWeave: B300 "Contact sales" is NOT_RENTABLE; A100 and L40S their exact rows', () => {
    for (const p of parsed("p_coreweave")) {
      expect(p.rows.B300, p.hour).toMatchObject({ state: "NOT_RENTABLE", valueU: 0 });
      expect(p.rows.B300!.detail).toMatch(/^not-rentable: NA NVIDIA HGX B300 x8: Contact sales$/);
      expect(p.rows.A100).toMatchObject({ state: "VALID", valueU: 2_700_000, raw: "21.60", gpuCount: 8 });
      expect(p.rows.L40S).toMatchObject({ state: "VALID", valueU: 2_250_000, raw: "18.00", gpuCount: 8 });
      // the L40 row and the GB300 row are on the same page and never read
      expect(p.body).toContain('data-product="nvidia-l40"');
      expect(p.body).toContain('data-product="nvidia-gb300-nvl72"');
    }
  });

  test.skipIf(!covered)("Civo: B300 without a memory suffix, L40S its 48GB table, no A100 read from its A100 80GB table", () => {
    for (const p of parsed("p_civo")) {
      expect(p.rows.B300, p.hour).toMatchObject({ state: "VALID", valueU: 7_490_000, raw: "59.92", gpuCount: 8 });
      expect(p.rows.L40S).toMatchObject({ state: "VALID", valueU: 1_290_000, raw: "10.32", gpuCount: 8 });
      expect(p.rows.A100).toBeUndefined();
      expect(p.body).toContain("<caption>NVIDIA A100 80GB GPU pricing</caption>");
    }
  });

  test.skipIf(!covered)("Hyperstack: A100 is the SXM row (1.60), never the PCIe rows (NVLink 1.40, plain 1.35); B300 7.40", () => {
    for (const p of parsed("p_hyperstack")) {
      expect(p.rows.A100, p.hour).toMatchObject({ state: "VALID", valueU: 1_600_000, raw: "1.60", gpuCount: 1 });
      expect(p.rows.B300).toMatchObject({ state: "VALID", valueU: 7_400_000, raw: "7.40", gpuCount: 1 });
      expect(p.rows.L40S).toBeUndefined();
      // without the SXM row the PCIe rows are still never read
      const noSxm = p.body.replace("<span>NVIDIA A100 SXM</span>", "<span>NVIDIA A100 SXM2</span>");
      expect(noSxm).not.toBe(p.body);
      const r = parse("p_hyperstack", noSxm, { utcDate: "2026-10-02", nowSec: Date.UTC(2026, 9, 2) / 1000 });
      expect(reasonOf(r.A100)).toBe("missing-row");
    }
  });

  test.skipIf(!covered)("Seeweb (EUR): L40S is the card whose form line says GPU PCI; H100 and H200 still need GPU SXM", () => {
    for (const p of parsed("p_seeweb")) {
      const eur = p.rows.L40S!;
      if (eur.state === "VALID") expect(eur.raw, p.hour).toBe("0.85");
      else expect(reasonOf(eur), p.hour).toBe("no-fx");
      for (const g of ["H100", "H200"] as const) expect(["VALID", "NO_ROW"]).toContain(p.rows[g]!.state);
      expect(p.rows.H100!.raw ?? "1.89").toBe("1.89");
      expect(p.rows.H200!.raw ?? "2.60").toBe("2.60");
      // an L40S card that says GPU SXM is not ours
      const sxm = p.body.replace(/(<span class="cardname">NVIDIA L40S<\/span>[\s\S]{0,4000}?)GPU PCI/, "$1GPU SXM");
      expect(sxm).not.toBe(p.body);
      const r = parse("p_seeweb", sxm, { utcDate: "2026-10-02", nowSec: Date.UTC(2026, 9, 2) / 1000, fx: { date: "2026-10-01", usdPerEur: "1.1298" } });
      expect(reasonOf(r.L40S)).toBe("missing-row");
      expect(r.H100?.state).toBe("VALID");
    }
  });
});

describe("the independent reader's readings of the same hours (AGATE_PRICE_ONLY_READINGS)", () => {
  const file = process.env.AGATE_PRICE_ONLY_READINGS;
  const on = covered && !!file && existsSync(file);
  if (!on) console.log("AGATE_PRICE_ONLY_READINGS unset or archive absent: skipping the cross-check against the research readings");
  test.skipIf(!on)("every (source, GPU) pair with a rule agrees in state, raw price, size and value on every hour", () => {
    type Line = { hour: string; source: string; gpu: GpuModel; state: string; raw?: string; n?: number; perGpu?: string };
    const lines = readFileSync(file!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
    const pages = new Map<string, ParseResult>();
    for (const s of SOURCES) for (const p of parsed(s.id)) pages.set(`${p.hour}|${s.id}`, p.rows);
    let checked = 0;
    for (const l of lines) {
      const def = SOURCES.find((s) => s.id === l.source)!;
      if (!def.rules[l.gpu] || !NEW.includes(l.gpu)) continue;
      const row = pages.get(`${l.hour}|${l.source}`)?.[l.gpu];
      expect(row, `${l.hour} ${l.source} ${l.gpu}`).toBeDefined();
      if (def.currency === "EUR") {
        // the reader reports the EUR price; ours is converted, or NO_ROW without a rate
        if (row!.state === "VALID") expect(row!.raw).toBe(l.raw!);
        else expect(reasonOf(row)).toBe("no-fx");
      } else if (l.state === "VALID") {
        const [i, f = ""] = l.perGpu!.split(".");
        expect({ s: row!.state as string, raw: row!.raw, n: row!.gpuCount, v: row!.valueU }).toEqual({ s: "VALID", raw: l.raw, n: l.n, v: Number(i) * 1_000_000 + Number(f.padEnd(6, "0")) });
      } else expect(row!.state as string).toBe(l.state);
      checked++;
    }
    expect(checked).toBe(64 * 13);
  });
});

// ------------------------------------------------------------------ synthetic pages: every exclusion of 18.2

const NOW = Date.UTC(2026, 9, 2, 8, 17) / 1000;
const ctx: ParseContext = { utcDate: "2026-10-02", nowSec: NOW, fx: { date: "2026-10-01", usdPerEur: "1.1298" } };

describe("the new rules on synthetic pages", () => {
  test("Verda: B300 CC alone is no B300; a B300 named otherwise is a layout change; A100 40GB is no A100", () => {
    const page = JSON.parse(renderPage("p_verda", { H100: { price: "3.66" }, B300: { price: "8.795" }, A100: { price: "1.7975" }, L40S: { price: "1.5575" } })) as Record<string, unknown>[];
    expect(parse("p_verda", JSON.stringify(page), ctx)).toMatchObject({
      B300: { state: "VALID", valueU: 8_800_000, raw: "70.36" },
      A100: { state: "VALID", valueU: 1_800_000, raw: "14.38" },
      L40S: { state: "VALID", valueU: 1_560_000, raw: "12.46" },
    });
    // the renderer's other rows include "B300 CC" and "A100 40GB"; with the real rows gone they read as nothing
    const without = page.filter((r) => !["B300", "A100 80GB", "L40S"].includes(r.model as string));
    const r = parse("p_verda", JSON.stringify(without), ctx);
    for (const g of NEW) expect(reasonOf(r[g]), g).toBe("missing-row");
    expect(r.H100?.state).toBe("VALID");
    const pcie = page.map((x) => (x.model === "B300" ? { ...x, name: "B300 PCIe 268GB" } : x.model === "L40S" ? { ...x, name: "L40S 48GB PCIe" } : x));
    const rp = parse("p_verda", JSON.stringify(pcie), ctx);
    expect(reasonOf(rp.B300)).toBe("layout-changed");
    expect(reasonOf(rp.L40S)).toBe("layout-changed");
    expect(rp.A100?.state).toBe("VALID");
    expect(rp.H100?.state).toBe("VALID");
  });

  test("Lambda A100: 8x over 1x, the 80 GB rows only; disagreeing 80 GB rows and a row without VRAM read nothing", () => {
    const page = renderPage("p_lambda", { H100: { price: "3.99" }, A100: { price: "2.79" } });
    expect(parse("p_lambda", page, ctx)).toMatchObject({ A100: { state: "VALID", valueU: 2_790_000 }, H100: { state: "VALID", valueU: 3_990_000 } });
    expect(parse("p_lambda", renderPage("p_lambda", { A100: { price: "1.89", count: 1 } }), ctx).A100).toMatchObject({ state: "VALID", valueU: 1_890_000 });
    // only the 40 GB rows (every tab has one): no A100
    expect(reasonOf(parse("p_lambda", renderPage("p_lambda", { H100: { price: "3.99" } }), ctx).A100)).toBe("missing-row");
    const row80 = '<tr class="row" data-plan="NVIDIA A100 SXM"><th scope="row" data-label="Plan">NVIDIA A100 SXM</th><td data-label="VRAM/GPU">80 GB</td>';
    const two = page.replace(row80, `${row80}<td data-label="PRICE/GPU/HR*">$2.99</td></tr>${row80}`);
    expect(reasonOf(parse("p_lambda", two, ctx).A100)).toBe("ambiguous");
    const noVram = page.replace(row80, '<tr class="row" data-plan="NVIDIA A100 SXM"><th scope="row" data-label="Plan">NVIDIA A100 SXM</th><td data-label="MEMORY">80 GB</td>');
    const nv = parse("p_lambda", noVram, ctx);
    expect(reasonOf(nv.A100)).toBe("layout-changed");
    expect(nv.H100).toMatchObject({ state: "VALID", valueU: 3_990_000 });
  });

  test('CoreWeave: "Contact sales" B300, a 40 GB A100, the L40 and a legacy A100 slug', () => {
    const page = renderPage("p_coreweave", { B300: { state: "not-rentable" }, A100: { price: "2.70" }, L40S: { price: "2.25" } });
    expect(parse("p_coreweave", page, ctx)).toMatchObject({
      B300: { state: "NOT_RENTABLE", valueU: 0 },
      A100: { state: "VALID", valueU: 2_700_000, raw: "21.60" },
      L40S: { state: "VALID", valueU: 2_250_000, raw: "18.00" },
    });
    expect(page).toContain("Contact sales");
    const forty = page.replace(/(data-product="nvidia-a100"[\s\S]*?<div class="table-v2-cell"><div>8<\/div><\/div>\n<div class="table-v2-cell"><div>)80/, "$140");
    expect(forty).not.toBe(page);
    expect(reasonOf(parse("p_coreweave", forty, ctx).A100)).toBe("missing-row");
    // no L40S row, only the L40 the renderer always shows; a legacy A100 slug only
    const noL40s = renderPage("p_coreweave", { A100: { price: "2.70" } });
    expect(noL40s).toContain('data-product="nvidia-l40"');
    expect(reasonOf(parse("p_coreweave", noL40s, ctx).L40S)).toBe("missing-row");
    const legacy = noL40s.replaceAll('data-product="nvidia-a100"', 'data-product="nvidia-a100-80gb"');
    expect(reasonOf(parse("p_coreweave", legacy, ctx).A100)).toBe("missing-row");
  });

  test("Civo: a B300 row with a memory suffix is not the rule's row; the A100 80GB table is never read", () => {
    const page = renderPage("p_civo", { B300: { price: "7.49" }, L40S: { price: "1.29" } });
    const r = parse("p_civo", page, ctx);
    expect(r).toMatchObject({ B300: { state: "VALID", valueU: 7_490_000, raw: "59.92" }, L40S: { state: "VALID", valueU: 1_290_000, raw: "10.32" } });
    expect(r.A100).toBeUndefined();
    expect(page).toContain("NVIDIA A100 80GB GPU pricing");
    const suffixed = page.replaceAll("x NVIDIA B300<", "x NVIDIA B300 - 288GB<");
    expect(suffixed).not.toBe(page);
    expect(reasonOf(parse("p_civo", suffixed, ctx).B300)).toBe("missing-row");
  });

  test("Hyperstack: A100 SXM only (with 80 GB), never the PCIe rows; B300; no L40S from the L40", () => {
    const page = renderPage("p_hyperstack", { B300: { price: "7.40" }, A100: { price: "1.60" } });
    expect(parse("p_hyperstack", page, ctx)).toMatchObject({ B300: { state: "VALID", valueU: 7_400_000 }, A100: { state: "VALID", valueU: 1_600_000 } });
    const only = renderPage("p_hyperstack", { B300: { price: "7.40" } });
    expect(only).toContain("NVIDIA A100 NVLink");
    expect(reasonOf(parse("p_hyperstack", only, ctx).A100)).toBe("missing-row");
    const forty = page.replace(/(<span>NVIDIA A100 SXM<\/span>\n<\/div>\n<div class="page-price_card_row_item_col page-price_card_row_item_col2">\n<span>)80/, "$140");
    expect(forty).not.toBe(page);
    expect(reasonOf(parse("p_hyperstack", forty, ctx).A100)).toBe("missing-row");
  });

  test("Seeweb: L40S needs GPU PCI on its card; H100 still needs GPU SXM", () => {
    const page = renderPage("p_seeweb", { H100: { price: "1.89" }, L40S: { price: "0.85" } });
    expect(parse("p_seeweb", page, ctx)).toMatchObject({ H100: { state: "VALID", valueU: 2_140_000 }, L40S: { state: "VALID", valueU: 960_000, raw: "0.85" } }); // x 1.1298
    const swapped = page.replace("GPU PCI |", "GPU SXM |"); // the first card is the L40S one
    expect(reasonOf(parse("p_seeweb", swapped, ctx).L40S)).toBe("missing-row");
    const h100pci = page.replace("GPU SXM |", "GPU PCI |");
    expect(reasonOf(parse("p_seeweb", h100pci, ctx).H100)).toBe("missing-row");
  });

  test("Nebius B300: the dated blocks like H100's; the L40S sections are never read", () => {
    const page = renderPage("p_nebius", { H100: { price: "4.50" }, B300: { price: "9.50" } }, { dated: { date: "2026-10-01", before: { H100: "3.85", B300: "7.85" } } });
    const at = (sec: number) => parse("p_nebius", page, { utcDate: new Date(sec * 1000).toISOString().slice(0, 10), nowSec: sec });
    const midnight = Date.UTC(2026, 9, 1) / 1000;
    expect(at(midnight - 1)).toMatchObject({ B300: { valueU: 7_850_000 }, H100: { valueU: 3_850_000 } });
    expect(at(midnight)).toMatchObject({ B300: { valueU: 9_500_000 }, H100: { valueU: 4_500_000 } });
    const l40s = `#### NVIDIA\u00ae L40S Intel\n\n<Tabs>\n  <Tab title="USD">\n    | **Item** | **Price** | **Per** |\n    | - | - | - |\n    | NVIDIA\u00ae L40S Intel. GPU | \\$1.35 | 1 GPU hour |\n    | NVIDIA\u00ae L40S Intel. CPU | \\$0.012 | 1 CPU hour |\n  </Tab>\n</Tabs>\n\n### Volumes`;
    const r = parse("p_nebius", page.replace("### Volumes", l40s), { utcDate: "2026-10-02", nowSec: NOW });
    expect(r.L40S).toBeUndefined();
    expect(r.B300).toMatchObject({ state: "VALID", valueU: 9_500_000 });
  });
});
