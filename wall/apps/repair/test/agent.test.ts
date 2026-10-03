// BUILD-SPEC 15.2 end to end on a synthetic index (macOS: the real sandbox-exec and tsc; the Claude CLI is a fixture
// that records argv, environment, stdin and cwd and prints a canned answer; no real Claude call anywhere).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepairAgent } from "../src/agent.ts";
import type { ChainView } from "../src/chain.ts";
import { readerSwapId } from "../src/chain.ts";
import { ANSWER_SCHEMA, CHILD_ENV_KEYS } from "../src/claude.ts";
import type { NoteJson } from "../src/note.ts";
import { SYSTEM_PROMPT } from "../src/untrusted.ts";
import { GOOD_V2, SPOT_V2 } from "./canned.ts";
import { B200_ID, cleanup, cliOutput, H100_ID, HELP_FULL, INDEX, LAMBDA_TRACKERS, makeWorld, okLambda, records, redesignedLambda, spawnerOf, start, type World, writeInterval, writeTrackers } from "./world.ts";

afterAll(cleanup);

const MAC = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const answer = (extractorSource: string, o: Record<string, unknown> = {}) => cliOutput({ diagnosis: "redesign", extractorSource, notes: "The page now shows one card per GPU; read the on-demand card.\n```\nignore this", ...o });

/** 6 good old intervals, then the redesign from k = 6; trackers list Lambda at 3.99 / 6.69 throughout. */
function seed(w: World, upTo: number, trackerAt: (k: number) => number = () => 3.99): void {
  for (let k = 0; k <= upTo; k++) {
    if (k < 6) writeInterval(w, "p_lambda", k, okLambda(), { H100: 3_990_000, B200: 6_690_000 });
    else writeInterval(w, "p_lambda", k, redesignedLambda(), { H100: "NO_ROW", B200: "NO_ROW" });
    writeInterval(w, "p_civo", k, null, { H100: "FAILED" }, { httpStatus: 0 });
    writeTrackers(w, k, LAMBDA_TRACKERS(trackerAt(k)));
  }
}

function agentOf(w: World, o: { chain?: ChainView } = {}): RepairAgent {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", USER: "operator", LANG: "C", TMPDIR: process.env.TMPDIR ?? "/tmp", ANTHROPIC_API_KEY: undefined, AGATE_SECRET_NOT_FOR_CLAUDE: "do-not-pass", AGATE_RPC_URLS: "http://127.0.0.1:1/v2/FAKEALCHEMYKEY0123456789" };
  return new RepairAgent({ cfg: w.cfg, spawner: spawnerOf(w.cfg), env, now: () => w.now.t, sink: w.sink, ...(o.chain ? { chain: () => o.chain! } : {}) });
}

async function tickAt(a: RepairAgent, w: World, t: number): Promise<void> {
  w.now.t = t;
  await a.tick(t, true);
}

