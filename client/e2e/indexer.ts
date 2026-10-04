// An Envio indexer of the fork, fully apart from any other indexer on this machine. `envio dev` manages Docker
// resources with fixed global names (envio-postgres, envio-hasura, envio-network, envio-postgres-data; enviodev/
// hyperindex#1397), so a second `envio dev`, or `envio stop`, would attach to or remove another indexer's database.
// This never runs either: it starts its own Postgres and Hasura containers under its own names, network and ports
// (Podman), and runs `envio start` against them with every connection setting in the environment. Two more guards:
// its own database password (another indexer's database refuses it), and a start block one below the index's deploy
// block, so even a database of the same config would refuse to resume this one (Envio's resume check) instead of
// mixing chains. Its log must say "Initializing the indexer storage" on a fresh database, else it is stopped.
// Each run has its own names (agate-client-e2e-<pid>-<n>-*) and free ports, so two runs at once never touch each
// other; at start only the containers of runs whose process is gone are removed.
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
/** every run's resources start with this; the rest of the name is <pid>-<n> of the process that made them */
export const PREFIX = "agate-client-e2e-";
const PASSWORD = "agate-client-e2e";
let runs = 0;
const PG_IMAGE = "docker.io/library/postgres:18.3";
const HASURA_IMAGE = "docker.io/hasura/graphql-engine:v2.43.0";

function podman(args: string[], quiet = false): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
  if (!r.success && !quiet) throw new Error(`podman ${args.slice(0, 2).join(" ")} failed: ${out.split("\n").slice(-3).join(" ")}`);
  return { ok: r.success, out };
}

/** The other indexers' containers as they are now (names, ids, state), to show afterwards nothing touched them. The
 *  client's own harnesses' containers (any run's, the e2e's or the cross-check's, which come and go) are left out. */
export function otherContainers(): string {
  return podman(["ps", "-a", "--format", "{{.Names}} {{.ID}} {{.State}} {{.Created}}"], true)
    .out.split("\n")
    .filter((l) => l && !l.startsWith(PREFIX))
    .sort()
    .join("\n");
}

/** A free TCP port on the loopback (the OS picks it). */
function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

const alive = (pid: number) => Bun.spawnSync(["kill", "-0", String(pid)], { stderr: "ignore" }).success;

/** The newest block the indexer at `url` has processed (0 before its first batch, or when it does not answer). */
export async function processedBlock(url: string): Promise<number> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ chain_metadata { latest_processed_block } }" }) });
    const j = (await r.json()) as { data?: { chain_metadata: { latest_processed_block: number | null }[] } };
    return Number(j.data?.chain_metadata[0]?.latest_processed_block ?? 0);
  } catch {
    return 0;
  }
}

/** Waits until the indexer at `url` has processed `block`; returns the ms it took. A fresh indexer first catches up
 *  from the index's deploy block over the fork's upstream RPC, which takes longer as the chain grows, so this fails only
 *  when the indexer has not moved for `stallMs` (or `dead()` names a reason), never on the catch-up's length alone;
 *  `maxMs` bounds the whole wait. `log` hears the indexer's block every 30 s of a long wait. */
export async function waitIndexed(url: string, block: bigint | number, o: { stallMs?: number; maxMs?: number; dead?: () => string | null; log?: (s: string) => void } = {}): Promise<number> {
  const stallMs = o.stallMs ?? 180_000;
  const maxMs = o.maxMs ?? 1_800_000;
  const t0 = Date.now();
  let last = -1;
  let movedAt = t0;
  let said = t0;
  for (;;) {
    const p = await processedBlock(url);
    if (p >= Number(block)) {
      if (Date.now() - t0 > 30_000) o.log?.(`  the indexer reached block ${block} in ${Math.round((Date.now() - t0) / 1000)} s`);
      return Date.now() - t0;
    }
    if (p > last) {
      last = p;
      movedAt = Date.now();
    }
    const why = o.dead?.();
    if (why) throw new Error(why);
    if (Date.now() - movedAt > stallMs) throw new Error(`the indexer is at block ${p}, not ${block}: it has not moved for ${stallMs / 1000} s`);
    if (Date.now() - t0 > maxMs) throw new Error(`the indexer is at block ${p}, not ${block}, after ${maxMs / 1000} s`);
    if (Date.now() - said >= 30_000) {
      o.log?.(`  waiting for the indexer: block ${p} of ${block}`);
      said = Date.now();
    }
    await Bun.sleep(500);
  }
}

