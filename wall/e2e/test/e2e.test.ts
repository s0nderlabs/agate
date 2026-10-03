// The whole wall on a local anvil (BUILD-SPEC 11, 12.6): every e2e and chaos scenario as a test. Opt-in, since the
// suite takes several minutes: AGATE_E2E=1 bun test e2e (from wall/). AGATE_E2E_ONLY=name,name runs a subset.
// Archive scenarios read AGATE_RAW_DIR in place and skip without it.
import { describe, expect, test } from "bun:test";
import { archivePresent } from "../src/archive.ts";
import { haveAnvil } from "../src/chain.ts";
import { printReport } from "../src/report.ts";
import { haveSandbox, SCENARIOS } from "../src/scenarios.ts";

const on = process.env.AGATE_E2E === "1" && haveAnvil();
const only = process.env.AGATE_E2E_ONLY?.split(",").filter(Boolean);

describe("wall e2e on anvil", () => {
  for (const s of SCENARIOS) {
    const skip = !on || (only !== undefined && !only.includes(s.name)) || (s.needsArchive === true && !archivePresent()) || (s.needsSandbox === true && !haveSandbox());
    test.skipIf(skip)(s.name, async () => {
      const r = await s.run();
      if (!r.ok) console.log(printReport(r, true));
      expect(r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
    }, 600_000);
  }
});
