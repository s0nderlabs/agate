// One real `cre workflow simulate --broadcast` per slice against a private anvil, through the shared Writer exactly as
// the runner wires it (runtime folder, prebuilt WASM, the key held around the CLI, read-back after it).
// Opt-in: AGATE_CRE_SIMULATE=1. It needs the CRE CLI logged in (simulate makes one authenticated call to the CRE API
// per run) and the CRE simulation forwarder's runtime code, read from a local Foundry fork cache of Monad testnet
// (~/.foundry/cache/rpc/monad-testnet/*/storage.json) or from AGATE_CRE_FORWARDER_CODE (a file holding the hex).
// The anvil runs with chain id 10143 so the CLI's monad-testnet settings point at it. Anvil test keys only.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "@agate/report/types";
import { startReplay } from "@agate/sources/io";
import { sourcesApi } from "@agate/sources/pure";
import { directSource, indexChain, makeFetcher, PageReader, ReadingLog, RpcPool, sliceAt, startupChecks, timingFor, Writer } from "@agate/writer-standby";
import { ADDR, deployIndex, haveAnvil, KEYS, startAnvil } from "../../writer-standby/test/helpers/anvil.ts";
import { PRICES } from "../../writer-standby/test/helpers/world.ts";
import { CRE_SIM_FORWARDER, creGasLimit } from "../src/runner.ts";
import { creSource, prepareRuntime, workflowConfig } from "../src/simulate.ts";

const CRE = process.env.CRE_BIN ?? join(homedir(), ".cre/bin/cre");
const WORKFLOW = join(import.meta.dir, "../workflow");

function forwarderCode(): Hex | undefined {
  if (process.env.AGATE_CRE_FORWARDER_CODE) return readFileSync(process.env.AGATE_CRE_FORWARDER_CODE, "utf8").trim() as Hex;
  const dir = join(homedir(), ".foundry/cache/rpc/monad-testnet");
  if (!existsSync(dir)) return undefined;
  for (const b of readdirSync(dir).reverse()) {
    const f = join(dir, b, "storage.json");
    if (!existsSync(f)) continue;
    const acc = Object.entries((JSON.parse(readFileSync(f, "utf8")) as { accounts?: Record<string, { code?: { LegacyAnalyzed?: { bytecode?: string } } }> }).accounts ?? {}).find(
      ([k]) => k.toLowerCase() === CRE_SIM_FORWARDER.toLowerCase(),
    );
    const code = acc?.[1].code?.LegacyAnalyzed?.bytecode;
    if (code && code.length > 2) return code as Hex;
  }
  return undefined;
}

const code = process.env.AGATE_CRE_SIMULATE === "1" ? forwarderCode() : undefined;
const enabled = Boolean(haveAnvil && code && existsSync(CRE));
if (process.env.AGATE_CRE_SIMULATE === "1" && !enabled) console.warn("cre-simulate: skipped (needs anvil, the CRE CLI and the forwarder code)");

const stops: (() => void)[] = [];
afterAll(() => {
  for (const s of stops) s();
});

