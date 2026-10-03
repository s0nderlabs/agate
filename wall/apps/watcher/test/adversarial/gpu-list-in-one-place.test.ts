// Wall spec 18.4: every app takes its GPUs from GPUS (@agate/sources/pure) or from a panel file, never from a list
// of its own, so a seventh GPU is one line in recipe.ts. Scans the source of every app for a literal array of two or
// more GPU names and for a GPUS of its own. The exceptions are named with their reason: the Akash reader (display
// only, the market's three, out of scope), the page check's per-source tracker exclusions (a never-list, not a GPU
// list) and the repair agent's prompt text (an example inside a rule).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GPUS } from "@agate/sources/pure";

const APPS = join(import.meta.dir, "..", "..", "..");
const NAME = GPUS.join("|");
/** A literal array holding two or more GPU names, e.g. ["H100", "H200", "B200"] or ["B300", "A100"]. */
const LIST = new RegExp(`\\[\\s*"(?:${NAME})"\\s*,\\s*"(?:${NAME})"`);
/** A GPU list of its own: `const GPUS =` / `const GPUS: ... =` (importing or re-exporting GPUS is fine). */
const OWN = /\bconst\s+GPUS\b\s*[:=]/;

const ALLOWED: { file: string; line: RegExp; why: string }[] = [
  { file: "pagecheck/src/trackers.ts", line: /gtNever: \[.*geNever: \[/, why: "Hyperstack's tracker exclusions (a never-list per source)" },
  { file: "repair/src/untrusted.ts", line: /for \(const g of \["H100", "B200"\] as const\)/, why: "an example inside the AST rule's prompt text" },
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "dist") return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const sources = readdirSync(APPS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "akash") // the Akash reader: display only, H100/H200/B200 (18.4)
  .flatMap((e) => {
    try {
      return files(join(APPS, e.name, "src"));
    } catch {
      return [];
    }
  });

describe("no app keeps a GPU list of its own (18.4)", () => {
  test("the scan sees the apps that read GPUs", () => {
    const rel = sources.map((f) => relative(APPS, f));
    for (const f of ["writer-standby/src/core/reading.ts", "watcher/src/log/logger.ts", "watcher/src/readers.ts", "repair/src/agent.ts", "repair/src/gates.ts", "pagecheck/src/trackers.ts", "guardian/src/look.ts"]) expect(rel).toContain(f);
  });

  test("no literal list of GPU names and no GPUS of its own in any app's source", () => {
    const hits: string[] = [];
    for (const f of sources) {
      const rel = relative(APPS, f);
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!LIST.test(line) && !OWN.test(line)) return;
          if (ALLOWED.some((a) => a.file === rel && a.line.test(line))) return;
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
    }
    expect(hits).toEqual([]);
  });

  test("the apps that read GPUs import GPUS from @agate/sources/pure", () => {
    for (const f of ["writer-standby/src/core/reading.ts", "watcher/src/log/logger.ts", "watcher/src/readers.ts", "repair/src/agent.ts", "repair/src/gates.ts"]) {
      expect({ f, imports: /import \{[^}]*\bGPUS\b[^}]*\} from "@agate\/sources\/pure"/.test(readFileSync(join(APPS, f), "utf8")) }).toEqual({ f, imports: true });
    }
  });
});
