// The guardian CLI's Oct 3 upgrades (BUILD-SPEC 10, 17.2) on the fake index: status lists only live owner actions
// and reader swaps (queuedEta != 0) with kind and fields, expired ones only with --all, never an executed or
// cancelled one; the reader history; step 3b's deadline (6.6); day labels (9.6); keycheck (8.5); the withheld-slot
// refusal of attest (6.4); the page check's status file (15.1).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import { ACTION_WINDOW_DAYS, GuardianLog, printableLines, writeAtomic } from "@agate/watcher";
import { GUARDIAN, KEEPER, Pages, W_ADDR, World } from "@agate/watcher/sim";
import { ATTRIBUTION, type PairStatus, type StatusFile, statusPath } from "../../pagecheck/src/index.ts";
import { type CliDeps, HELP, run } from "../src/commands.ts";

const OCT1 = 20_727;
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
    writerRegion: "writer",
  };
}

describe("guardian status: the owner queue (4.11, 10)", () => {
  test("lists only queuedEta != 0, with kind and fields; an executed or cancelled action is not listed; an expired one only with --all", async () => {
    const w = new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1" }], guardian: null });
    await w.run(OCT1 * T + 100);
    const t0 = w.now;
    const g = w.panel.gpuId;
    const writerAct = { kind: 0, slot: 1, addr: "0x00000000000000000000000000000000000000b1" as Address, gpuId: `0x${"00".repeat(32)}` as Hex, day: 0, mode: 0 };
    const fwd = { kind: 3, slot: 0, addr: "0x00000000000000000000000000000000000000f1" as Address, gpuId: `0x${"00".repeat(32)}` as Hex, day: 0, mode: 1 };
    const liveFrom = { kind: 4, slot: 4, addr: "0x0000000000000000000000000000000000000000" as Address, gpuId: g, day: 20_788, mode: 0 };
    const executed = { ...writerAct, addr: "0x00000000000000000000000000000000000000e1" as Address };
    const cancelled = { ...writerAct, addr: "0x00000000000000000000000000000000000000c1" as Address };
    for (const a of [writerAct, fwd, executed, cancelled]) w.m.queueAction(a, t0);
    w.m.queueReaderSwap(g, 3, "https://s3.example/pricing", "s3/2", "pricing page redesigned", t0);
    w.m.executeAction(executed, t0 + w.c.timelock);
    w.m.cancelAction(cancelled, t0 + 5);
    w.m.queueAction(liveFrom, t0 + w.c.timelock); // queued later: still waiting
    await w.run(t0 + w.c.timelock + 10);
    const d = deps(w);
    expect(await run(d, ["status"])).toBe(0);
    const text = d.lines.join("\n");
    const q = d.lines.filter((l) => /^ {2}(WRITER|ATTESTER|GUARDIAN|FORWARDER|LIVE_FROM|LIVE_UNTIL|OWNER|reader swap) /.test(l));
    expect(q.length).toBe(4);
    expect(text).toContain(`WRITER slot 1 addr ${writerAct.addr}`);
    expect(text).toContain(`FORWARDER addr ${fwd.addr} mode WORKFLOW_OWNER`);
    expect(text).toContain(`LIVE_FROM gpu H100 slot 4 day 20788`);
    expect(text).toMatch(/LIVE_FROM .* in \d+ s \(window ends \d+\)/);
    expect(text).toMatch(/WRITER slot 1 .* executable, window ends in \d+ s/);
    expect(text).toContain('reader swap H100 slot 3 (s3): url https://s3.example/pricing parserVersion s3/2 reason "pricing page redesigned"');
    expect(text).not.toContain(executed.addr);
    expect(text).not.toContain(cancelled.addr);
    expect(text).not.toContain("expired (queue again to use)");
    // past the window of the first batch: they leave the list; --all shows them as expired
    await w.run(t0 + w.c.timelock + ACTION_WINDOW_DAYS * T + 10);
    const d2 = deps(w);
    await run(d2, ["status"]);
    const t2 = d2.lines.join("\n");
    const live = d2.lines.slice(d2.lines.findIndex((l) => l.startsWith("queued owner actions and reader swaps (live):")) + 1);
    const queue = live.slice(0, live.findIndex((l) => !l.startsWith("  ")));
    expect(queue.join("\n")).not.toContain(writerAct.addr);
    expect(queue.join("\n")).toContain("LIVE_FROM gpu H100 slot 4");
    // the queued WRITER change itself stays visible among the alerts: one info alert per action id (9.4)
    expect(t2).toMatch(new RegExp(`ActionQueued .*${writerAct.addr}`));
    const d3 = deps(w);
    await run(d3, ["status", "--all"]);
    const t3 = d3.lines.join("\n");
    const at = t3.indexOf("expired (queue again to use)");
    expect(at).toBeGreaterThan(0);
    expect(t3.slice(at)).toContain(`WRITER slot 1 addr ${writerAct.addr}`);
    expect(t3.slice(at)).toContain("reader swap H100 slot 3");
    expect(t3.slice(at)).not.toContain(executed.addr);
  });

  test("chain strings reach the terminal printable only: ESC, OSC 52, BEL, C1 and line breaks become ? (fix round M1)", async () => {
    const w = new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1" }], guardian: null });
    await w.run(OCT1 * T + 100);
    const g = w.panel.gpuId;
    // the model index takes any string (the contract refuses these at queue since the fix round; this is the CLI's own guard)
    const url = "https://s3.example/\u001b[2Jok";
    const reason = "benign\u001b]52;c;aGk=\u0007\nqueued owner actions and reader swaps (live): none\u009b";
    w.m.queueReaderSwap(g, 3, url, "s3/2\u001b[8m", reason, w.now);
    await w.run(w.now + 10);
    const d = deps(w);
    await run(d, ["status"]);
    const line = d.lines.find((l) => l.includes("reader swap H100 slot 3"))!;
    expect(line).toContain('url https://s3.example/?[2Jok parserVersion s3/2?[8m reason "benign?]52;c;aGk=??queued owner actions and reader swaps (live): none?"');
    for (const l of d.lines) expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    await w.run(w.now + w.c.timelock);
    w.m.executeReaderSwap(g, 3, url, "s3/2\u001b[8m", w.now);
    const d2 = deps(w);
    await run(d2, ["status"]);
    expect(d2.lines.join("\n")).toContain('https://s3.example/?[2Jok s3/2?[8m "benign?]52;c;aGk=??queued');
    for (const l of d2.lines) expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  test("reader swaps: the history of a swapped slot (fromDay, url, parserVersion, reason)", async () => {
    const w = new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1" }], guardian: null });
    await w.run(OCT1 * T + 100);
    const g = w.panel.gpuId;
    w.m.queueReaderSwap(g, 2, "https://s2.example/v2", "s2/2", "moved", w.now);
    await w.run(w.now + w.c.timelock);
    const fromDay = w.m.executeReaderSwap(g, 2, "https://s2.example/v2", "s2/2", w.now);
    expect(fromDay).toBe(w.m.dayId(w.now + w.c.slice) + 1);
    const d = deps(w);
    await run(d, ["status"]);
    expect(d.lines.join("\n")).toContain(`reader history H100 slot 2 (s2): from day ${fromDay}: https://s2.example/v2 s2/2 "moved"`);
    expect(d.lines.join("\n")).not.toMatch(/^ {2}reader swap/m); // executed: not queued any more
  });
});

describe("guardian status: step 3b, day labels, page check", () => {
  test("status prints step 3b's deadline (the later of VETO_BY and alert + GUARD_ACT) for a stuck needsSign record; labels carry the day", async () => {
    const D = OCT1 + 2;
    const withhold = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 4 && d >= D ? 0 : x));
    // nobody acting: the exit day D + 5 is a changed record no rule signs (the J refusal)
    const w = new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1", values: withhold }], guardian: null });
    await w.run((D + 6) * T + 600);
    const r = w.m.g(w.panel.gpuId).records.get(D + 5)!;
    expect(r.needsSign && r.attestedAt === 0).toBe(true);
    const d = deps(w);
    await run(d, ["status"]);
    const line = d.lines.find((l) => l.includes("step 3b"))!;
    const vetoBy = (D + 6) * T + w.c.grace - w.c.reopenWait;
    expect(line).toContain(`VETO_BY ${vetoBy}`);
    const due = Number(/due by (\d+)/.exec(line)![1]);
    const raised = w.alerts.open().filter((a) => a.code === "R1_NO_CANDIDATE" && a.day === D + 5).map((a) => a.at)[0]!;
    expect(due).toBe(Math.max(vetoBy, raised + w.c.guardAct));
    expect(line).toContain('"carried, unverified"');
    // the last final fixes carry the day label
    expect(d.lines.find((l) => l.includes("last final fixes"))).toMatch(/\d+: \d+\.\d\d final/);
  });

  test("the page check's pairs in a gap run (its StatusFile as PageCheck writes it), and open repair notes", async () => {
    const w = new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1" }], guardian: null });
    await w.run(OCT1 * T + 100);
    const home = mkdtempSync(join(tmpdir(), "agate-pc-"));
    const f = statusPath(home, w.chain.address);
    const g = w.panel.gpuId;
    const pair = (slot: number, sourceId: string, state: PairStatus["state"], over: Partial<PairStatus> = {}): PairStatus => ({ gpu: "H100", gpuId: g, slot, sourceId, lastK: null, own: null, t: null, tracker: null, gapBps: null, runStartK: null, runStartAt: null, gapped: 0, faultRaised: false, state, ...over });
    const st: StatusFile = {
      kind: "agate.pagecheck-status",
      index: w.chain.address.toLowerCase(),
      at: 1_790_900_000,
      lastComparedK: 40,
      trackersDownIntervals: 0,
      pairs: [
        pair(0, "p_lambda", "ok", { lastK: 40, own: 2_990_000, t: 2_990_000, tracker: "gpueconomy", gapBps: 0 }),
        pair(1, "p_verda", "fault", { lastK: 40, own: 3_000_000, t: 2_600_000, tracker: "gpueconomy", gapBps: 1_538, runStartK: 20, runStartAt: 1_790_860_000, gapped: 14, faultRaised: true }),
        pair(2, "p_nebius", "review", { lastK: 40, own: 3_100_000, t: 2_700_000, tracker: "gputable", gapBps: 1_481, runStartK: 39, runStartAt: 1_790_899_000, gapped: 2 }),
        pair(3, "p_crusoe", "unknown"), // never compared: no tracker row or no VALID reading yet, not a gap run
      ],
      attribution: ATTRIBUTION,
    };
    writeAtomic(f, JSON.stringify(st));
    w.alerts.raise({ code: "REPAIR_NOTE", severity: "action", message: "note ready: p_verda lambda/2" });
    const d = { ...deps(w), pagecheckStatus: f };
    await run(d, ["status"]);
    const t = d.lines.join("\n");
    expect(t).toContain("page check (as of 1790900000): 4 pair(s), 2 in a gap run, 1 not compared yet");
    expect(t).toContain("  p_verda H100 (slot 1): fault, 15.4% apart (reading 3.00 vs gpueconomy 2.60) since 1790860000, 14 gapped comparison(s)");
    expect(t).toContain("  p_nebius H100 (slot 2): review, 14.8% apart (reading 3.10 vs gputable 2.70) since 1790899000, 2 gapped comparison(s)");
    expect(t).not.toContain("p_lambda H100");
    expect(t).not.toContain("p_crusoe H100");
    expect(t).toContain("repair note: note ready: p_verda lambda/2");
    // a fresh page check (every pair still "unknown") reports no gap run
    writeAtomic(f, JSON.stringify({ ...st, pairs: st.pairs.map((p) => pair(p.slot, p.sourceId, "unknown")) }));
    const d2 = { ...deps(w), pagecheckStatus: f };
    await run(d2, ["status"]);
    expect(d2.lines.join("\n")).toContain("4 pair(s), 0 in a gap run, 4 not compared yet");
  });
});

