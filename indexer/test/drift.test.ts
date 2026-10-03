// Drift (BOTS-SPEC 5.7 items 1 and 2): abis/*.json against the Foundry build and Kuru's deployed topics; config.yaml
// and src/lib/deployments.generated.ts against gen:config on the test deployments file; the schema against the spec.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type AbiEvent, toEventSelector } from "viem";
import { describe, expect, it } from "vitest";
import { FORGE_ABIS, abiJson, buildAbis, forgeOut, kuruOrderBookAbi } from "../scripts/abis.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CONTRACT_EVENTS, missingIndexStarts, parseArgs, parseDeployments, renderConfig } from "../scripts/config-gen.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// BOTS-SPEC Appendix D: every Kuru event topic found in the deployed OrderBook implementation on Monad testnet
// (0x72caE0a99C19B574e8a6De558F43fc1D019c9374, Oct 3 2026; full hashes in bots-indexer-20261003/deployed-code-check.txt).
const KURU_TOPICS: Record<string, string> = {
  OrderCreated: "0xb81bbaf150467ef3096ed6220cb963abc169bffd2eb88f26c47359ef344cf94c",
  OrderCanceled: "0xd9c089818ef223629c2af53488dc47cf2867f157caca778ce77aaa742b8c1079",
  OrdersCanceled: "0x386974f41b61738b510019ccd5a3524a43eccf0d136929e09d524e87aeeca2c4",
  Trade: "0xf16924fba1c18c108912fcacaac7450c98eb3f2d8c0a3cdf3df7066c08f21581",
  FlipOrderCreated: "0xf81d3fdea8a7ee9c5c09179882e1bce1c513a741146e453167d9e8912c8eb3aa",
  FlippedOrderCreated: "0x49496a41b922bdba3ff7f57bb0992ab1a1a3ee95b5ae5bd7271c67861f018352",
  FlipOrderUpdated: "0xb74e966bc873b8c144fab39c9981210f50130885e89caf4556c0840cec741dcd",
  FlipOrdersCanceled: "0x5f815e5292cf3b123df58ad6d4531c085d94d5717a3b02740369a04273fde96c",
  MarketStateUpdated: "0x2c2c4ef339e909cfacf89e1e6664b2b0e89eec8cc4a739ff38632140d1969022",
};