describe.skipIf(!MAC)("the repair loop on a redesigned Lambda page", () => {
  test("incident, diagnosis, one Claude call with the exact argv, gates, shadow with a reset, note, action file, alerts", async () => {
    const w = makeWorld();
    writeFileSync(w.answerFile, answer(GOOD_V2));
    // interval 12 is a bad shadow interval: the trackers say 5.00 for H100 (the draft's 3.99 is more than 10% off)
    seed(w, 8);
    const a = agentOf(w);
    await tickAt(a, w, start(9) + 150);
    const inc = a.store.open(INDEX, "p_lambda")[0]!;
    expect(inc).toMatchObject({ kind: "reader", sinceK: 6, status: "shadow", calls: 1, diagnosis: { kind: "redesign" } });
    // Civo failed 9 intervals with no response: a fetch incident, diagnosed unsure, a note, never a draft
    expect(a.store.open(INDEX, "p_civo")[0]).toMatchObject({ kind: "fetch", status: "watch", diagnosis: { kind: "unsure" } });
    // the call: exact argv, prompt on stdin only, scrubbed environment, a fresh empty cwd deleted after
    const rec = records(w);
    expect(rec.length).toBe(1);
    const r = rec[0]!;
    expect(r.args).toEqual(["-p", "--restricted", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--json-schema", JSON.stringify(ANSWER_SCHEMA), "--system-prompt", SYSTEM_PROMPT]);
    expect(r.args.join(" ")).not.toContain("gpu-card");
    expect(r.stdin).toContain("<<<PAGE id=1 nonce=");
    expect(r.stdin).toContain('class="gpu-cards"');
    expect(r.stdin).toContain("TASK\nSource p_lambda (Lambda)");
    // fix round L3: the URL (from the chain or a redirect) sits in an untrusted NOTE, never in TASK
    const task = r.stdin.slice(0, r.stdin.indexOf("\n\nRULE\n"));
    expect(task).not.toContain("https://");
    expect(task).toContain("on the URL in NOTE 1");
    expect(r.stdin).toMatch(/NOTE 1: the URL the reader in force fetches \(the chain's reader history or the panel\)\n<<<NOTE id=1 nonce=[0-9a-f]{32}>>>\nhttps:\/\/lambda\.ai\/pricing\n<<<END nonce=[0-9a-f]{32}>>>/);
    const extra = Object.keys(r.env).filter((k) => !(CHILD_ENV_KEYS as readonly string[]).includes(k) && !/^(__CF_USER_TEXT_ENCODING|SHLVL|PWD|_|OLDPWD)$/.test(k));
    expect(extra).toEqual([]);
    expect(JSON.stringify(r.env)).not.toContain("FAKEALCHEMYKEY");
    expect(JSON.stringify(r.env)).not.toContain("do-not-pass");
    expect(r.cwdList).toEqual([]);
    expect(r.cwd).toContain(join("repair", "claude-cwd"));
    expect(existsSync(r.cwd)).toBe(false);
    // gates on file
    const draftDir = join(w.cfg.dir, "drafts", inc.draftId!);
    const gates = JSON.parse(readFileSync(join(draftDir, "gates.json"), "utf8"));
    expect(Object.keys(gates.gates)).toEqual(["gate 1", "gate 2", "gate 3", "gate 4", "gate 5"]);
    expect(gates.version).toBe("lambda/2");
    expect(readFileSync(join(draftDir, "extractor.ts"), "utf8")).toBe(GOOD_V2);
    expect(existsSync(join(draftDir, "prompt.txt"))).toBe(true);
    // shadow: k = 9, 10, 11 good, 12 bad (reset), 13 to 18 good: the note after k = 18
    for (let k = 9; k <= 18; k++) {
      writeInterval(w, "p_lambda", k, redesignedLambda(), { H100: "NO_ROW", B200: "NO_ROW" });
      writeTrackers(w, k, LAMBDA_TRACKERS(k === 12 ? 5.0 : 3.99));
      await tickAt(a, w, start(k + 1) + 150);
      const x = a.store.get(inc.id)!;
      if (k < 18) expect(x.status).toBe("shadow");
      if (k === 11) expect(x.shadow!.good).toBe(3);
      if (k === 12) expect(x.shadow!.good).toBe(0);
    }
    const done = a.store.get(inc.id)!;
    expect(done.status).toBe("noted");
    expect(done.shadow).toMatchObject({ good: 6, seen: 10 });
    const shadow = readFileSync(join(draftDir, "shadow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(shadow.map((s) => s.ok)).toEqual([true, true, true, false, true, true, true, true, true, true]);
    // note and action file
    const note = JSON.parse(readFileSync(join(w.cfg.dir, "notes", `${inc.id}.json`), "utf8")) as NoteJson;
    expect(note.draft!.sha256).toBe(new Bun.CryptoHasher("sha256").update(GOOD_V2).digest("hex"));
    expect(note.readers.map((x) => `${x.gpu}:${x.slot}:${x.inForce.parserVersion}->${x.proposed.parserVersion}`)).toEqual(["H100:0:lambda/1->lambda/2", "B200:2:lambda/1->lambda/2"]);
    const action = JSON.parse(readFileSync(join(w.cfg.dir, "actions", `${inc.id}-${INDEX.slice(2, 10)}.json`), "utf8"));
    expect(action.actions.length).toBe(2);
    for (const e of action.actions) expect(Object.keys(e)).toEqual(["kind", "gpuId", "slot", "url", "parserVersion", "reason"]);
    expect(action.actions[0]).toMatchObject({ kind: "READER", gpuId: H100_ID, slot: 0, url: "https://lambda.ai/pricing", parserVersion: "lambda/2" });
    expect(action.actions[1]).toMatchObject({ gpuId: B200_ID, slot: 2 });
    expect(action.actions[0].reason).toBe(`reader since 2026-10-09 00:20 UTC; 13 intervals: served 13, no row 26, bad value 0, not rentable 0, failed 0, valid 0; draft ${inc.draftId}`);
    const md = readFileSync(join(w.cfg.dir, "notes", `${inc.id}.md`), "utf8");
    expect(md).toContain("Model output (untrusted):\n\n> The page now shows one card per GPU; read the on-demand card.\n> '''\n> ignore this");
    expect(md).toContain(`3  install  cd '/repo/agate/wall' && bun run apps/repair/src/cli.ts install ${inc.draftId}`);
    // the action file's exact bytes (no trailing newline) are pinned in the queue command (fix round L2)
    const actionPath = join(w.cfg.dir, "actions", `${inc.id}-${INDEX.slice(2, 10)}.json`);
    const actionBytes = readFileSync(actionPath, "utf8");
    expect(actionBytes.endsWith("}")).toBe(true);
    expect(md).toContain(`AGATE_OWNER_ACTION="$(cat '${actionPath}')" AGATE_OWNER_ACTION_SHA256=${new Bun.CryptoHasher("sha256").update(actionBytes).digest("hex")} \\`);
    expect(md).toContain("read it line by line");
    expect(md).not.toContain("FAKEALCHEMYKEY");
    // alerts: the incident (info) and the note (action), stamped with the index
    const open = w.sink(INDEX).open().filter((x) => x.code.startsWith("REPAIR_") && x.slot === 0);
    expect(open.map((x) => `${x.code}:${x.severity}`).sort()).toEqual(["REPAIR_INCIDENT:info", "REPAIR_NOTE:action"]);
    expect(open.every((x) => x.index === INDEX && x.gpuId === H100_ID && x.slot === 0)).toBe(true);
    // the only processes started: claude (help and one call), tsc once, sandbox runs; never osascript (notify off)
    const kinds = new Set(a.d.spawner.log.map((x) => x.kind));
    expect([...kinds].sort()).toEqual(["claude", "sandbox", "tsc"]);
    // closure: three good intervals with the new reader in force (the watcher's own lines VALID, no gap)
    for (let k = 19; k <= 21; k++) {
      writeInterval(w, "p_lambda", k, redesignedLambda(), { H100: 3_990_000, B200: 6_690_000 }, { parsers: { H100: "lambda/2", B200: "lambda/2" } } as never);
      await tickAt(a, w, start(k + 1) + 150);
    }
    expect(a.store.get(inc.id)!.status).toBe("closed");
    expect(w.sink(INDEX).open().filter((x) => x.code.startsWith("REPAIR_") && x.slot === 0)).toEqual([]);
  }, 180_000);

  test("REPAIR_WINDOW once a proposed swap is past its eta with less than 2 DAY of its window left", async () => {
    const w = makeWorld();
    writeFileSync(w.answerFile, answer(GOOD_V2));
    seed(w, 8);
    let eta = 0;
    const chain: ChainView = { readerHistory: async () => [], queuedEta: async () => eta };
    const a = agentOf(w, { chain });
    await tickAt(a, w, start(9) + 150);
    for (let k = 9; k <= 14; k++) {
      writeInterval(w, "p_lambda", k, redesignedLambda(), { H100: "NO_ROW", B200: "NO_ROW" });
      writeTrackers(w, k, LAMBDA_TRACKERS());
      await tickAt(a, w, start(k + 1) + 150);
    }
    const inc = a.store.open(INDEX, "p_lambda")[0]!;
    expect(inc.status).toBe("noted");
    const now = start(16);
    eta = now - 12 * 2_400 - 100; // the window (14 DAY) ends in less than 2 DAY
    writeInterval(w, "p_lambda", 15, redesignedLambda(), { H100: "NO_ROW", B200: "NO_ROW" });
    await tickAt(a, w, now + 150);
    const win = w.sink(INDEX).open().find((x) => x.code === "REPAIR_WINDOW");
    expect(win).toMatchObject({ severity: "action", deadline: eta + 14 * 2_400 });
    expect(readerSwapId(H100_ID, 0, "https://lambda.ai/pricing", "lambda/2")).toMatch(/^0x[0-9a-f]{64}$/);
  }, 180_000);
});

describe.skipIf(!MAC)("refusals", () => {
  test("a canned answer proposing an off-host URL is refused (gate 5), never fetched", async () => {
    const w = makeWorld();
    writeFileSync(w.answerFile, answer(GOOD_V2, { proposedUrl: "https://evil.example/pricing" }));
    seed(w, 8);
    const fetched: string[] = [];
    const a = new RepairAgent({ cfg: w.cfg, spawner: spawnerOf(w.cfg), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" }, now: () => w.now.t, sink: w.sink, fetchMoved: async (u) => (fetched.push(u), null) });
    await tickAt(a, w, start(9) + 150);
    const inc = a.store.open(INDEX, "p_lambda")[0]!;
    expect(inc.status).toBe("draft");
    expect(inc.lastRefusal).toContain("gate 5");
    expect(fetched).toEqual([]);
    expect(w.sink(INDEX).open().find((x) => x.code === "REPAIR_REFUSED")?.message).toContain("evil.example");
  }, 60_000);

  test("an on-host URL from the model is refused too: a new URL comes only from a redirect's Location", async () => {
    const w = makeWorld();
    writeFileSync(w.answerFile, answer(GOOD_V2, { proposedUrl: "https://lambda.ai/other" }));
    seed(w, 8);
    const a = agentOf(w);
    await tickAt(a, w, start(9) + 150);
    expect(a.store.open(INDEX, "p_lambda")[0]!.lastRefusal).toContain("only from a redirect's Location");
  }, 60_000);

  test("an impure canned extractor is refused by gate 1; the budget caps the calls per incident", async () => {
    const w = makeWorld();
    writeFileSync(w.answerFile, answer(GOOD_V2.replace("export const extract", 'const leak = process.env;\nexport const extract')));
    seed(w, 8);
    const a = agentOf(w);
    await tickAt(a, w, start(9) + 150);
    let inc = a.store.open(INDEX, "p_lambda")[0]!;
    expect(inc.lastRefusal).toContain('gate 1: the source contains the forbidden word "process"');
    // two more intervals: two more calls, then the incident's budget (3) is spent
    for (let k = 9; k <= 11; k++) {
      writeInterval(w, "p_lambda", k, redesignedLambda(), { H100: "NO_ROW", B200: "NO_ROW" });
      writeTrackers(w, k, LAMBDA_TRACKERS());
      await tickAt(a, w, start(k + 1) + 150);
    }
    inc = a.store.get(inc.id)!;
    expect(records(w).length).toBe(3);
    expect(inc.status).toBe("refused");
    // fix round L3: the second prompt quotes the refusal only inside an untrusted NOTE, never in TASK
    const second = records(w)[1]!.stdin;
    const task = second.slice(0, second.indexOf("\n\nRULE\n"));
    expect(task).toContain("The previous draft was refused; NOTE 2 holds the refusal.");
    expect(task).not.toContain("forbidden word");
    expect(second).toMatch(/NOTE 2: why the previous draft was refused[^\n]*\n<<<NOTE id=2 nonce=[0-9a-f]{32}>>>\ngate 1: the source contains the forbidden word "process"/);
  }, 120_000);

  test("the audit's bypass (no forbidden word) is refused by gate 1's syntax allowlist and never run in the sandbox", async () => {
    const w = makeWorld();
    const bypass = GOOD_V2.replace("export const extract", 'const k = "constr" + "uctor";\nconst F: any = (0 as any)[k][k];\nexport const extract');
    writeFileSync(w.answerFile, answer(bypass));
    seed(w, 8);
    const a = agentOf(w);
    await tickAt(a, w, start(9) + 150);
    const inc = a.store.open(INDEX, "p_lambda")[0]!;
    expect(inc.lastRefusal).toContain("gate 1: syntax allowlist: line");
    expect(a.d.spawner.log.filter((x) => x.kind === "sandbox")).toEqual([]);
  }, 60_000);

  test("a wrong v2 (the spot cell) fails gate 3 inside the loop", async () => {
    const w = makeWorld();
    writeFileSync(w.answerFile, answer(SPOT_V2));
    seed(w, 8);
    const a = agentOf(w);
    await tickAt(a, w, start(9) + 150);
    expect(a.store.open(INDEX, "p_lambda")[0]!.lastRefusal).toContain("gate 3");
  }, 60_000);

  test("the start check refuses a CLI without the required flags, and no call is ever made", async () => {
    const w = makeWorld({ help: HELP_FULL.replace("  --restricted  Restricted mode\n", "") });
    writeFileSync(w.answerFile, answer(GOOD_V2));
    seed(w, 8);
    const a = agentOf(w);
    await tickAt(a, w, start(9) + 150);
    expect(a.cli).toEqual({ ok: false, why: "the Claude CLI lacks a required flag (--restricted)" });
    expect(records(w)).toEqual([]);
    // and one without --safe-mode (fix round L5): the operator's CLAUDE.md must never reach a repair call
    const w2 = makeWorld({ help: HELP_FULL.replace("  --safe-mode  Start with all customizations disabled\n", "") });
    const a2 = agentOf(w2);
    await a2.start();
    expect(a2.cli).toEqual({ ok: false, why: "the Claude CLI lacks a required flag (--safe-mode)" });
    expect(a.store.open(INDEX, "p_lambda")[0]!.status).toBe("refused");
    expect(w.sink(null).open().some((x) => x.code === "REPAIR_REFUSED" && x.message.includes("--restricted"))).toBe(true);
  }, 60_000);
});

describe("diagnoses that never draft", () => {
  test("blocked (HTTP 403 for 6 intervals): a note to reroute, no Claude call", async () => {
    const w = makeWorld();
    for (let k = 0; k < 8; k++) {
      writeInterval(w, "p_lambda", k, null, { H100: "FAILED", B200: "FAILED" }, { httpStatus: 403 });
      writeTrackers(w, k, LAMBDA_TRACKERS());
    }
    const a = agentOf(w);
    await tickAt(a, w, start(8) + 150);
    const inc = a.store.open(INDEX, "p_lambda")[0]!;
    expect(inc).toMatchObject({ kind: "fetch", status: "watch", diagnosis: { kind: "blocked" } });
    expect(records(w)).toEqual([]);
    const md = readFileSync(join(w.cfg.dir, "notes", `${inc.id}.md`), "utf8");
    expect(md).toContain("reroute the fetch (R4, R4b); a reader swap does not help");
    expect(md).toContain("Nothing to do: no swap is proposed.");
    expect(readdirSync(w.cfg.dir).includes("actions")).toBe(false);
  });
  test("moved off the source's hosts: refused, never fetched", async () => {
    const w = makeWorld();
    for (let k = 0; k < 8; k++) writeInterval(w, "p_lambda", k, null, { H100: "FAILED", B200: "FAILED" }, { httpStatus: 301, location: "https://pricing.evil.example/lambda" });
    const fetched: string[] = [];
    const a = new RepairAgent({ cfg: w.cfg, spawner: spawnerOf(w.cfg), env: {}, now: () => w.now.t, sink: w.sink, fetchMoved: async (u) => (fetched.push(u), null) });
    await tickAt(a, w, start(8) + 150);
    expect(a.store.open(INDEX, "p_lambda")[0]).toMatchObject({ status: "refused", lastRefusal: expect.stringContaining("moved off the source's hosts") });
    expect(fetched).toEqual([]);
  });
  test("the watcher followed a redirect off the source's hosts (2xx line with location): refused, no draft", async () => {
    const w = makeWorld();
    for (let k = 0; k < 6; k++) writeInterval(w, "p_lambda", k, okLambda(), { H100: 3_990_000, B200: 6_690_000 });
    for (let k = 6; k < 9; k++) writeInterval(w, "p_lambda", k, redesignedLambda(), { H100: "NO_ROW", B200: "NO_ROW" }, { location: "https://pricing.evil.example/lambda" });
    for (let k = 0; k < 9; k++) writeTrackers(w, k, LAMBDA_TRACKERS());
    const fetched: string[] = [];
    const a = new RepairAgent({ cfg: w.cfg, spawner: spawnerOf(w.cfg), env: {}, now: () => w.now.t, sink: w.sink, fetchMoved: async (u) => (fetched.push(u), null) });
    await tickAt(a, w, start(9) + 150);
    expect(a.store.open(INDEX, "p_lambda")[0]).toMatchObject({ kind: "reader", status: "refused", diagnosis: { kind: "moved" }, lastRefusal: expect.stringContaining("moved off the source's hosts") });
    expect(fetched).toEqual([]);
    expect(records(w)).toEqual([]);
  });
});

describe.skipIf(!MAC)("a moved source on its own hosts", () => {
  test("the agent fetches the Location once per interval; the reader in force reads it: a URL-only swap", async () => {
    const w = makeWorld();
    for (let k = 0; k < 6; k++) writeInterval(w, "p_lambda", k, okLambda(), { H100: 3_990_000, B200: 6_690_000 });
    for (let k = 6; k < 12; k++) writeInterval(w, "p_lambda", k, null, { H100: "FAILED", B200: "FAILED" }, { httpStatus: 301, location: "https://lambda.ai/pricing/gpu-cloud" });
    for (let k = 0; k < 40; k++) writeTrackers(w, k, LAMBDA_TRACKERS());
    const fetched: string[] = [];
    const a = new RepairAgent({ cfg: w.cfg, spawner: spawnerOf(w.cfg), env: { PATH: process.env.PATH ?? "" }, now: () => w.now.t, sink: w.sink, fetchMoved: async (u) => (fetched.push(u), { status: 200, body: new TextEncoder().encode(okLambda()) }) });
    for (let k = 12; k < 24; k++) {
      writeInterval(w, "p_lambda", k, null, { H100: "FAILED", B200: "FAILED" }, { httpStatus: 301, location: "https://lambda.ai/pricing/gpu-cloud" });
      await tickAt(a, w, start(k) + 150);
      await tickAt(a, w, start(k) + 199); // a second tick in the same interval: no second fetch
    }
    const inc = a.store.all().find((x) => x.sourceId === "p_lambda")!;
    expect(new Set(fetched)).toEqual(new Set(["https://lambda.ai/pricing/gpu-cloud"]));
    expect(fetched.length).toBe(9); // once per interval from k = 12 until the note at k = 20 (3 to test, 6 to shadow)
    expect(inc.status).toBe("noted");
    const note = JSON.parse(readFileSync(join(w.cfg.dir, "notes", `${inc.id}.json`), "utf8")) as NoteJson;
    expect(note.urlOnly).toBe(true);
    expect(note.draft).toBeNull();
    expect(note.readers[0]).toMatchObject({ inForce: { url: "https://lambda.ai/pricing", parserVersion: "lambda/1" }, proposed: { url: "https://lambda.ai/pricing/gpu-cloud", parserVersion: "lambda/1" } });
    expect(note.commands).toContain("3  install  skipped (URL-only swap");
    expect(records(w)).toEqual([]); // no Claude call
  }, 180_000);
});
