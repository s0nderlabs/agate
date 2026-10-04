// The fork world the client's e2e runs in: the LIVE Monad testnet deployment (contracts/deployments/10143.json, the
// real-calendar index and the real factory) on a local anvil fork, with what a demo session runs around it: index days
// written and countersigned as the index's own writer and attester (impersonated on the fork by the operator kit's
// ops/testnet/rehearse/days.ts), the payer app as the lister, the market maker app quoting the Kuru V1 books, and an
// isolated Envio indexer (e2e/indexer.ts). The bots run with the kit's public rehearsal keys (keccak256 of
// "agate kit rehearsal <role>", fork only); the maker's float is minted to it by the dollar's minter, impersonated.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, parseAbi } from "viem";
import { TESTNET_INDEXES } from "../src/static.ts";
import { Fork, rpcCall } from "./fork.ts";
import { cleanupDeadRuns, IsolatedIndexer } from "./indexer.ts";

const ROOT = join(import.meta.dir, "..", "..");
export const DEPLOYMENTS_FILE = join(ROOT, "contracts", "deployments", "10143.json");
export const REHEARSAL = { bot: "0x9A410E49A53115E85b751fE8D3b589bb8F1a717F", payer: "0xe1eCba46ecaeba115f92F15C066FBE5335c409Ee" } as const;

/** Writes, closes and countersigns every index day up to `toDay` on a loopback anvil fork (the kit's days.ts, as the
 *  index's own writer and attester, impersonated; it refuses any other RPC), then past T_PEND. Its output is kept in
 *  <logDir>/days-<toDay>.log when a folder is given, and a failure names it. */
