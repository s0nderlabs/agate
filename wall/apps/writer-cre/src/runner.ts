// The primary writer (writer slot 0). One `cre workflow simulate --broadcast` run per slice at a random second, then
// the shared pipeline (log, read-back, reposts while the day is open, the key check, closeDay) with the RPC pool and
// the key's sender.
// Env: AGATE_RPC_URLS_CMD (a command printing the URL list, run once at start; Alchemy's URL carries a key, 13.6) or
// AGATE_RPC_URLS, AGATE_INDEX, AGATE_PANELS (panels/launch.json for the launch indexes, 7.10), AGATE_PRIMARY_KEY
// (writer slot 0; signs reposts and closeDay and is handed to the CRE CLI child as CRE_ETH_PRIVATE_KEY for its
// broadcasts, unless AGATE_CRE_ENV names the CLI's own .env). Optional: AGATE_WRITE_MODE (cre | direct; default cre,
// direct when a slice is under 60 s), AGATE_CRE_TARGET (local-simulation), AGATE_CRE_CHAIN_NAME (monad-testnet),
// AGATE_CRE_FORWARDER (the simulation forwarder the CLI writes through), AGATE_CRE_RPC_URLS (the CLI's key-free RPC
// URLs, default https://testnet-rpc.monad.xyz; never the Alchemy URL), AGATE_CRE_LIMITS (default | none | file;
// unset: "none" when the panel reads a source over CRE's cap, else "default"), AGATE_CRE_WASM (a prebuilt main.wasm
// instead of compiling at start), CRE_BIN (~/.cre/bin/cre), SOURCE_BASE_URL, AGATE_WALL_HOME, AGATE_CHAIN_ID,
// AGATE_MAX_FEE_GWEI, AGATE_GAS_POST / AGATE_GAS_CLOSE / AGATE_GAS_ONREPORT (MEASURED overrides).
import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agateIndexAbi } from "@agate/report/abi";
import type { Address, Hex } from "@agate/report/types";
import { CRE_CAP_BYTES, SOURCE_META } from "@agate/sources/pure";
import type { Panel } from "@agate/sources/types";
import { gasLimitFor, MEASURED, measuredFromEnv, type ReadingSource, runService, type SourceContext } from "@agate/writer-standby";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { childEnv, creLimits, creRpcRotation, creRpcUrls, creSource, prepareRuntime, workflowConfig } from "./simulate.ts";

export const CRE_SIM_FORWARDER: Address = "0xB9F79d863261869B234c481D1f9A7af84AeAd192";
const workflowDir = resolve(process.env.AGATE_CRE_WORKFLOW_DIR ?? resolve(import.meta.dir, "../workflow"));

/** The writeReport gas limit: 13.4's rule with MEASURED as the estimate (the workflow cannot estimate). */
export function creGasLimit(measured = MEASURED.onReport): bigint {
  const g = gasLimitFor(measured, measured);
  if (!g.ok) throw new Error("unreachable");
  return g.limit;
}

/** True when the panel file says so (panels/launch.json: includeOverCap) or any slot reads a page measured over CRE's
 * response cap (CoreWeave, 7.8): such a panel needs `--limits none` in simulate. */
export function panelOverCap(flags: { includeOverCap?: boolean }, panels: readonly Panel[]): boolean {
  return flags.includeOverCap === true || panels.some((p) => p.slots.some((s) => (SOURCE_META[s.sourceId]?.bytes ?? 0) > CRE_CAP_BYTES));
}

async function forwarderOf(ctx: SourceContext): Promise<{ addr: Address; mode: number }> {
  const data = encodeFunctionData({ abi: agateIndexAbi, functionName: "forwarder" });
  const res = (await ctx.pool.request("eth_call", [{ to: ctx.chain.index, data }, "latest"])) as Hex;
  const [addr, mode] = decodeFunctionResult({ abi: agateIndexAbi, functionName: "forwarder", data: res }) as readonly [Address, number];
  return { addr, mode: Number(mode) };
}

