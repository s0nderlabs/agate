// The client's end-to-end run (bun, from client/):
//   bun run e2e/run.ts fork [--report <file.json>] [--keep] [--no-indexer]
//       the whole run on a local anvil fork of Monad testnet: the live deployment, index days written on the fork,
//       the lister and the market maker apps, an isolated indexer (Podman), then the user's journey (e2e/flows.ts);
//       prints the step table and stops everything it started
//   bun run e2e/run.ts flows
//       the journey alone against a world that is already up: AGATE_E2E_RPC (a loopback anvil fork),
//       AGATE_E2E_DEPLOYMENTS (default contracts/deployments/10143.json), AGATE_E2E_FACTORY (default real),
//       AGATE_E2E_GRAPHQL (optional); time travel there needs the world's index days, so this mode stops before them
//       unless AGATE_E2E_DAYS=1 (it then writes them with the kit's days.ts as the index's own writer, impersonated)
//   bun run e2e/run.ts live [--report <file.json>]
//       every read against the live testnet (public RPC) and AGATE_E2E_GRAPHQL or NEXT_PUBLIC_AGATE_GRAPHQL_URL
//       (default http://localhost:8080/v1/graphql), read only
//   AGATE_E2E_KEY_CMD='<a command printing the key>' bun run e2e/run.ts testnet --i-mean-testnet [options]
//       the user's journey against the LIVE demo factory of a running demo session on Monad testnet, in real time
//       (e2e/testnet.ts: its gates, its options, how it resumes); Ctrl-C finishes the step in progress, then stops
// fork, flows and live send transactions only to a loopback anvil fork and refuse anything else; testnet is the one
// mode that sends to Monad testnet, behind the gates in e2e/testnet.ts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { createAgateClient, type Deployments, type Gpu, resolveGraphqlUrl } from "../src/index.ts";
import { anvilTmp, assertFork, dfLine, rpcCall } from "./fork.ts";
import { big, type Hooks, journey, Steps } from "./flows.ts";
import { otherContainers, waitIndexed } from "./indexer.ts";
import { liveReads } from "./live.ts";
import { requestStop, runTestnet, USAGE } from "./testnet.ts";
import { DEPLOYMENTS_FILE, World, writeDays } from "./world.ts";

/** Anvil's well-known test account 1 (public; on Monad testnet it carries an EIP-7702 delegation, removed on the
 *  fork only). Never used anywhere but a local fork. */
const USER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const USER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const args = process.argv.slice(2);
const mode = args[0];
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const log = (s: string) => console.log(s);

async function waitBooksOf(rpc: string, graphqlUrl: string | null, gpus: Gpu[], month: string, ms = 240_000, bot?: () => string | null): Promise<void> {
  const c = createAgateClient({ rpcUrl: rpc, graphqlUrl });
  const t0 = Date.now();
  for (;;) {
    let ok = true;
    for (const g of gpus) {
      try {
        const b = await c.book(g, month);
        if (b.bids.length < 3 || b.asks.length < 3) ok = false;
      } catch {
        ok = false;
      }
    }
    if (ok) return;
    const dead = bot?.();
    if (dead) throw new Error(`waiting for the books: ${dead}`);
    if (Date.now() - t0 > ms) throw new Error(`the ${month} books are not quoted after ${ms / 1000} s`);
    await Bun.sleep(1000);
  }
}

