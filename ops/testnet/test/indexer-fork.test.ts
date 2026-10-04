// indexer.sh --fork beside another indexer: `envio dev` and `envio stop` use fixed global Docker names, so a fork run
// must neither start envio while envio-postgres or envio-hasura exists (it would attach to that database and reset
// it) nor stop containers it did not create. Its refusal exits 64, the code up.sh's launcher never restarts. Stubs
// only: no Docker, no envio, no network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const KIT = resolve(import.meta.dir, "..");
const ROOT = resolve(KIT, "../..");
let tmp = "";
let calls = "";
let work = "";
const env = (extra: Record<string, string> = {}) => ({
  PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
  HOME: process.env.HOME ?? tmp,
  TMPDIR: tmp,
  AGATE_KIT_FORK_RPC: "http://127.0.0.1:8549",
  AGATE_KIT_STATE: join(tmp, "state"),
  AGATE_DEPLOYMENTS: join(tmp, "deployments.json"),
  AGATE_KIT_RECORDS: join(tmp, "records.json"),
  ...extra,
});
const run = (args: string[], extra: Record<string, string> = {}) => {
  const r = Bun.spawnSync(["/bin/bash", join(KIT, "indexer.sh"), ...args], { cwd: ROOT, env: env(extra), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
};
const callLog = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "agate-kit-indexer-fork-"));
  calls = join(tmp, "calls.log");
  mkdirSync(join(tmp, "bin"));
  // docker answers, and both of another indexer's containers exist; podman has no machine socket
  writeFileSync(join(tmp, "bin", "docker"), `#!/bin/sh\necho "docker $*" >> '${calls}'\nexit 0\n`);
  writeFileSync(join(tmp, "bin", "podman"), "#!/bin/sh\nexit 1\n");
  for (const f of ["docker", "podman"]) chmodSync(join(tmp, "bin", f), 0o755);
  work = join(tmp, "state", "indexer");
  mkdirSync(join(work, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(work, "node_modules", ".bin", "envio"), `#!/bin/sh\necho "envio $*" >> '${calls}'\nexit 0\n`);
  chmodSync(join(work, "node_modules", ".bin", "envio"), 0o755);
  writeFileSync(join(tmp, "records.json"), JSON.stringify({ chainId: 10143, production: { status: "deployed", index: "0x1111111111111111111111111111111111111111", deployBlock: 100, firstDay: 20731 } }));
  writeFileSync(join(tmp, "deployments.json"), JSON.stringify({ chainId: 10143, dollar: "0x3333333333333333333333333333333333333333", kuru: { router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630", marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" }, factories: { real: { index: "0x1111111111111111111111111111111111111111", dollar: "0x3333333333333333333333333333333333333333", tag: "", factory: "0x4444444444444444444444444444444444444444", router: "0x5555555555555555555555555555555555555555", tPend: 21600, startBlock: 101 } } }));
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("indexer.sh --fork beside another indexer's envio containers", () => {
  test("run refuses before starting envio with exit 64 (the launcher does not restart it), and creates no marker", () => {
    const r = run(["run", "--fork"]);
    expect(r.code).toBe(64);
    expect(r.out).toContain("envio-postgres or envio-hasura exists");
    expect(callLog()).not.toContain("envio ");
    expect(existsSync(join(work, ".fork-owns-envio"))).toBe(false);
  });
  test("stop refuses containers this fork run did not create", () => {
    const r = run(["stop", "--fork"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not this fork run's");
    expect(callLog()).not.toContain("envio stop");
  });
  test("stop removes the containers a fork run marked as its own, and the marker", () => {
    writeFileSync(join(work, ".fork-owns-envio"), "");
    const r = run(["stop", "--fork"]);
    expect(r.code).toBe(0);
    expect(callLog()).toContain("envio stop");
    expect(existsSync(join(work, ".fork-owns-envio"))).toBe(false);
  });
  test("without --fork (the live indexer's own window) nothing changes: stop runs envio stop", () => {
    const r = run(["stop"], { AGATE_KIT_STATE: join(tmp, "state") });
    expect(r.code).toBe(0);
    expect(callLog().match(/envio stop/g)?.length).toBe(2);
  });
});

// The marker names each container's id as the fork run's envio dev creates it (a run that stopped halfway still owns
// what it made); a marker naming containers since replaced (another indexer's) never makes them this run's.
describe("indexer.sh --fork: the marker names the containers it created", () => {
  let box = "";
  let log = "";
  let state = "";
  const sandboxEnv = (extra: Record<string, string> = {}) => ({
    PATH: `${join(box, "bin")}:${process.env.PATH}`,
    HOME: process.env.HOME ?? box,
    TMPDIR: box,
    AGATE_KIT_FORK_RPC: "http://127.0.0.1:8549",
    AGATE_KIT_STATE: join(box, "state"),
    AGATE_DEPLOYMENTS: join(tmp, "deployments.json"),
    AGATE_KIT_RECORDS: join(tmp, "records.json"),
    ...extra,
  });
  const go = (args: string[], extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["/bin/bash", join(KIT, "indexer.sh"), ...args], { cwd: ROOT, env: sandboxEnv(extra), stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };
  const marker = () => join(box, "state", "indexer", ".fork-owns-envio");
  const callLog = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  /** which of the two containers exist, by id (null: none) */
  const setContainers = (ids: { pg?: string; hasura?: string } | null) => {
    for (const [n, id] of [["envio-postgres", ids?.pg], ["envio-hasura", ids?.hasura]] as const) {
      if (id === undefined) rmSync(join(state, `c-${n}`), { force: true });
      else writeFileSync(join(state, `c-${n}`), `${id}\n`);
    }
  };
  beforeAll(() => {
    box = mkdtempSync(join(tmpdir(), "agate-kit-indexer-marker-"));
    log = join(box, "calls.log");
    state = join(box, "docker");
    mkdirSync(join(box, "bin"));
    mkdirSync(state);
    // docker: a container exists while $state/c-<name> does; inspect prints the id of each one that exists (with -f)
    // and fails when any is missing, as Docker and Podman do
    writeFileSync(
      join(box, "bin", "docker"),
      `#!/bin/sh\necho "docker $*" >> '${log}'\nif [ "$1 $2" = "container inspect" ]; then\n  shift 2\n  f=0\n  if [ "$1" = "-f" ]; then f=1; shift 2; fi\n  rc=0\n  for n in "$@"; do\n    if [ -f '${state}'/c-$n ]; then [ $f = 1 ] && cat '${state}'/c-$n; else rc=1; fi\n  done\n  exit $rc\nfi\nexit 0\n`,
    );
    writeFileSync(join(box, "bin", "podman"), "#!/bin/sh\nexit 1\n");
    for (const f of ["docker", "podman"]) chmodSync(join(box, "bin", f), 0o755);
    // envio: dev creates the containers (fresh ids) and runs a few seconds, or, with $state/half, creates only
    // envio-postgres and fails at once (a start that stopped half-way); stop removes them
    const w = join(box, "state", "indexer");
    mkdirSync(join(w, "node_modules", ".bin"), { recursive: true });
    writeFileSync(
      join(w, "node_modules", ".bin", "envio"),
      `#!/bin/sh\necho "envio $*" >> '${log}'\nif [ "$1" = dev ]; then\n  echo fork-pg > '${state}/c-envio-postgres'\n  if [ -f '${state}/half' ]; then rm -f '${state}/half'; exit 1; fi\n  echo fork-hasura > '${state}/c-envio-hasura'\n  sleep 4\nfi\nif [ "$1" = stop ]; then rm -f '${state}/c-envio-postgres' '${state}/c-envio-hasura'; fi\nexit 0\n`,
    );
    chmodSync(join(w, "node_modules", ".bin", "envio"), 0o755);
  });
  afterAll(() => {
    if (box) rmSync(box, { recursive: true, force: true });
  });

  test("a stale marker naming other containers: stop removes nothing, and run refuses (64) and drops the marker", () => {
    setContainers({ pg: "live-pg", hasura: "live-hasura" });
    writeFileSync(marker(), "old-pg\nold-hasura\n");
    const s = go(["stop", "--fork"]);
    expect(s.code).not.toBe(0);
    expect(s.out).toContain("not this fork run's");
    const r = go(["run", "--fork"], { AGATE_RPC_URLS_CMD: "echo http://127.0.0.1:8549" });
    expect(r.code).toBe(64);
    expect(r.out).toContain("envio-postgres or envio-hasura exists");
    expect(existsSync(marker())).toBe(false);
    expect(callLog()).not.toContain("envio ");
  });

  test("stop with nothing to stop (no Envio container, no marker) exits 0 and says so", () => {
    setContainers(null);
    const s = go(["stop", "--fork"]);
    expect(s.code).toBe(0);
    expect(s.out).toContain("nothing to stop");
    expect(callLog()).not.toContain("envio stop");
  });

  test("a fork run whose envio dev stopped half-way (only envio-postgres made) is not locked out by it: the next run starts, its stop removes them", () => {
    setContainers(null);
    writeFileSync(join(state, "half"), "");
    const first = go(["run", "--fork"], { AGATE_RPC_URLS_CMD: "echo http://127.0.0.1:8549" });
    expect(first.code).toBe(1); // envio dev failed: the launcher restarts the window
    // the run's recorder notes the container within a second of its envio dev ending
    for (let i = 0; i < 50 && !existsSync(marker()); i++) Bun.sleepSync(100);
    expect(readFileSync(marker(), "utf8").trim()).toBe("fork-pg");
    const again = go(["run", "--fork"], { AGATE_RPC_URLS_CMD: "echo http://127.0.0.1:8549" });
    expect(again.code).toBe(0);
    expect(again.out).not.toContain("exists");
    expect(callLog().match(/envio dev/g)?.length).toBe(2);
    expect(readFileSync(marker(), "utf8").trim()).toBe("fork-pg\nfork-hasura");
    const s = go(["stop", "--fork"]);
    expect(s.code).toBe(0);
    expect(callLog()).toContain("envio stop");
    expect(existsSync(marker())).toBe(false);
    expect(existsSync(join(state, "c-envio-postgres"))).toBe(false);
    rmSync(log, { force: true });
  }, 30_000);

  test("a fork run marks the containers its envio dev created, with their ids; its stop then removes them", () => {
    setContainers(null);
    const r = go(["run", "--fork"], { AGATE_RPC_URLS_CMD: "echo http://127.0.0.1:8549" });
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("envio dev");
    expect(readFileSync(marker(), "utf8").trim()).toBe("fork-pg\nfork-hasura");
    const s = go(["stop", "--fork"]);
    expect(s.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("envio stop");
    expect(existsSync(marker())).toBe(false);
  }, 30_000);
});