async function makeSource(ctx: SourceContext): Promise<ReadingSource> {
  const { clock, say } = ctx;
  const mode = process.env.AGATE_WRITE_MODE ?? (clock.slice < 60 ? "direct" : "cre");
  if (mode !== "cre") {
    say("mode", { mode: "direct", why: process.env.AGATE_WRITE_MODE ? "AGATE_WRITE_MODE" : "slice under 60 s" });
    return ctx.direct;
  }
  // refused before anything else: a capped page must never silently read as 0 (8.2 (1))
  const limits = creLimits(process.env.AGATE_CRE_LIMITS, panelOverCap(ctx.panelFlags, ctx.panels));
  const creUrls = creRpcUrls(process.env);
  const rot = creRpcRotation(creUrls);
  const want = (process.env.AGATE_CRE_FORWARDER ?? CRE_SIM_FORWARDER) as Address;
  const fwd = await forwarderOf(ctx);
  if (fwd.addr.toLowerCase() !== want.toLowerCase() || fwd.mode !== 0) {
    // every CRE report would be refused by A1 or A2 inside the forwarder's try/catch: post directly instead
    say("warning", { message: `index forwarder ${fwd.addr} (mode ${fwd.mode}) is not the CRE simulation forwarder ${want} in TX_ORIGIN mode: posting directly` });
    return ctx.direct;
  }
  const dir = join(ctx.home, "primary", "cre", ctx.chain.index.slice(2, 10).toLowerCase());
  const measured = { ...MEASURED, ...measuredFromEnv() }.onReport;
  const config = workflowConfig({
    index: ctx.chain.index,
    chainSelector: ctx.info.chainSelector,
    gasLimit: creGasLimit(measured),
    clock,
    panels: ctx.panels,
    // the index credits tx.origin, the CLI's broadcasting key: known here only when the CLI signs with ours (an
    // AGATE_CRE_ENV file brings its own key, so the workflow then reads nothing rather than another writer's bits)
    ...(process.env.AGATE_CRE_ENV ? {} : { writer: privateKeyToAccount(ctx.key).address }),
    ...(process.env.SOURCE_BASE_URL ? { sourceBaseUrl: process.env.SOURCE_BASE_URL } : {}),
  });
  const target = process.env.AGATE_CRE_TARGET ?? "local-simulation";
  const runtime = prepareRuntime({ dir, workflowDir, target, chainName: process.env.AGATE_CRE_CHAIN_NAME ?? "monad-testnet", config });
  const wasm = join(dir, "main.wasm");
  if (process.env.AGATE_CRE_WASM) copyFileSync(process.env.AGATE_CRE_WASM, wasm);
  else {
    const b = Bun.spawnSync(["bun", "x", "cre-compile", "main.ts", wasm], { cwd: workflowDir, stdout: "pipe", stderr: "pipe" });
    if (b.exitCode !== 0 || !existsSync(wasm)) {
      say("warning", { message: `cre-compile failed, posting directly: ${b.stderr.toString().slice(-600)}` });
      return ctx.direct;
    }
  }
  say("mode", { mode, dir, gasLimit: config.gasLimit, limits, creRpcs: creUrls.length });
  return creSource(
    {
      creBin: process.env.CRE_BIN ?? join(homedir(), ".cre/bin/cre"),
      dir,
      target,
      configPath: "./cfg.json",
      wasm: "./main.wasm",
      ...(process.env.AGATE_CRE_ENV ? { envFile: process.env.AGATE_CRE_ENV } : { key: ctx.key }),
      limits,
      broadcast: true,
      timeoutMs: Math.min(300, Math.max(20, Math.floor(clock.slice * 0.8))) * 1000,
      receiptTimeout: `${Math.min(60, Math.max(5, Math.floor(clock.slice / 4)))}s`,
      env: childEnv(process.env, ctx.endpoints),
    },
    say,
    ctx.direct,
    undefined,
    {
      exclusive: (fn, until) => ctx.chain.exclusive(fn, until),
      rpcUrl: rot.url,
      rpcFailed: rot.failed,
      runtime,
      panels: ctx.panels,
      onWorkflowRefused: (x) => {
        const id = `${x.gpuId}:${x.slot}:${x.parserVersion}`;
        if (missingSaid.has(id)) return;
        missingSaid.add(id);
        ctx.alert({
          code: "READER_MISSING",
          severity: "action",
          gpuId: x.gpuId,
          day: x.dayId,
          slot: x.slot,
          deadline: Math.floor(Date.now() / 1000),
          message: `${x.gpu} slot ${x.slot} (${x.sourceId}): the compiled CRE workflow lacks parser ${x.parserVersion}, so the slot reads nothing; rebuild the workflow (restart the primary, or rebuild AGATE_CRE_WASM)`,
          data: { sourceId: x.sourceId, parserVersion: x.parserVersion, why: x.why },
        });
      },
    },
  );
}

const missingSaid = new Set<string>();

if (import.meta.main) await runService({ role: "primary", keyEnv: "AGATE_PRIMARY_KEY", expectSlot: 0, makeSource });
