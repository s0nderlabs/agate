// The guardian CLI (BUILD-SPEC 10) on the fake index: status, check, look, veto (named, confirmed by digest), attest
// by R11 and R12 with their refusals, suspend, kick and replaced (F8).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardianLog } from "@agate/watcher";
import { GUARDIAN, KEEPER, Pages, W_ADDR, World } from "@agate/watcher/sim";
import { type CliDeps, run } from "../src/commands.ts";

const OCT1 = 20_727;
const NOV1 = 20_758;
const T = 2_400;
const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];

function deps(w: World, answers: string[] = []): CliDeps & { lines: string[]; glog: GuardianLog } {
  const lines: string[] = [];
  const glog = new GuardianLog(mkdtempSync(join(tmpdir(), "agate-guardian-")));
  return {
    view: w.chain,
    events: w.chain,
    log: w.log,
    glog,
    alerts: w.alerts,
    clock: w.c,
    panels: [w.panel],
    now: () => w.now,
    out: (l) => lines.push(l),
    prompt: async () => answers.shift() ?? "",
    senderFor: (k) => w.chain.sender(k === "AGATE_KICK_KEY" ? KEEPER : GUARDIAN),
    look: async (ids) => Object.fromEntries(ids.map((id) => [id, { H100: { state: "VALID", valueU: BASE[Number(id.slice(1))]! } }])),
    lines,
    writerRegion: "home",
  };
}

/** A thief primary freezes a 0.50 step on slot 2; with or without the attester and a standby. */
async function freezeWorld(o: { attester: boolean; standby: boolean; until: number }) {
  const D = OCT1 + 3;
  const pages = new Pages(BASE, [{ slot: 2, at: D * T, v: 3_900_000 }]);
  const freeze = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 2 && d === D ? BASE[2]! : x));
  const w = new World({ firstDay: OCT1, pages: pages.fn, writers: o.standby ? [{ net: "w1", values: freeze }, { net: "w2" }] : [{ net: "w1", values: freeze }], attester: o.attester ? true : { down: (t) => t >= D * T }, guardian: null });
  await w.run(o.until);
  return { w, D };
}