/** Removes the containers and networks of earlier runs whose process is gone (a crashed run's), never a live run's. */
export function cleanupDeadRuns(): string[] {
  const names = [
    ...podman(["ps", "-a", "--format", "{{.Names}}"], true).out.split("\n"),
    ...podman(["network", "ls", "--format", "{{.Name}}"], true).out.split("\n"),
  ].filter((n) => n.startsWith(PREFIX));
  const dead = new Set<string>();
  for (const n of names) {
    const m = /^agate-client-e2e-(\d+)-(\d+)-/.exec(n);
    if (m && !alive(Number(m[1]))) dead.add(`${PREFIX}${m[1]}-${m[2]}`);
  }
  for (const run of dead) {
    podman(["rm", "-f", "-v", `${run}-hasura`, `${run}-pg`], true);
    podman(["network", "rm", `${run}-net`], true);
  }
  return [...dead];
}

export class IsolatedIndexer {
  proc: Bun.Subprocess | null = null;
  readonly names: { pg: string; hasura: string; net: string };
  readonly ports: { pg: number; hasura: number; indexer: number };
  readonly url: string;
  readonly log: string;
  constructor(readonly work: string) {
    this.log = join(work, "envio.log");
    const run = `${PREFIX}${process.pid}-${++runs}`;
    this.names = { pg: `${run}-pg`, hasura: `${run}-hasura`, net: `${run}-net` };
    this.ports = { pg: freePort(), hasura: freePort(), indexer: freePort() };
    this.url = `http://127.0.0.1:${this.ports.hasura}/v1/graphql`;
  }

  /** Removes this run's own containers and network (never any other name). */
  cleanup(): void {
    podman(["rm", "-f", "-v", this.names.hasura, this.names.pg], true);
    podman(["network", "rm", this.names.net], true);
  }