export function writeDays(o: { rpc: string; index: string; toDay: number; logDir?: string | null }): { transactions: number; chainTime: string } {
  const r = Bun.spawnSync(["bun", "run", join(ROOT, "ops/testnet/rehearse/days.ts"), "--rpc", o.rpc, "--index", o.index, "--to", String(o.toDay)], { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  const err = r.stderr.toString();
  const log = o.logDir ? join(o.logDir, `days-${o.toDay}.log`) : null;
  if (log) writeFileSync(log, `${out}\n${err}`);
  const where = log ? ` (log: ${log})` : "";
  if (!r.success) {
    // the error's own line (its class and message, not only the stack frames) and the last day days.ts finished
    const lines = err.trim().split("\n");
    const first = lines.find((l) => /Error|error:/.test(l)) ?? lines[0] ?? "";
    const lastDay = out.trim().split("\n").filter((l) => l.startsWith('{"day"')).pop() ?? "(no day finished)";
    throw new Error(`days.ts --to ${o.toDay} failed: ${first.trim().slice(0, 400)} | last day done: ${lastDay} | ${lines.slice(-3).join(" ")}${where}`);
  }
  const last = out.trim().split("\n").pop() ?? "";
  let j: { done?: boolean; transactions?: number; chainTime?: string; lastDayFinal?: boolean };
  try {
    j = JSON.parse(last) as typeof j;
  } catch {
    throw new Error(`days.ts --to ${o.toDay} did not end with its summary line: "${last.slice(0, 200)}"${where}`);
  }
  if (!j.done || !j.lastDayFinal) throw new Error(`days.ts --to ${o.toDay} did not finish: ${last}${where}`);
  return { transactions: Number(j.transactions ?? 0), chainTime: String(j.chainTime ?? "") };
}

export interface Bot {
  name: string;
  proc: Bun.Subprocess;
  out: string;
}

export class World {
  bots: Bot[] = [];
  constructor(
    readonly fork: Fork,
    readonly state: string,
    readonly indexer: IsolatedIndexer | null,
  ) {}

  static async start(o: { state: string; indexer: boolean; log: (s: string) => void }): Promise<World> {
    mkdirSync(o.state, { recursive: true });
    // a crashed earlier run's containers (its process gone), by their own names only; a run still going is never touched
    const removed = cleanupDeadRuns();
    if (removed.length) o.log(`removed the containers of ended runs: ${removed.join(", ")}`);
    const fork = await Fork.start();
    o.log(`fork of Monad testnet at ${fork.rpc}, fork block ${fork.forkBlock}`);
    const w = new World(fork, o.state, o.indexer ? new IsolatedIndexer(join(o.state, "indexer")) : null);
    try {
      if (w.indexer) {
        const start = TESTNET_INDEXES.production?.deployBlock;
        if (!start) throw new Error("no production index record");
        // every factory of the deployments file needs its index's deploy block (gen-config refuses an index without
        // one): the real factory always, the demo factory once a demo session recorded one
        const starts: Record<string, number> = { real: start };
        const factories = (JSON.parse(readFileSync(DEPLOYMENTS_FILE, "utf8")) as { factories: Record<string, unknown> }).factories;
        if (factories.demo) {
          const demo = TESTNET_INDEXES.demo?.deployBlock;
          if (!demo) throw new Error("the deployments file has a demo factory but static.ts has no demo index record (bun run gen)");
          starts.demo = demo;
        }
        await w.indexer.start({ rpc: fork.rpc, deployments: DEPLOYMENTS_FILE, indexStarts: starts });
        o.log(`fork indexer: envio start on its own Postgres and Hasura, GraphQL ${w.indexer.url}`);
      }
      for (const a of Object.values(REHEARSAL)) await fork.setBalance(a, 1_000n);
      // the maker's float: 10,000,000 tUSD minted by the dollar's minter, as DeployMarket mints it to the real maker
      const dep = (await Bun.file(DEPLOYMENTS_FILE).json()) as { dollar: string };
      const minter = (await rpcCall(fork.rpc, "eth_call", [{ to: dep.dollar, data: encodeFunctionData({ abi: parseAbi(["function minter() view returns (address)"]), functionName: "minter" }) }, "latest"])) as string;
      const minterAddr = `0x${minter.slice(-40)}`;
      await fork.setBalance(minterAddr, 10n);
      await fork.sendAs(minterAddr, dep.dollar, encodeFunctionData({ abi: parseAbi(["function mint(address,uint256)"]), functionName: "mint", args: [REHEARSAL.bot, 10_000_000n * 1_000_000n] }));
      return w;
    } catch (e) {
      await w.stop();
      throw e;
    }
  }

  /** Writes, closes and countersigns every index day up to `toDay` on this world's fork (writeDays; the log kept in
   *  its state folder), then past T_PEND. */
  async days(toDay: number, index: string): Promise<{ transactions: number; chainTime: string }> {
    return writeDays({ rpc: this.fork.rpc, index, toDay, logDir: this.state });
  }

  /** The payer app as the lister only (claims off: the e2e's user claims its own positions), and the market maker. */
  startBots(): void {
    const gas = JSON.stringify(JSON.parse(readFileSync(join(ROOT, "ops/testnet/market-gas-limits.json"), "utf8")));
    const run = (name: "payer" | "marketmaker", role: "payer" | "bot", cfg: unknown) => {
      const home = join(this.state, `wall-${name}`);
      mkdirSync(home, { recursive: true });
      const cfgFile = join(this.state, `${name}.config.json`);
      writeFileSync(cfgFile, JSON.stringify(cfg));
      const out = join(this.state, `${name}.log`);
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/",
        AGATE_KEY_CMD: `cast keccak 'agate kit rehearsal ${role}'`,
        AGATE_RPC_URLS: this.fork.rpc,
        AGATE_CHAIN_ID: "10143",
        AGATE_DEPLOYMENTS: DEPLOYMENTS_FILE,
        AGATE_WALL_HOME: home,
        AGATE_MARKET_GAS_LIMITS: gas,
        FOUNDRY_DISABLE_NIGHTLY_WARNING: "1",
        [name === "payer" ? "AGATE_PAYER_CONFIG" : "AGATE_MM_CONFIG"]: cfgFile,
      };
      const proc = Bun.spawn(["bun", "run", "src/main.ts", "run"], { cwd: join(ROOT, "wall", "apps", name), env, stdout: Bun.file(out), stderr: Bun.file(`${out}.err`) });
      this.bots.push({ name, proc, out });
    };
    run("payer", "payer", { factories: ["real"], payer: false, tickS: 2, runUntil: "2027-06-01T00:00:00Z" });
    run("marketmaker", "bot", { factories: ["real"], tickS: 1, minRequoteS: 2, runUntil: "2027-06-01T00:00:00Z" });
  }

  /** Every process this world started (anvil-safe's wrapper, the indexer, the bots), for the leftover check. */
  pids(): number[] {
    return [this.fork.proc.pid, ...(this.indexer?.proc ? [this.indexer.proc.pid] : []), ...this.bots.map((b) => b.proc.pid)];
  }

  botAlive(): string | null {
    for (const b of this.bots) if (b.proc.exitCode !== null) return `${b.name} exited ${b.proc.exitCode}`;
    return null;
  }

  async stop(): Promise<void> {
    for (const b of this.bots) {
      if (b.proc.exitCode === null) {
        b.proc.kill("SIGTERM");
        const t = setTimeout(() => b.proc.kill("SIGKILL"), 20_000);
        await b.proc.exited;
        clearTimeout(t);
      }
    }
    if (this.indexer) await this.indexer.stop().catch(() => this.indexer?.cleanup());
    await this.fork.stop();
  }
}