describe("guardian CLI", () => {
  test("status and check print the pending record, every candidate's verdicts and the hand ranges", async () => {
    const { w, D } = await freezeWorld({ attester: false, standby: true, until: (OCT1 + 4) * T + 450 });
    const d = deps(w);
    expect(await run(d, ["status"])).toBe(0);
    const text = d.lines.join("\n");
    expect(text).toContain(`pending ${D}`);
    expect(text).toContain("STRICT false");
    expect(text).toContain("R11 strict hand range");
    d.lines.length = 0;
    expect(await run(d, ["check", "H100", String(D)])).toBe(0);
    expect(d.lines.join("\n")).toContain("VETO fix range");
    d.lines.length = 0;
    expect(await run(d, ["check", "H100", String(OCT1 + 1)])).toBe(0); // a final day, recomputed from readings
    expect(d.lines.join("\n")).toContain(`day ${OCT1 + 1}`);
  });

  test("attest by R11: the thief's freeze is refused; the honest standby is selected and the signature logged", async () => {
    const { w, D } = await freezeWorld({ attester: false, standby: true, until: (OCT1 + 4) * T + 450 });
    const r = w.m.g(w.panel.gpuId).records.get(D)!;
    const sb = w.m.previewRecord(w.panel.gpuId, D, W_ADDR[1]!, w.now).detail!;
    const d = deps(w, ["yes"]);
    expect(await run(d, ["attest", "H100", String(D), "--writer", r.source, "--digest", r.digest])).toBe(1);
    expect(d.lines.join("\n")).toContain("refused");
    expect(await run(d, ["attest", "H100", String(D), "--writer", W_ADDR[1]!, "--digest", sb.digest])).toBe(0);
    expect(w.m.g(w.panel.gpuId).records.get(D)!.source).toBe(W_ADDR[1]!);
    expect(d.glog.signatures().map((s) => s.rule)).toEqual(["R11"]);
  });

  test("veto: refused for a record that is no longer the named one (F2); needs the digest typed; then sent", async () => {
    const { w, D } = await freezeWorld({ attester: false, standby: false, until: (OCT1 + 4) * T + 450 });
    const r = w.m.g(w.panel.gpuId).records.get(D)!;
    const d = deps(w, ["deadbeef"]);
    expect(await run(d, ["veto", "H100", String(D), "--source", r.source, "--digest", `0x${"11".repeat(32)}`])).toBe(1);
    expect(d.lines.join("\n")).toContain("VetoStale");
    expect(await run(d, ["veto", "H100", String(D), "--source", r.source, "--digest", r.digest])).toBe(1);
    expect(d.lines.join("\n")).toContain("not confirmed");
    expect(w.m.g(w.panel.gpuId).records.get(D)).toBeDefined();
    const d2 = deps(w, [r.digest.slice(2, 10)]);
    expect(await run(d2, ["veto", "H100", String(D), "--source", r.source, "--digest", r.digest])).toBe(0);
    expect(w.m.g(w.panel.gpuId).records.get(D)).toBeUndefined();
    expect(d2.lines[0]).toContain("veto only the record you checked");
  });

  test("replaced: after a select, the replaced writer's record is recomputed from readings (F8) and its R8 view printed", async () => {
    const { w, D } = await freezeWorld({ attester: true, standby: true, until: (OCT1 + 5) * T });
    const d = deps(w);
    const out = await run(d, ["replaced", "H100", String(D)]);
    expect(out).toBe(0);
    const text = d.lines.join("\n");
    expect(text).toContain("matches RecordReplaced.oldDigest");
    expect(text).toContain("R8 view: fix outside the VETO fix range true");
  });

  test("attest --r12: refused while a candidate passes R11 or before its time; signs a planted held value on a dead page", async () => {
    const start = NOV1 - 8;
    const base = [3_000_000, 3_200_000, 3_600_000, 3_800_000, 3_400_000];
    const plant = (dd: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 4 && dd < NOV1 && x ? 4_500_000 : x));
    const pages = new Pages(base, [], [{ slot: 4, from: NOV1 * T, to: (NOV1 + 1) * T, state: "DARK" }]);
    const w = new World({ firstDay: start, pages: pages.fn, liveMask: 0b01111, windows: [{ slot: 4, liveFrom: NOV1 }], writers: [{ net: "w1", values: plant }], guardian: null });
    await w.run((NOV1 + 1) * T + 500);
    const r = w.m.g(w.panel.gpuId).records.get(NOV1)!;
    expect(r.needsSign && r.attestedAt === 0).toBe(true);
    const d = deps(w, ["yes", "yes"]);
    expect(await run(d, ["attest", "H100", String(NOV1), "--writer", r.source, "--digest", r.digest])).toBe(1); // R11 refuses
    expect(await run(d, ["attest", "H100", String(NOV1), "--writer", r.source, "--digest", r.digest, "--r12"])).toBe(1); // too early, no looks
    expect(d.lines.join("\n")).toMatch(/R12's time comes|looks missing/);
    await w.run((NOV1 + 1) * T + 500 + w.c.guardAct);
    expect(await run(d, ["look", "H100", "--region", "home"])).toBe(0);
    expect(d.glog.looks(w.panel.gpuId).every((l) => l.writerRegion)).toBe(true);
    // the page of slot 4 is dark for everyone: a look there reads nothing
    d.look = async (ids) => Object.fromEntries(ids.map((id) => [id, { H100: id === "s4" ? { state: "NO_ROW", valueU: 0 } : { state: "VALID", valueU: base[Number(id.slice(1))]! } }]));
    expect(await run(d, ["look", "H100", "--region", "home", "--source", "s4"])).toBe(0);
    const code = await run(d, ["attest", "H100", String(NOV1), "--writer", r.source, "--digest", r.digest, "--r12"]);
    expect([code, d.lines.at(-1)]).toEqual([0, expect.stringContaining("attested")]);
    expect(d.glog.signatures().at(-1)!.rule).toBe("R12");
  });

  test("kick sends the call that would succeed; suspend needs confirmation", async () => {
    const pages = new Pages(BASE);
    const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1", close: "never" }], keeper: false, guardian: null });
    await w.run((OCT1 + 1) * T + w.c.closeGrace + 10);
    const d = deps(w, ["no"]);
    expect(await run(d, ["kick", "H100"])).toBe(0);
    expect(w.m.g(w.panel.gpuId).head).toBe(OCT1 + 1);
    expect(await run(d, ["suspend", W_ADDR[0]!])).toBe(1);
    expect(w.m.suspended.size).toBe(0);
    const d2 = deps(w, ["yes"]);
    expect(await run(d2, ["suspend", W_ADDR[0]!])).toBe(0);
    expect(w.m.suspended.size).toBe(1);
  });
});
