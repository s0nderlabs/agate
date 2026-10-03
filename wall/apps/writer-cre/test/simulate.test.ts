import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clockOf } from "@agate/writer-standby";
import { CONFIG_PATH_MAX, creSource, parseSimulateOutput, prepareRuntime, projectYaml, simulateArgs, toTake, workflowConfig } from "../src/simulate.ts";
import { creGasLimit } from "../src/runner.ts";

// Recorded stdout of real `cre workflow simulate` runs (CLI v1.35.0, SDK 1.23.0) on an anvil fork of Monad testnet,
// with synthetic pages from a local server (no third-party content, no keys).
const fixture = (n: string) => Bun.file(join(import.meta.dir, "fixtures", n)).text();
const WORKFLOW = join(import.meta.dir, "../workflow");

describe("simulate output", () => {
  test("broadcast run: result JSON, tx hash, success statuses", async () => {
    const { result } = parseSimulateOutput(await fixture("simulate-broadcast.stdout.txt"));
    expect(result).not.toBeNull();
    expect(result!).toMatchObject({ agate: 1, dayId: 20_727, slice: 5, index: "0xC0BF43A4Ca27e0976195E6661b099742f10507e5" });
    expect(result!.tx).toEqual({ status: 2, receiverStatus: 0, hash: "0x3f37f7347bb497fa2427d8f704661799801d28f21cf13bf1df4003ca1463a637", error: null });
    expect(result!.entries[0]!.values).toEqual([2_990_000, 6_160_000, 2_660_000, 0]);
    const take = toTake(result!, 2_500);
    expect(take.via).toBe("cre");
    expect(take.sent).toEqual({ ok: true, sent: true, txHash: "0x3f37f7347bb497fa2427d8f704661799801d28f21cf13bf1df4003ca1463a637" });
    expect(take.reading.entries[0]!.readAt).toBe(BigInt(result!.t));
    expect(take.reading.sources.find((s) => s.sourceId === "s_big")!.rows.H100!.state).toBe("FAILED"); // over the 250 KB cap
  });

  test("dry run (no --broadcast): nothing sent", async () => {
    const { result } = parseSimulateOutput(await fixture("simulate-dry.stdout.txt"));
    const take = toTake(result!, 6_400);
    expect(take.sent).toMatchObject({ ok: false, sent: false });
  });

  test("a receiver revert inside the forwarder's try/catch is not a success", () => {
    const take = toTake(
      { agate: 1, t: 1, index: "0x0000000000000000000000000000000000000001", dayId: 1, slice: 0, entries: [], sources: [], tx: { status: 2, receiverStatus: 1, hash: "0x01", error: null } },
      1,
    );
    expect(take.sent!.ok).toBe(false);
    expect(take.sent!.sent).toBe(true);
  });

  test("CLI errors come back as an error line; a result missing fields is refused", () => {
    const r = parseSimulateOutput("Initializing...\nLoading settings...\n\u001b[31m✗ validation error\u001b[0m\nConfigPath must be a maximum of 97 characters in length\n");
    expect(r.result).toBeNull();
    expect(r.error).toContain("validation error");
    const bad = parseSimulateOutput(`${JSON.stringify(JSON.stringify({ agate: 1, t: 1 }))}\n`);
    expect(bad.result).toBeNull();
    expect(bad.error).toMatch(/misses fields/);
    const login = parseSimulateOutput("Initializing...\n✗ authentication required: no credentials found\n");
    expect(login.error).toMatch(/authentication/);
  });
});

