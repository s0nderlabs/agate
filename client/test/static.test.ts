// The generated files match their sources, the package stays browser-safe, and the shapes keep the app's fields.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderAbi, renderStatic } from "../scripts/gen-static.ts";
import { PANELS, TESTNET_DEPLOYMENTS, TESTNET_INDEXES } from "../src/static.ts";

const SRC = join(import.meta.dir, "..", "src");
const ROOT = join(import.meta.dir, "..", "..");

describe("generated files", () => {
  test("src/abi.ts is the wall's generated ABIs, subset (rerun bun run gen when this fails)", async () => {
    expect(readFileSync(join(SRC, "abi.ts"), "utf8")).toBe(await renderAbi());
  });
  test("src/static.ts is the deployments files and the launch panel (rerun bun run gen when this fails)", async () => {
    expect(readFileSync(join(SRC, "static.ts"), "utf8")).toBe(await renderStatic());
  });
  test("the panel: six GPUs, slot counts of the deploy, H100's reserve is Hyperstack", () => {
    expect(PANELS.map((p) => p.gpu)).toEqual(["H100", "H200", "B200", "B300", "A100", "L40S"]);
    expect(PANELS.map((p) => p.slots.length)).toEqual([6, 5, 5, 4, 4, 3]);
    expect(PANELS[0]!.slots.find((s) => !s.liveAtStart)?.family).toBe("Hyperstack");
    expect(TESTNET_DEPLOYMENTS.chainId).toBe(10143);
    expect(TESTNET_INDEXES.production?.firstDay).toBe(20730);
    expect(TESTNET_DEPLOYMENTS.factories.real?.index.toLowerCase()).toBe(TESTNET_INDEXES.production!.index.toLowerCase());
  });
});

describe("browser-safe", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  test("src/ imports only viem and its own files; no node:*, no Bun, no fs", () => {
    for (const f of files) {
      const text = readFileSync(join(SRC, f), "utf8");
      for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        expect(spec === "viem" || spec === "viem/accounts" || spec.startsWith("./")).toBe(true);
      }
      expect(text).not.toMatch(/["']node:/);
      expect(text).not.toMatch(/\bBun\./);
      expect(text).not.toMatch(/require\(/);
    }
  });
  test("process is read only for NEXT_PUBLIC_AGATE_GRAPHQL_URL, behind a typeof guard", () => {
    for (const f of files) {
      const uses = [...readFileSync(join(SRC, f), "utf8").matchAll(/process\.[a-zA-Z_.]+/g)].map((m) => m[0]);
      for (const u of uses) expect(u).toBe("process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL");
    }
  });
  test("no private paths or build-process words in the package", () => {
    const all = [...files.map((f) => join(SRC, f)), ...readdirSync(join(SRC, "..", "e2e")).map((f) => join(SRC, "..", "e2e", f)), join(SRC, "..", "README.md")];
    for (const f of all) {
      const text = readFileSync(f, "utf8");
      expect(text.includes(String.fromCharCode(0x2014))).toBe(false); // no em dash
      expect(text).not.toMatch(/\/Users\//);
      expect(text).not.toMatch(/\b(phase \d|recheck|fix round)\b/i);
    }
  });
});

describe("the app's shapes", () => {
  // the field names of app/src/lib/mock/types.ts and market.ts (Oct 4 2026), which the client must keep
  const types = readFileSync(join(SRC, "types.ts"), "utf8");
  const fields: Record<string, string[]> = {
    SourceReading: ["family", "price", "live"],
    IndexDay: ["date", "price", "status", "example"],
    Quote: ["bid", "ask", "last"],
    Series: ["gpu", "month", "name", "symbol", "n", "floor", "cap", "phase", "opensOn", "k", "S", "quote", "openInterest", "listedAt", "closesAt"],
    Market: ["gpu", "price", "prevPrice", "updatedAt", "sources", "history", "series", "nextUpdateAt", "liveCount", "panelSize"],
    Position: ["id", "gpu", "month", "side", "q", "entry", "daily", "paid", "openedAt"],
    Wallet: ["signedIn", "email", "balance", "lastDrip", "positions"],
    BookLevel: ["price", "size"],
    Fill: ["time", "side", "price", "size"],
    TickerItem: ["label", "price", "change"],
    Candle: ["t", "o", "h", "l", "c", "v"],
    OpenOrder: ["id", "gpu", "month", "side", "price", "q", "placedAt"],
  };
  for (const [name, fs] of Object.entries(fields)) {
    test(`${name} keeps ${fs.join(", ")}`, () => {
      const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(types)?.[1] ?? "";
      for (const f of fs) expect(body).toMatch(new RegExp(`\\n  ${f}\\??:`));
    });
  }
  test("Gpu is the six index GPUs", () => {
    expect(types).toContain('export type Gpu = "H100" | "H200" | "B200" | "B300" | "A100" | "L40S";');
  });
  test("the repo files the generator reads exist", () => {
    for (const f of ["contracts/deployments/10143.json", "contracts/deployments/10143-indexes.json", "wall/packages/sources/panels/launch.json"]) expect(readFileSync(join(ROOT, f), "utf8").length).toBeGreaterThan(10);
  });
});