describe.skipIf(!enabled)("real CRE simulate on anvil (opt-in)", () => {
  test("two slices written through the CRE simulation forwarder, read back, nothing reposted", async () => {
    const a = await startAnvil({ chainId: 10_143 });
    stops.push(a.stop);
    await a.test.setCode({ address: CRE_SIM_FORWARDER, bytecode: code! });
    const profile = { day: 120, slices: 12, minReadings: 6, qMin: 1, demoLabel: true, signAll: true, epochDay: 20_727 };
    const dep = await deployIndex(a, { profile, forwarder: CRE_SIM_FORWARDER, epochTs: Math.floor(Date.now() / 1000) - 5 });
    const replay = startReplay({ clock: { t0: dep.epochTs, daySec: profile.day, slices: profile.slices }, scenario: PRICES });
    stops.push(replay.stop);

    const home = mkdtempSync(join(tmpdir(), "agate-cre-"));
    const pool = new RpcPool({ urls: [a.rpc], expectChainId: 10_143, timeoutMs: 2_000, staleS: 60 });
    await pool.init();
    const log = new ReadingLog(home, "primary");
    const chain = indexChain({ pool, index: dep.index, privateKey: KEYS[1], journal: log, timing: timingFor(10), keyLockPath: join(home, "keys/primary.lock") });
    const info = await startupChecks(chain, dep.panels, sourcesApi, 0);
    const dir = join(home, "primary/cre", dep.index.slice(2, 10).toLowerCase());
    const rt = prepareRuntime({ dir, workflowDir: WORKFLOW, target: "local-simulation", chainName: "monad-testnet", config: workflowConfig({ index: dep.index, chainSelector: info.chainSelector, gasLimit: creGasLimit(), clock: info.clock, panels: info.panels, sourceBaseUrl: `${replay.url}/r/primary` }) });
    const wasm = join(dir, "main.wasm");
    if (process.env.AGATE_CRE_WASM) copyFileSync(process.env.AGATE_CRE_WASM, wasm);
    else {
      const b = Bun.spawnSync(["bun", "x", "cre-compile", "main.ts", wasm], { cwd: WORKFLOW, stdout: "pipe", stderr: "pipe" });
      expect(b.exitCode).toBe(0);
    }
    const events: string[] = [];
    const say = (e: string) => void events.push(e);
    const direct = directSource(sourcesApi, info.panels, new PageReader(makeFetcher({ role: "primary", timeoutMs: 2_000 }, info.clock), `${replay.url}/r/primary`));
    const source = creSource(
      { creBin: CRE, dir, target: "local-simulation", configPath: "./cfg.json", wasm: "./main.wasm", key: KEYS[1], limits: "default", broadcast: true, timeoutMs: 60_000, receiptTimeout: "10s" },
      say,
      direct,
      undefined,
      { exclusive: (fn, until) => chain.exclusive(fn, until), rpcUrl: () => pool.url, runtime: rt },
    );
    const w = new Writer({ role: "primary", chain, clock: info.clock, chainSelector: info.chainSelector, panels: info.panels, log, source, say, tickS: 1 });
    const t0 = Date.now();
    const landed = async () => (await a.pub.readContract({ address: dep.index, abi: (await import("@agate/report/abi")).agateIndexAbi, functionName: "readings", args: [info.panels[0]!.gpuId, sliceAt(info.clock, dep.epochTs + 6).dayId, ADDR[1]!] })) as { sliceBits: bigint };
    while (Date.now() - t0 < 60_000) {
      await w.tick(Math.floor(Date.now() / 1000));
      const bits = (await landed()).sliceBits;
      if (bits.toString(2).split("1").length - 1 >= 2) break;
      await Bun.sleep(500);
    }
    const reads = readFileSync(join(log.dir, readdirSync(log.dir)[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "reading");
    expect(reads.length).toBeGreaterThanOrEqual(2);
    if (reads[0].via !== "cre") console.log("cre-simulate: fell back:", reads.map((r) => r.error));
    for (const r of reads.slice(0, 2)) {
      expect(r.via).toBe("cre");
      const tx = await a.pub.getTransaction({ hash: r.txHash });
      const rc = await a.pub.getTransactionReceipt({ hash: r.txHash });
      expect(tx.to!.toLowerCase()).toBe(CRE_SIM_FORWARDER.toLowerCase());
      expect(tx.gas).toBe(777_371n);
      expect(rc.status).toBe("success");
      console.log(`cre-simulate: slice ${r.slice} in ${r.ms} ms, gas used ${rc.gasUsed} of ${tx.gas}`);
    }
    expect(events.includes("repost")).toBe(false);
    expect(events.includes("simulate_failed")).toBe(false);
  }, 120_000);
});