describe("the runtime project folder and the invocation", () => {
  test("args: project root is the runtime folder, relative short paths, broadcast only when asked", () => {
    const a = simulateArgs({ creBin: "cre", dir: "/w", target: "local-simulation", configPath: "./cfg.json", wasm: "./main.wasm", envFile: "/h/.env", limits: "default", broadcast: true, timeoutMs: 1 });
    expect(a.slice(0, 5)).toEqual(["workflow", "simulate", ".", "-R", "."]);
    expect(a).toContain("--non-interactive");
    expect(a.join(" ")).toContain("--trigger-index 0");
    expect(a.join(" ")).toContain("--config ./cfg.json --wasm ./main.wasm");
    expect(a.at(-1)).toBe("--broadcast");
    expect(simulateArgs({ creBin: "cre", dir: "/w", target: "t", configPath: "c", broadcast: false, timeoutMs: 1 })).not.toContain("--broadcast");
    expect(() => simulateArgs({ creBin: "cre", dir: "/w", target: "t", configPath: `./${"x".repeat(CONFIG_PATH_MAX)}`, broadcast: false, timeoutMs: 1 })).toThrow(/97/);
    expect(() => simulateArgs({ creBin: "cre", dir: "/w", target: "t", configPath: "./cfg.json", wasm: `/${"x".repeat(CONFIG_PATH_MAX)}`, broadcast: false, timeoutMs: 1 })).toThrow(/--wasm/);
  });

  test("prepareRuntime: workflow.yaml and main.ts copied, cfg.json written, project.yaml follows the CLI's key-free URL", () => {
    const dir = join(mkdtempSync(join(tmpdir(), `agate-cre-${"long-home-path-".repeat(5)}`)), "primary/cre/5fbdb231");
    expect(dir.length).toBeGreaterThan(CONFIG_PATH_MAX); // the old absolute --config would have been refused here
    const cfg = workflowConfig({ index: "0x5FbDB2315678afecb367f032d93F642f64180aa3", chainSelector: 1n, gasLimit: creGasLimit(), clock: clockOf({ day: 600, slices: 4, epochTs: 5, epochDay: 20_758 }), panels: [] });
    const rt = prepareRuntime({ dir, workflowDir: WORKFLOW, target: "local-simulation", chainName: "monad-testnet", config: cfg });
    expect(readFileSync(join(dir, "workflow.yaml"), "utf8")).toBe(readFileSync(join(WORKFLOW, "workflow.yaml"), "utf8"));
    expect(readFileSync(join(dir, "main.ts"), "utf8")).toContain("Runner.newRunner");
    expect(JSON.parse(readFileSync(join(dir, "cfg.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(cfg)));
    rt.setRpc("https://rpc-a.example");
    expect(readFileSync(join(dir, "project.yaml"), "utf8")).toBe(projectYaml("local-simulation", "monad-testnet", "https://rpc-a.example"));
    rt.setRpc("https://rpc-b.example");
    expect(readFileSync(join(dir, "project.yaml"), "utf8")).toContain('url: "https://rpc-b.example"');
    // a URL with a path may carry an API key (Alchemy's does): never written (8.2 (2), 13.6)
    expect(() => rt.setRpc("https://rpc-a.example/v2/key0123456789abcdef")).toThrow(/key-free/);
    expect(readFileSync(join(dir, "project.yaml"), "utf8")).toContain('url: "https://rpc-b.example"');
    expect(() => projectYaml("local-simulation", "monad-testnet", 'http://x"\ny')).toThrow();
  });

  test("workflow config carries the index clock; HTTP timeout under CRE's 10 s cap; writeReport gas = ceil(1.5 x 1,076,000) (six entries of 15 slots, through the CRE simulation forwarder)", () => {
    const prod = workflowConfig({ index: "0x5FbDB2315678afecb367f032d93F642f64180aa3", chainSelector: 2183018362218727504n, gasLimit: creGasLimit(), clock: clockOf({ day: 86_400, slices: 24, epochTs: 0, epochDay: 0 }), panels: [] });
    expect(prod).toMatchObject({ chainSelector: "2183018362218727504", gasLimit: "1614000", timeout: "10s", role: "primary" });
    expect(prod.clock).toEqual({ day: 86_400, slices: 24, epochTs: 0, epochDay: 0, signAll: false });
    const fast = workflowConfig({ index: "0x5FbDB2315678afecb367f032d93F642f64180aa3", chainSelector: 1n, gasLimit: 1n, clock: clockOf({ day: 24, slices: 2, epochTs: 5, epochDay: 20_758, signAll: true }), panels: [] });
    expect(clockOf(fast.clock).tPend).toBe(6); // the workflow can derive a FAST clock (it throws without signAll)
    const demo = workflowConfig({ index: "0x5FbDB2315678afecb367f032d93F642f64180aa3", chainSelector: 1n, gasLimit: 1n, clock: clockOf({ day: 600, slices: 4, epochTs: 5, epochDay: 20_758 }), panels: [], sourceBaseUrl: "http://127.0.0.1:8787" });
    expect(demo.timeout).toBe("10s");
    expect(demo.sourceBaseUrl).toBe("http://127.0.0.1:8787");
    expect(creGasLimit(600_000n)).toBe(900_000n);
  });
});

describe("creSource", () => {
  const opts = { creBin: "cre", dir: "/w", target: "t", configPath: "./cfg.json", broadcast: true, timeoutMs: 1 };
  const at = { dayId: 20_727, slice: 5, readAt: 1_790_832_000 };

  test("a good run becomes the slice's reading, already sent; it ran holding the key", async () => {
    const stdout = await fixture("simulate-broadcast.stdout.txt");
    let held = 0;
    const r = await creSource(opts, () => {}, undefined, async () => ({ stdout, code: 0, ms: 2_400 }), {
      exclusive: async (fn) => {
        held += 1;
        return fn();
      },
    }).take(at);
    expect(held).toBe(1);
    expect(r.via).toBe("cre");
    expect(r.sent?.ok).toBe(true);
    expect(r.ms).toBe(2_400);
  });

  test("a failed run (or the key busy) falls back to the direct path, or throws without one", async () => {
    const events: string[] = [];
    const fallback = { take: async () => ({ reading: { ...at, entries: [], sources: [] }, via: "direct" as const }) };
    const bad = async () => ({ stdout: "✗ compile error", code: 1, ms: 10 });
    const r = await creSource(opts, (e) => void events.push(e), fallback, bad).take(at);
    expect(r.via).toBe("direct");
    expect(r.sent).toBeUndefined(); // the writer posts it through postReport
    expect(r.error).toContain("compile error");
    expect(events).toEqual(["simulate_failed"]);
    expect(creSource(opts, () => {}, undefined, bad).take(at)).rejects.toThrow(/simulate failed/);
    let ran = false;
    const busy = await creSource(opts, () => {}, fallback, async () => ((ran = true), { stdout: "", code: 0, ms: 0 }), { exclusive: async () => undefined }).take(at);
    expect(ran).toBe(false); // never runs the CLI while our own transaction holds the nonce
    expect(busy.via).toBe("direct");
    expect(busy.error).toMatch(/in flight/);
  });
});
