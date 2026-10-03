// The repair agent's CLI (BUILD-SPEC 15.2): `bun run apps/repair/src/cli.ts <status | draft <incidentId> | install
// <draftId> | notes>`. status and notes read the agent's files; draft asks the running agent for another draft
// (within the budget); install is the operator's own step in their checkout (15.4). No key, no RPC, no git.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { IncidentStore, incidentsPath } from "./incidents.ts";
import { install } from "./install.ts";
import { Spawner } from "./spawn.ts";

const USAGE = "usage: bun run apps/repair/src/cli.ts <status | draft <incidentId> | install <draftId> | notes>";

export async function cli(argv: string[], env: Record<string, string | undefined>, io: { out: (s: string) => void; isTTY: boolean }): Promise<number> {
  const home = env.AGATE_WALL_HOME || join(homedir(), ".agate-wall");
  const dir = join(home, "repair");
  const [cmd, arg] = argv;
  if (cmd === "status") {
    const store = new IncidentStore(incidentsPath(dir));
    const open = store.open();
    io.out(`${open.length} open incident(s)`);
    for (const x of open.sort((a, b) => a.since - b.since))
      io.out(`${x.id}  ${x.index.slice(2, 10)} ${x.sourceId} ${x.kind} since ${new Date(x.since * 1000).toISOString()}  status ${x.status}${x.diagnosis ? `  diagnosis ${x.diagnosis.kind}` : ""}  calls ${x.calls}${x.draftId ? `  draft ${x.draftId}` : ""}${x.shadow ? `  shadow ${x.shadow.good}/${x.shadow.seen}` : ""}${x.lastRefusal ? `  last refusal: ${x.lastRefusal}` : ""}`);
    if (existsSync(join(dir, "budget.json"))) io.out(`budget: ${readFileSync(join(dir, "budget.json"), "utf8").trim()}`);
    return 0;
  }
  if (cmd === "notes") {
    const nd = join(dir, "notes");
    const files = existsSync(nd) ? readdirSync(nd).filter((f) => f.endsWith(".md")).sort() : [];
    if (files.length === 0) io.out("no notes");
    for (const f of files) io.out(join(nd, f));
    return 0;
  }
  if (cmd === "draft" && arg) {
    const store = new IncidentStore(incidentsPath(dir));
    const x = store.get(arg);
    if (!x || x.status === "closed") {
      io.out(`no open incident ${arg}`);
      return 1;
    }
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "requests.jsonl"), `${JSON.stringify({ incidentId: arg, at: Math.floor(Date.now() / 1000) })}\n`);
    io.out(`asked the agent for another draft of ${arg} (it drafts at its next tick, within the budget)`);
    return 0;
  }
  if (cmd === "install" && arg) {
    const wallRoot = resolve(import.meta.dir, "../../..");
    const spawner = new Spawner({ claude: "/nonexistent", sandbox: "/usr/bin/sandbox-exec", bun: process.execPath, tsc: join(wallRoot, "node_modules", ".bin", "tsc"), osascript: "/usr/bin/osascript" });
    const childEnv: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TERM"]) if (env[k] !== undefined) childEnv[k] = env[k]!;
    return install({ draftId: arg, repairDir: dir, wallRoot, isTTY: io.isTTY, spawner, env: childEnv, out: io.out });
  }
  io.out(USAGE);
  return 2;
}

if (import.meta.main) {
  cli(process.argv.slice(2), process.env, { out: (s) => console.log(s), isTTY: Boolean(process.stdin.isTTY) }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`repair: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
