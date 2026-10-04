// `bun run apps/guardian/src/cli.ts <command> [--index addr]` (BUILD-SPEC 10). Reads the watcher's log and alerts, the
// index's guardian log (<home>/guardian/<index lowercase>/, 13.7) and the chain. Sends only veto, suspend and attest
// with AGATE_GUARDIAN_KEY and kick with AGATE_KICK_KEY, each read at the moment of sending (set them only for that one
// call), each under the per-key send lock (13.7). Environment as the watcher's (AGATE_RPC_URLS_CMD or AGATE_RPC_URLS,
// AGATE_INDEX or --index, AGATE_PANELS, ...); AGATE_WRITER_REGION names the writer's region for looks.
import { createInterface } from "node:readline/promises";
import { sourcesApi } from "@agate/sources/pure";
import { addressOfEnvKey, connect, eventIndexer, GuardianLog, guardianLogDir, httpFetchPage, isReaderApi, keyLockPath, LogStore, measuredFromEnv, oldGuardianLogWarning, printableLines, type ReaderApi, ReaderBook, roleBeats, SendLock, TxSender } from "@agate/watcher";
import { statusPath } from "../../pagecheck/src/index.ts";
import { HELP, run, type CliDeps } from "./commands.ts";
import { lookReader } from "./look.ts";

const nowS = () => Math.floor(Date.now() / 1000);

async function main(argv: string[]): Promise<number> {
  if (!argv[0] || argv[0] === "help" || argv[0] === "--help") {
    console.log(HELP);
    return 0;
  }
  const ix = argv.indexOf("--index");
  if (ix >= 0) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(argv[ix + 1] ?? "")) throw new Error("--index needs the index address");
    process.env.AGATE_INDEX = argv[ix + 1]!;
    argv = [...argv.slice(0, ix), ...argv.slice(ix + 2)];
  }
  const w = await connect("guardian", nowS);
  const warn = oldGuardianLogWarning(w.home);
  if (warn) console.log(`warning: ${warn}`);
  const events = eventIndexer(w);
  const log = new LogStore(w.logDir);
  const look = lookReader({ fetchPage: httpFetchPage, ...(process.env.SOURCE_BASE_URL ? { base: process.env.SOURCE_BASE_URL } : {}), timeoutMs: 40_000, now: nowS });
  const deps: CliDeps = {
    view: w.view,
    events,
    log,
    glog: new GuardianLog(guardianLogDir(w.home, w.index)),
    alerts: w.alerts,
    clock: w.clock,
    panels: w.panels,
    now: nowS,
    // every line through printable(), our own line feeds kept (the help, a prompt): chain strings (a swap's url,
    // parserVersion, reason) are printable()d where commands.ts formats them, so they never reach the terminal raw
    out: (l) => console.log(printableLines(l)),
    prompt: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(printableLines(q));
      } finally {
        rl.close();
      }
    },
    senderFor: (keyEnv) =>
      new TxSender({ pool: w.pool, ...(w.send ? { send: w.send } : {}), to: w.index, keyEnv, role: keyEnv === "AGATE_KICK_KEY" ? "kick" : "guardian", alerts: w.alerts, measured: measuredFromEnv(process.env), ...(process.env.AGATE_MAX_FEE_GWEI ? { maxFeeGwei: Number(process.env.AGATE_MAX_FEE_GWEI) } : {}), now: nowS, rebroadcastS: 30, replaceS: Math.max(120, w.clock.slice / 4), lock: new SendLock(keyLockPath(w.home, addressOfEnvKey(keyEnv)), Math.max(30, w.clock.slice / 4) * 1000) }),
    look,
    beats: roleBeats(w),
    writerRegion: process.env.AGATE_WRITER_REGION ?? "writer",
    pagecheckStatus: statusPath(w.home, w.index),
    ...(isReaderApi(sourcesApi as Partial<ReaderApi>) ? { readers: new ReaderBook(sourcesApi as unknown as ReaderApi, w.panels, w.clock) } : {}),
    tx: async (hash) => {
      try {
        const t = await w.pool.call((c) => c.getTransaction({ hash }));
        return { from: t.from, blockNumber: t.blockNumber };
      } catch {
        return null;
      }
    },
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