describe("guardian look during an RPC outage, and multi-line output", () => {
  test("look fetches and records every look before any chain call: an unreachable chain loses no evidence", async () => {
    const w = new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1" }], guardian: null });
    await w.run(OCT1 * T + 100);
    const d = deps(w);
    w.chain.down = true;
    expect(await run(d, ["look", "H100", "--region", "writer"])).toBe(1); // the evaluation after the looks needs the chain
    const t = d.lines.join("\n");
    expect(t).toContain("events not synced (rpc down)");
    expect(t).toContain(`recorded ${new Set(w.panel.sources).size} look(s) from region writer (the writer's region)`);
    const looks = d.glog.looks(w.panel.gpuId);
    expect(looks.length).toBe(new Set(w.panel.sources).size);
    expect(looks.every((l) => l.writerRegion && l.state === "VALID")).toBe(true);
  });

  test("the help and a confirmation prompt keep their line feeds through the CLI's printableLines", () => {
    expect(printableLines(HELP)).toBe(HELP);
    expect(HELP.split("\n").length).toBeGreaterThan(5);
    const q = "suspend writer 0x00000000000000000000000000000000000000b1: it posts and closes nothing\nType yes to send: ";
    expect(printableLines(q)).toBe(q);
  });
});

describe("guardian keycheck (8.5, R8 (d))", () => {
  test("keycheck confirms a synthetic mismatch; a matching chain is not confirmed", async () => {
    const w = new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1" }], guardian: null });
    await w.run(OCT1 * T + 800);
    const g = w.panel.gpuId;
    const ev = w.chain.all().filter((e) => e.name === "ReadingsPosted" && e.day === OCT1).at(-1)!;
    if (ev.name !== "ReadingsPosted") throw new Error("no posts");
    // the writer's own log said something else for that slice (a second user of its key posted first)
    const logged = { readAt: ev.readAt - 7, values: ev.values.map((v, i) => (i === 2 ? v + 100_000 : v)) };
    w.alerts.raise({ code: "KEY_MISMATCH", severity: "action", gpuId: g, day: OCT1, slot: ev.slice, writer: W_ADDR[0]!, message: `${W_ADDR[0]} slice ${ev.slice}: onchain differs from my log`, data: { gpuId: g, day: OCT1, slice: ev.slice, onchain: { readAt: ev.readAt, values: ev.values }, logged } });
    const d = { ...deps(w), tx: async () => ({ from: W_ADDR[0]!, blockNumber: 9n }) };
    expect(await run(d, ["keycheck", W_ADDR[0]!])).toBe(0);
    const t = d.lines.join("\n");
    expect(t).toContain("logged by the writer: readAt");
    expect(t).toContain("chain now: ReadingsPosted");
    expect(t).toContain(`confirmed: another party posted with ${W_ADDR[0]}'s key`);
    // the alert's onchain side no longer matches the chain: not confirmed
    w.alerts.raise({ code: "KEY_MISMATCH", severity: "action", gpuId: g, day: OCT1, slot: ev.slice, writer: W_ADDR[0]!, message: "again", data: { gpuId: g, day: OCT1, slice: ev.slice, onchain: { readAt: ev.readAt + 1, values: ev.values }, logged } });
    const d2 = deps(w);
    await run(d2, ["keycheck", W_ADDR[0]!, "--day", String(OCT1)]);
    expect(d2.lines.join("\n")).toContain("NOT confirmed (the chain differs from the alert)");
    // suspend shows it as R8 (d) evidence
    const d3 = deps(w, ["no"]);
    await run(d3, ["suspend", W_ADDR[0]!]);
    expect(d3.lines.join("\n")).toContain("R8 (d) evidence");
  });

  test("keycheck on the writer's accumulator backstop (getLogs failed: a day, no slice), in the shape writer-standby raises", async () => {
    const w = new World({ firstDay: OCT1, pages: new Pages(BASE).fn, writers: [{ net: "w1" }], guardian: null });
    await w.run(OCT1 * T + 800);
    const g = w.panel.gpuId;
    const r = await w.chain.readings(g, OCT1, W_ADDR[0]!);
    const counts = r.counts.map(Number);
    const sums = r.sums.map(Number);
    const bits = [...Array(12).keys()].filter((h) => ((r.sliceBits >> BigInt(h)) & 1n) === 1n);
    expect(bits.length).toBeGreaterThan(0);
    let n = 0; // one alert id (no slice): a new message replaces the open alert's data
    const raise = (data: Record<string, unknown>) => w.alerts.raise({ code: "KEY_MISMATCH", severity: "action", gpuId: g, day: OCT1, writer: W_ADDR[0]!, message: `onchain counts or sums differ from the log (${++n})`, data: { gpuId: g, day: OCT1, via: "accumulators", ...data } });
    // the chain still shows the alert's side, and the log expected less on slot 1
    raise({ slots: [1], onchain: { counts, sums }, logged: { counts: counts.map((c, i) => (i === 1 ? c - 1 : c)), sums: sums.map((s, i) => (i === 1 ? s - 3_000_000 : s)) }, sliceBits: `0x${r.sliceBits.toString(16)}` });
    const d = deps(w);
    expect(await run(d, ["keycheck", W_ADDR[0]!])).toBe(0);
    let t = d.lines.join("\n");
    expect(t).toContain("(accumulator check)");
    expect(t).toContain("readings() now: sliceBits");
    expect(t).toContain("event: slice");
    expect(t).toContain(`confirmed: the chain holds readings ${W_ADDR[0]}'s log does not explain`);
    expect(t).not.toContain("cannot check");
    // the chain matches the log: not confirmed
    raise({ slots: [1], onchain: { counts, sums }, logged: { counts, sums } });
    const d2 = deps(w);
    await run(d2, ["keycheck", W_ADDR[0]!]);
    expect(d2.lines.join("\n")).toContain("NOT confirmed (the chain matches the writer's log)");
    // bits set for slices the writer never read: confirmed while every listed bit is set, not for an unset one
    raise({ slices: [bits[0]!] });
    const d3 = deps(w);
    await run(d3, ["keycheck", W_ADDR[0]!]);
    t = d3.lines.join("\n");
    expect(t).toContain(`slices the writer never read, per the alert: ${bits[0]}`);
    expect(t).toContain("confirmed: the chain holds readings");
    const unset = [...Array(12).keys()].find((h) => !bits.includes(h))!;
    raise({ slices: [unset] });
    const d4 = deps(w);
    await run(d4, ["keycheck", W_ADDR[0]!]);
    expect(d4.lines.join("\n")).toContain("NOT confirmed (a listed slice has no bit set onchain)");
  });
});

