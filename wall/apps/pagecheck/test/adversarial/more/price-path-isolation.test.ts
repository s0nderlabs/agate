// Recheck r2: the page check is alert-only and must never sit in the price path (BUILD-SPEC 15.1):
// no writer or watcher source may import @agate/pagecheck, and a PageCheck is built with no chain, sender, key or RPC.
// Only the repair agent consumes it. This guards the invariant that a tracker (untrusted, third-party data) can never
// move a published fix, however wrong a tracker is.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const WALL = resolve(import.meta.dir, "../../../../..");

/** Every .ts under a dir (no node_modules, no dist). */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...tsFiles(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("recheck r2: the page check is never in the price path", () => {
  test("no writer or watcher source file imports @agate/pagecheck", () => {
    const priceApps = ["writer-cre", "writer-standby", "watcher"].map((a) => join(WALL, "apps", a, "src"));
    const offenders: string[] = [];
    for (const dir of priceApps) {
      for (const f of tsFiles(dir)) {
        if (/from\s+["']@agate\/pagecheck["']|from\s+["']@agate\/pagecheck\//.test(readFileSync(f, "utf8"))) offenders.push(f.slice(WALL.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("only @agate/repair depends on @agate/pagecheck", () => {
    const deps = (app: string): string[] => {
      const pj = JSON.parse(readFileSync(join(WALL, "apps", app, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
      return Object.keys(pj.dependencies ?? {});
    };
    const users = readdirSync(join(WALL, "apps")).filter((a) => {
      try {
        return deps(a).includes("@agate/pagecheck");
      } catch {
        return false;
      }
    });
    expect(users).toEqual(["repair"]);
  });

  test("the pagecheck source names no chain, sender, RPC or key API", () => {
    // a crude but load-bearing check: the price path's chain/sender/key words never appear in pagecheck src
    const banned = /\bpostReport\b|\bcloseDay\b|\bprivateKey\b|\bprivate-key\b|eth_sendRawTransaction|AGATE_KEY|AGATE_RPC/;
    const hits: string[] = [];
    for (const f of tsFiles(join(WALL, "apps", "pagecheck", "src"))) {
      if (banned.test(readFileSync(f, "utf8"))) hits.push(f.slice(WALL.length + 1));
    }
    expect(hits).toEqual([]);
  });
});
