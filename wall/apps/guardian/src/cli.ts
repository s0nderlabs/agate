// `bun run apps/guardian/src/cli.ts <command>` (BUILD-SPEC 10). Reads the watcher's log and alerts, the guardian log
// (<home>/guardian/) and the chain. Sends only veto, suspend and attest with AGATE_GUARDIAN_KEY and kick with
// AGATE_KICK_KEY, each read at the moment of sending; set them only for that one call. Environment as the watcher's
// (AGATE_RPC_URLS, AGATE_INDEX, AGATE_PANELS, ...); AGATE_WRITER_REGION names the writer's region for looks.
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { connect, eventIndexer, GuardianLog, httpFetchPage, LogStore, measuredFromEnv, roleBeats, TxSender } from "@agate/watcher";
import { HELP, run, type CliDeps } from "./commands.ts";
import { lookReader } from "./look.ts";

const nowS = () => Math.floor(Date.now() / 1000);

async function main(argv: string[]): Promise<number> {
  if (!argv[0] || argv[0] === "help" || argv[0] === "--help") {
    console.log(HELP);
    return 0;
  }
  const w = await connect("guardian", nowS);
  const events = eventIndexer(w);
  const log = new LogStore(w.logDir);
  const look = lookReader({ fetchPage: httpFetchPage, ...(process.env.SOURCE_BASE_URL ? { base: process.env.SOURCE_BASE_URL } : {}), timeoutMs: 40_000, now: nowS });
  const deps: CliDeps = {
    view: w.view,
    events,
    log,
    glog: new GuardianLog(join(w.home, "guardian")),
    alerts: w.alerts,
    clock: w.clock,
    panels: w.panels,
    now: nowS,
    out: (l) => console.log(l),
    prompt: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    },
    senderFor: (keyEnv) =>
      new TxSender({ pool: w.pool, to: w.index, keyEnv, role: keyEnv === "AGATE_KICK_KEY" ? "kick" : "guardian", alerts: w.alerts, measured: measuredFromEnv(process.env), ...(process.env.AGATE_MAX_FEE_GWEI ? { maxFeeGwei: Number(process.env.AGATE_MAX_FEE_GWEI) } : {}), now: nowS, rebroadcastS: 30, replaceS: Math.max(120, w.clock.slice / 4) }),
    look,
    beats: roleBeats(w),
    writerRegion: process.env.AGATE_WRITER_REGION ?? "writer",
  };
  return run(deps, argv);
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`guardian: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