describe("guardian attest: the withheld-slot refusal (6.4, Oct 3)", () => {
  test("refuses a record that takes OUT a slot the watcher reads FRESH, naming the slot and the look to run; signs after a writer-region look confirms the block", async () => {
    const D = OCT1 + 2;
    const block = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 4 && d >= D ? 0 : x));
    // an honest writer blocked from slot 4 (the page is up for the watcher): on D + 5 the slot must leave
    const pages = new Pages(BASE, [], [{ slot: 4, from: D * T, to: (D + 10) * T, state: "FAIL", nets: ["w1", "look"] }]);
    const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1", values: block }], guardian: null });
    await w.run((D + 6) * T + 600);
    const r = w.m.g(w.panel.gpuId).records.get(D + 5)!;
    const d = deps(w, ["yes"]);
    expect(await run(d, ["attest", "H100", String(D + 5), "--writer", r.source, "--digest", r.digest])).toBe(1);
    expect(d.lines.join("\n")).toMatch(/withholds slot 4 .* run look from the writer's region/);
    // the writer's region cannot read slot 4 either: the block is confirmed and R11 judges the row as before
    d.look = async (ids) => Object.fromEntries(ids.map((id) => [id, { H100: id === "s4" ? { state: "FAILED", valueU: 0 } : { state: "VALID", valueU: BASE[Number(id.slice(1))]! } }]));
    expect(await run(d, ["look", "H100", "--region", "writer", "--source", "s4"])).toBe(0);
    expect(await run(d, ["attest", "H100", String(D + 5), "--writer", r.source, "--digest", r.digest])).toBe(0);
    expect(d.glog.signatures().at(-1)!.rule).toBe("R11");
  });
});