async function fork(): Promise<number> {
  const report: Record<string, unknown> = { mode: "fork", startedAt: new Date().toISOString() };
  report.diskBefore = dfLine();
  report.anvilTmpBefore = anvilTmp();
  report.containersBefore = otherContainers();
  log(`disk before: ${report.diskBefore}; ~/.foundry/anvil/tmp ${report.anvilTmpBefore}`);
  const live = createAgateClient({ graphqlUrl: "http://localhost:8080/v1/graphql" });
  const liveIdx = async () => (live.gql ? await live.gql.query<{ chain_metadata: { latest_processed_block: number; num_events_processed: number }[] }>("{ chain_metadata { latest_processed_block num_events_processed } }").catch(() => null) : null);
  report.liveIndexerBefore = await liveIdx();
  const state = mkdtempSync(join(tmpdir(), "agate-client-e2e-"));
  const steps = new Steps(log);
  const useIndexer = !flag("no-indexer");
  let world: World | null = null;
  let code = 1;
  let pids: number[] = [];
  let port = "";
  let runNames: string[] | null = null;
  try {
    world = await World.start({ state, indexer: useIndexer, log });
    const w = world;
    const gql = w.indexer ? w.indexer.url : null;
    report.forkBlock = w.fork.forkBlock;

    // The fork is always the latest testnet block, which has had final days since Oct 4 2026 07:00 UTC, so the state
    // before the first final day (no price, November upcoming) can no longer be read here; the journey checks the reads
    // of the index as it is (its newest final day, November trading).
    log("\n== the world: the live index's days as they are (any day still waiting for its countersign signed); the lister and the maker start");
    const idx = (await Bun.file(DEPLOYMENTS_FILE).json()) as { factories: { real: { index: string } } };
    // days.ts writes no day here (the head is past Oct 4); it countersigns a pending day so the journey's days can close
    const d1 = await w.days(20730, idx.factories.real.index);
    log(`days.ts: ${d1.transactions} transactions, chain time ${d1.chainTime}`);
    w.startBots();
    await waitBooksOf(w.fork.rpc, null, ["H100", "H200", "B200"], "2026-11", 300_000, () => w.botAlive());
    log("three November books quoted by the maker");
    // from here on exactly what `flows` runs against a world given by env
    await runFlows({ rpc: w.fork.rpc, deployments: await Bun.file(DEPLOYMENTS_FILE).json(), graphqlUrl: gql, factory: "real", writeDays: true, logDir: w.state, alive: () => w.botAlive() }, steps);
    code = steps.failed().length === 0 ? 0 : 1;
  } catch (e) {
    log(`\nSTOPPED: ${(e as Error).stack ?? e}`);
    steps.check("run", "the run completed", false, (e as Error).message);
  } finally {
    if (world) {
      pids = world.pids();
      port = new URL(world.fork.rpc).port;
      runNames = world.indexer ? [world.indexer.names.pg, world.indexer.names.hasura] : null;
      await world.stop();
    }
    if (!flag("keep")) rmSync(state, { recursive: true, force: true });
    else log(`state kept in ${state}`);
  }
  report.diskAfter = dfLine();
  report.anvilTmpAfter = anvilTmp();
  report.containersAfter = otherContainers();
  report.liveIndexerAfter = await liveIdx();
  // this run's own processes by pid, and the anvil serving its fork's port; the operator's processes never match
  const alive = pids.filter((p) => Bun.spawnSync(["kill", "-0", String(p)], { stderr: "ignore" }).success);
  const anvilLeft = port ? Bun.spawnSync(["pgrep", "-f", `anvil --prune-history --port ${port} `], { stdout: "pipe" }).stdout.toString().trim() : "";
  const ownContainers = runNames ? Bun.spawnSync(["podman", "ps", "-a", "--format", "{{.Names}}"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().split("\n").filter((n) => runNames!.includes(n)).join(" ") : "";
  const leftovers = [alive.length ? `pids ${alive.join(" ")}` : "", anvilLeft ? `anvil ${anvilLeft}` : "", ownContainers ? `containers ${ownContainers}` : ""].filter(Boolean).join("; ");
  report.leftoverProcesses = leftovers;
  steps.check("cleanup", "no anvil, envio, bot or container of this run is left; the other indexer's containers are unchanged", leftovers === "" && report.containersAfter === report.containersBefore, { leftovers, before: report.containersBefore, after: report.containersAfter });
  log(`\ndisk after: ${report.diskAfter}; ~/.foundry/anvil/tmp ${report.anvilTmpAfter}`);
  log(`\n${steps.table()}`);
  const failed = steps.failed();
  log(`\n${steps.checks.length - failed.length} of ${steps.checks.length} checks passed${failed.length ? `; failed: ${failed.map((c) => `${c.step}: ${c.name}`).join(" | ")}` : ""}`);
  report.rows = steps.rows;
  report.checks = steps.checks;
  report.table = steps.table();
  const path = opt("report");
  if (path) writeFileSync(path, big(report));
  return failed.length === 0 ? code : 1;
}

/** The user's journey against a world that is up (a loopback anvil fork with listed series and a quoting maker): the
 *  user's MON and plain account on the fork, then journey() with the generic hooks: index days written by the kit's
 *  days.ts (writeDays: the index's own writer and attester, impersonated; its log kept in `logDir` when given), the
 *  indexer waited for through its own GraphQL. */
async function runFlows(o: { rpc: string; deployments: Deployments; graphqlUrl: string | null; factory: string; writeDays: boolean; logDir?: string; alive?: () => string | null }, steps: Steps): Promise<void> {
  await assertFork(o.rpc);
  await rpcCall(o.rpc, "anvil_setCode", [USER, "0x"]);
  await rpcCall(o.rpc, "anvil_setBalance", [USER, `0x${(100n * 10n ** 18n).toString(16)}`]);
  const index = o.deployments.factories[o.factory]?.index;
  if (!index) throw new Error(`the deployments have no factory ${o.factory}`);
  const hooks: Hooks = {
    daysTo: async (day) => {
      if (!o.writeDays) throw new Error(`the journey needs index days up to ${day}: set AGATE_E2E_DAYS=1 to write them on this fork`);
      const d = writeDays({ rpc: o.rpc, index, toDay: day, logDir: o.logDir ?? null });
      log(`  days.ts --to ${day}: ${d.transactions} transactions, chain time ${d.chainTime}`);
      // the maker requotes after a final day and the lister may list: a few of their ticks
      await Bun.sleep(8000);
    },
    indexed: async () => {
      if (!o.graphqlUrl) return;
      const head = BigInt((await rpcCall(o.rpc, "eth_blockNumber")) as string);
      await waitIndexed(o.graphqlUrl, head, { log });
    },
    waitBooks: (gpu, month) => waitBooksOf(o.rpc, null, [gpu], month, 120_000, o.alive),
  };
  await journey({ rpc: o.rpc, key: USER_KEY, graphqlUrl: o.graphqlUrl, factory: o.factory, deployments: o.deployments, hooks, steps });
}

async function flows(): Promise<number> {
  const rpc = process.env.AGATE_E2E_RPC;
  if (!rpc) throw new Error("AGATE_E2E_RPC is not set (a loopback anvil fork)");
  const deployments = (await Bun.file(process.env.AGATE_E2E_DEPLOYMENTS ?? DEPLOYMENTS_FILE).json()) as Deployments;
  const steps = new Steps(log);
  try {
    await runFlows({ rpc, deployments, graphqlUrl: process.env.AGATE_E2E_GRAPHQL ?? null, factory: process.env.AGATE_E2E_FACTORY ?? "real", writeDays: process.env.AGATE_E2E_DAYS === "1" }, steps);
  } catch (e) {
    log(`\nSTOPPED: ${(e as Error).message}`);
    steps.check("run", "the run completed", false, (e as Error).message);
  }
  log(`\n${steps.table()}`);
  return steps.failed().length === 0 ? 0 : 1;
}

async function liveMode(): Promise<number> {
  const gql = resolveGraphqlUrl(process.env.AGATE_E2E_GRAPHQL);
  log(`live: Monad testnet through the public RPC, indexer ${gql}`);
  const r = await liveReads({ graphqlUrl: gql, address: process.env.AGATE_E2E_ADDRESS ?? "0x62565E5D1533af8C1f711C42E047e5f94C172411", log });
  const failed = r.checks.filter((c) => !c.ok);
  log(`\n${r.checks.length - failed.length} of ${r.checks.length} live checks passed`);
  const path = opt("report");
  if (path) writeFileSync(path, big(r));
  return failed.length === 0 ? 0 : 1;
}

async function testnetMode(): Promise<number> {
  // Ctrl-C: the step in progress is finished (every transaction of it, and its checks), a wait stops at once, then the
  // run stops (the next run continues from the chain); a second Ctrl-C quits at once. Both, and a SIGTERM, release the
  // key's lock (the process's exit hook); a kill that skips the hook leaves a stale lock the next run takes over.
  let hits = 0;
  process.on("SIGINT", () => {
    hits++;
    if (hits > 1) process.exit(130);
    requestStop("stopped by Ctrl-C: run the same command again to continue from what is on chain");
    console.log("\nCtrl-C: finishing the step in progress, then stopping (Ctrl-C again to quit at once)");
  });
  process.on("SIGTERM", () => process.exit(143));
  return runTestnet(args.slice(1), process.env);
}

const run = mode === "fork" ? fork : mode === "flows" ? flows : mode === "live" ? liveMode : mode === "testnet" ? testnetMode : null;
if (!run) {
  console.error(`usage: bun run e2e/run.ts <fork|flows|live> [--report <file.json>] [--keep] [--no-indexer]\n${USAGE}`);
  process.exit(2);
}
process.exit(await run());