describe("ABI drift", () => {
  it(`abis/*.json equal the Foundry build (${forgeOut()}) and Appendix C`, () => {
    const out = forgeOut();
    for (const rel of Object.values(FORGE_ABIS)) {
      if (!existsSync(join(out, rel))) throw new Error(`no Foundry artifact ${rel} under ${out}: forge build first (or set AGATE_FORGE_OUT)`);
    }
    const built = buildAbis(out);
    const files = readdirSync(join(ROOT, "abis")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
    expect(files).toEqual(Object.keys(built).sort());
    for (const [name, abi] of Object.entries(built)) expect(read(`abis/${name}.json`), name).toBe(abiJson(abi));
  });

  it("every Kuru topic equals the deployed implementation's (Appendix D)", () => {
    const events = (kuruOrderBookAbi as readonly unknown[] as AbiEvent[]).filter((x) => x.type === "event");
    expect(Object.fromEntries(events.map((e) => [e.name, toEventSelector(e)]))).toEqual(KURU_TOPICS);
  });

  it("our Trade event (IKuruOrderBook, the router's) is Kuru's", () => {
    const p = join(forgeOut(), "IKuruOrderBook.sol/IKuruOrderBook.json");
    const ours = (JSON.parse(readFileSync(p, "utf8")).abi as AbiEvent[]).find((x) => x.type === "event" && x.name === "Trade")!;
    expect(toEventSelector(ours)).toBe(KURU_TOPICS.Trade);
  });

  it("every configured event exists in its ABI", () => {
    for (const c of CONTRACT_EVENTS) {
      const abi = JSON.parse(read(`abis/${c.abi}.json`)) as AbiEvent[];
      for (const e of c.events) expect(abi.some((x) => x.type === "event" && x.name === e), `${c.name}.${e}`).toBe(true);
    }
  });
});

describe("config drift", () => {
  const input = JSON.parse(read("test/fixtures/deployments.test.json"));

  it("gen:config on the test deployments file reproduces config.yaml and deployments.generated.ts byte for byte", () => {
    const { yaml, ts } = renderConfig(parseDeployments(input), { source: "test/fixtures/deployments.test.json" });
    expect(read("config.yaml")).toBe(yaml);
    expect(read("src/lib/deployments.generated.ts")).toBe(ts);
  });

  it("config.yaml: one chain, HyperSync (no rpc, no URL), the pilot's dollar left out, dynamic contracts without addresses", () => {
    const yaml = read("config.yaml");
    expect(yaml).toContain("  - id: 10143\n");
    expect(yaml).not.toMatch(/rpc:|https?:\/\//);
    const pilot = parseDeployments(input).factories.find((f) => f.name === "pilot")!;
    expect(yaml).not.toContain(pilot.dollar);
    expect(yaml).toMatch(/- name: AgateSeries # dynamic: SeriesListed\n {6}- name: AgateToken # dynamic: SeriesListed\n {6}- name: KuruOrderBook/);
    expect(yaml).toContain("address_format: lowercase");
  });

  it("--rpc names ${ENVIO_RPC_URL} only; --index-start moves the index's start block", () => {
    const { yaml } = renderConfig(parseDeployments(input), { rpc: true, indexStart: { demo: 3, real: 5 } });
    expect(yaml).toContain('      - url: "${ENVIO_RPC_URL}"\n        for: sync\n        interval_ceiling: 100\n');
    expect(yaml).not.toMatch(/https?:\/\//);
    expect(yaml).toMatch(/start_block: 3\n/);
    expect(parseArgs(["d.json", "--rpc", "--index-start", "demo=12", "--out", "config.fork.yaml"])).toEqual({ input: "d.json", out: "config.fork.yaml", rpc: true, indexStart: { demo: 12 }, noIndexStart: false });
    expect(() => renderConfig(parseDeployments(input), { indexStart: { nobody: 1 } })).toThrow(/no factory named nobody/);
  });

  it("gen:config fails closed without an --index-start for every index (audit M-2)", () => {
    const d = parseDeployments(input);
    const indexes = [...new Set(d.factories.map((f) => f.index))];
    expect(missingIndexStarts(d, {})).toEqual(indexes);
    const byIndex = Object.fromEntries(indexes.map((i) => [d.factories.find((f) => f.index === i)!.name, 7]));
    expect(missingIndexStarts(d, byIndex)).toEqual([]);
    expect(parseArgs(["d.json", "--no-index-start"]).noIndexStart).toBe(true);
    expect(() => parseArgs(["d.json", "--no-index-start", "--index-start", "demo=1"])).toThrow(/exclude/);
    // the CLI on a deployments file that is not the test world's: refused, and nothing is written
    const dir = mkdtempSync(join(tmpdir(), "agate-indexer-genconfig-"));
    try {
      const file = join(dir, "10143.json");
      writeFileSync(file, JSON.stringify(input));
      const before = [statSync(join(ROOT, "config.yaml")).mtimeMs, statSync(join(ROOT, "src/lib/deployments.generated.ts")).mtimeMs];
      const r = spawnSync("bun", ["run", "scripts/gen-config.ts", file, "--out", join(dir, "c.yaml")], { cwd: ROOT, encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--index-start");
      expect(existsSync(join(dir, "c.yaml"))).toBe(false);
      expect([statSync(join(ROOT, "config.yaml")).mtimeMs, statSync(join(ROOT, "src/lib/deployments.generated.ts")).mtimeMs]).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a bad deployments file, naming the field and never the value", () => {
    const bad = (mut: (d: any) => void) => {
      const d = JSON.parse(JSON.stringify(input));
      mut(d);
      return () => parseDeployments(d, 10143);
    };
    expect(bad((d) => (d.chainId = 1))).toThrow("deployments: chainId is not the expected chain");
    expect(bad((d) => (d.dollar = "0x1234"))).toThrow("deployments: dollar is not a 0x-prefixed 40-hex address");
    expect(bad((d) => (d.factories.demo.factory = "0x0000000000000000000000000000000000000000"))).toThrow("deployments: factories.demo.factory is the zero address");
    expect(bad((d) => (d.factories.demo.tPend = 0))).toThrow("deployments: factories.demo.tPend is not a positive integer");
    expect(bad((d) => delete d.factories.real.startBlock)).toThrow("deployments: factories.real.startBlock is not a nonnegative integer");
    expect(bad((d) => (d.factories.real.tag = "Real"))).toThrow("deployments: factories.real.tag is not 0 to 8 letters a to z");
    expect(bad((d) => (d.factories.pilot.tPend = 7))).toThrow("deployments: factories.pilot.tPend differs from another factory on the same index");
    expect(bad((d) => (d.factories.pilot.factory = d.factories.demo.factory))).toThrow("deployments: factories.pilot.factory appears twice");
    try {
      bad((d) => (d.dollar = "0xsecretvalue"))();
    } catch (e) {
      expect(String(e)).not.toContain("secretvalue");
    }
  });
});

describe("schema", () => {
  const spec = join(ROOT, "../docs/market/BOTS-SPEC.md");
  it.skipIf(!existsSync(spec))("schema.graphql is BOTS-SPEC Appendix B verbatim", () => {
    const md = readFileSync(spec, "utf8");
    const from = md.indexOf("## Appendix B.");
    const block = md.slice(md.indexOf("```graphql\n", from) + 11, md.indexOf("```\n", md.indexOf("```graphql\n", from) + 11));
    expect(read("schema.graphql")).toBe(block);
  });
});
