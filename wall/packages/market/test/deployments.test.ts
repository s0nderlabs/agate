// BOTS-SPEC 1: loadDeployments fails closed, naming the field and never the value.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeploymentsError, firstBlock, loadDeployments, parseDeployments } from "../src/deployments.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const good = () => ({
  chainId: 10143,
  dollar: A(1),
  kuru: { router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630", marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" },
  factories: {
    demo: { index: A(2), dollar: A(1), tag: "demo", factory: A(3), router: A(4), tPend: 210, startBlock: 67_900_000 },
    real: { index: A(5), dollar: A(1), tag: "", factory: A(6), router: A(7), tPend: 21_600, startBlock: 67_800_000 },
  },
});

describe("loadDeployments", () => {
  test("a good file parses; startBlock is a bigint; the smallest startBlock is the scan's first block", () => {
    const d = parseDeployments(JSON.stringify(good()), { chainId: 10143 });
    expect(d.factories.demo!.startBlock).toBe(67_900_000n);
    expect(d.factories.real!.tag).toBe("");
    expect(firstBlock(d)).toBe(67_800_000n);
    expect(firstBlock(d, ["demo"])).toBe(67_900_000n);
  });
  const cases: [string, (j: ReturnType<typeof good>) => void, string][] = [
    ["chainId of another chain", (j) => (j.chainId = 1), "chainId"],
    ["chainId not a number", (j) => ((j as unknown as { chainId: string }).chainId = "10143"), "chainId"],
    ["dollar zero", (j) => (j.dollar = A(0)), "dollar"],
    ["dollar malformed", (j) => (j.dollar = "0x123"), "dollar"],
    ["kuru missing", (j) => delete (j as Partial<ReturnType<typeof good>>).kuru, "kuru"],
    ["kuru.router malformed", (j) => (j.kuru.router = "nope"), "kuru.router"],
    ["kuru.marginAccount malformed", (j) => (j.kuru.marginAccount = "0xzz"), "kuru.marginAccount"],
    ["no factories", (j) => ((j as unknown as { factories: object }).factories = {}), "factories"],
    ["factory.index zero", (j) => (j.factories.demo.index = A(0)), "factories.demo.index"],
    ["factory.dollar missing", (j) => delete (j.factories.demo as Partial<typeof j.factories.demo>).dollar, "factories.demo.dollar"],
    ["factory.factory malformed", (j) => (j.factories.real.factory = "0x1"), "factories.real.factory"],
    ["factory.router zero", (j) => (j.factories.real.router = A(0)), "factories.real.router"],
    ["tPend 0", (j) => (j.factories.demo.tPend = 0), "factories.demo.tPend"],
    ["tPend fractional", (j) => (j.factories.demo.tPend = 1.5), "factories.demo.tPend"],
    ["startBlock negative", (j) => (j.factories.demo.startBlock = -1), "factories.demo.startBlock"],
    ["startBlock missing", (j) => delete (j.factories.demo as Partial<typeof j.factories.demo>).startBlock, "factories.demo.startBlock"],
    ["tag with capitals", (j) => (j.factories.demo.tag = "Demo"), "factories.demo.tag"],
  ];
  for (const [name, mutate, field] of cases) {
    test(`refuses: ${name} (names ${field}, never the value)`, () => {
      const j = good();
      mutate(j);
      let err: Error | null = null;
      try {
        parseDeployments(JSON.stringify(j), { chainId: 10143 });
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeInstanceOf(DeploymentsError);
      expect(err!.message).toContain(field);
      expect(err!.message).not.toContain("0x0000");
      expect(err!.message).not.toContain("nope");
    });
  }
  test("kuru.router may be zero (a chain without Kuru); marginAccount may be absent unless required", () => {
    const j = good() as unknown as { kuru: Record<string, string> };
    j.kuru.router = A(0);
    delete j.kuru.marginAccount;
    expect(parseDeployments(JSON.stringify(j)).kuru.router).toBe(A(0) as `0x${string}`);
    expect(() => parseDeployments(JSON.stringify(j), { marginAccount: "required" })).toThrow("kuru.marginAccount");
  });
  test("the maker requires Kuru's margin account: zero is refused, naming the field", () => {
    const j = good();
    j.kuru.marginAccount = A(0);
    expect(() => parseDeployments(JSON.stringify(j), { chainId: 10143, marginAccount: "required" })).toThrow("kuru.marginAccount");
    expect(parseDeployments(JSON.stringify(good()), { chainId: 10143, marginAccount: "required" }).kuru.marginAccount).toBe("0xd029C2D98ff85D8F64799017fE00a59B1159CE02");
  });
  test("not JSON, unreadable", () => {
    expect(() => parseDeployments("{")).toThrow(DeploymentsError);
    expect(() => loadDeployments("/nonexistent/agate/deployments.json")).toThrow("cannot be read");
    const dir = mkdtempSync(join(tmpdir(), "agate-market-dep-"));
    writeFileSync(join(dir, "d.json"), JSON.stringify(good()));
    expect(loadDeployments(join(dir, "d.json"), { chainId: 10143 }).chainId).toBe(10143);
  });
});