  async start(o: { rpc: string; deployments: string; factory: string; indexStart: number }): Promise<void> {
    const NAMES = this.names;
    const PORTS = this.ports;
    for (const n of [NAMES.pg, NAMES.hasura]) {
      if (podman(["container", "exists", n], true).ok) throw new Error(`a container ${n} exists: this run's names must be new`);
    }
    // the copy of indexer/ the run renders its config into (node_modules linked; the repo's files never change)
    mkdirSync(this.work, { recursive: true });
    for (const p of ["abis", "src", "scripts", "schema.graphql", "package.json", "tsconfig.json", "envio-env.d.ts"]) {
      rmSync(join(this.work, p), { recursive: true, force: true });
      cpSync(join(ROOT, "indexer", p), join(this.work, p), { recursive: true });
    }
    if (!existsSync(join(this.work, "node_modules"))) symlinkSync(join(ROOT, "indexer", "node_modules"), join(this.work, "node_modules"), "dir");
    const gen = Bun.spawnSync(["bun", "run", "scripts/gen-config.ts", o.deployments, "--rpc", "--index-start", `${o.factory}=${o.indexStart - 1}`, "--out", "config.yaml"], { cwd: this.work, stdout: "pipe", stderr: "pipe" });
    if (!gen.success) throw new Error(`gen-config failed: ${gen.stderr.toString()}`);

    podman(["network", "create", NAMES.net]);
    podman(["run", "-d", "--name", NAMES.pg, "--network", NAMES.net, "-p", `127.0.0.1:${PORTS.pg}:5432`, "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_DB=envio-dev", PG_IMAGE]);
    for (let i = 0; i < 120; i++) {
      if (podman(["exec", NAMES.pg, "pg_isready", "-U", "postgres", "-d", "envio-dev"], true).ok) break;
      await Bun.sleep(500);
    }
    podman([
      "run", "-d", "--name", NAMES.hasura, "--network", NAMES.net, "-p", `127.0.0.1:${PORTS.hasura}:8080`,
      "-e", `HASURA_GRAPHQL_DATABASE_URL=postgres://postgres:${PASSWORD}@${NAMES.pg}:5432/envio-dev`,
      "-e", "HASURA_GRAPHQL_ADMIN_SECRET=testing", "-e", "HASURA_GRAPHQL_UNAUTHORIZED_ROLE=public",
      "-e", "HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES=true", "-e", "HASURA_GRAPHQL_ENABLE_CONSOLE=false", "-e", "HASURA_GRAPHQL_NO_OF_RETRIES=10",
      HASURA_IMAGE,
    ]);
    for (let i = 0; i < 240; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORTS.hasura}/healthz`)).ok) break;
      } catch {
        // not up yet
      }
      await Bun.sleep(500);
    }
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      ENVIO_RPC_URL: o.rpc,
      ENVIO_PG_HOST: "127.0.0.1",
      ENVIO_PG_PORT: String(PORTS.pg),
      ENVIO_PG_USER: "postgres",
      ENVIO_PG_PASSWORD: PASSWORD,
      ENVIO_PG_DATABASE: "envio-dev",
      HASURA_GRAPHQL_ENDPOINT: `http://127.0.0.1:${PORTS.hasura}/v1/metadata`,
      HASURA_GRAPHQL_ADMIN_SECRET: "testing",
      ENVIO_INDEXER_PORT: String(PORTS.indexer),
      ENVIO_TUI: "false",
    };
    writeFileSync(this.log, "");
    this.proc = Bun.spawn([join(this.work, "node_modules/.bin/envio"), "start"], { cwd: this.work, env, stdout: Bun.file(this.log), stderr: Bun.file(`${this.log}.err`) });
    // a fresh database must be initialized, never resumed
    for (let i = 0; i < 240; i++) {
      const text = `${await Bun.file(this.log).text()}${existsSync(`${this.log}.err`) ? await Bun.file(`${this.log}.err`).text() : ""}`;
      if (/Found existing indexer storage|Resuming indexing state/.test(text)) {
        await this.stop();
        throw new Error("the fork indexer found an existing database: stopped at once (it must start on its own empty one)");
      }
      if (/indexer storage is ready|Starting indexing/.test(text)) return;
      if (this.proc.exitCode !== null) throw new Error(`envio start exited ${this.proc.exitCode}: ${text.split("\n").slice(-8).join("\n")}`);
      await Bun.sleep(500);
    }
    throw new Error("envio start did not initialize its database within 2 minutes");
  }

  async query<T>(q: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables }) });
    const j = (await r.json()) as { data?: T; errors?: { message: string }[] };
    if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join("; "));
    return j.data as T;
  }

  /** The newest block the indexer has processed (0 before its first batch). */
  processed(): Promise<number> {
    return processedBlock(this.url);
  }

  /** Waits until this indexer has processed `block` (waitIndexed: fails when it stops moving for `stallMs`, or when
   *  its envio exits). */
  waitFor(block: bigint, stallMs = 180_000, log?: (s: string) => void): Promise<number> {
    return waitIndexed(this.url, block, { stallMs, log, dead: () => (this.proc && this.proc.exitCode !== null ? `envio exited ${this.proc.exitCode}` : null) });
  }

  async stop(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      const t = setTimeout(() => this.proc?.kill("SIGKILL"), 15_000);
      await this.proc.exited;
      clearTimeout(t);
    }
    this.cleanup();
  }
}
