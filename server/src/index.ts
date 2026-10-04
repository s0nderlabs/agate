// agate server entry: bun run src/index.ts (runs in a tmux window).
import { config } from "./config.ts";
import { internalApp, logger, marketClient, publicApp } from "./app.ts";
import { startAutopilot } from "./autopilot.ts";
import { Store } from "./store.ts";

const log = logger();
const store = new Store();
const internalPort = Number(process.env.AGATE_INTERNAL_PORT ?? 5192);

// A trade tool call holds its request open while the Assistant signs and the operation lands: ~5 s usually, 24 s seen
// (Oct 4) when Dynamic's signing was slow. Bun's default 10 s idle timeout cut that reply although the trade landed,
// so allow up to the intent's lifetime (the AI then gets the result instead of a dropped connection).
Bun.serve({ hostname: config.host, port: config.port, idleTimeout: Math.min(255, Math.ceil(config.intentTtlMs / 1000) + 30), fetch: publicApp({ store, log }).fetch });
Bun.serve({ hostname: "127.0.0.1", port: internalPort, fetch: internalApp({ store, log }).fetch });
setInterval(() => store.pruneIntents(), 600_000).unref();
// standing orders ("keep my hedge going"); AGATE_AUTOPILOT=0 turns the loop off
if (process.env.AGATE_AUTOPILOT !== "0") startAutopilot({ store, client: () => marketClient(), log });

log({ event: "server.started", port: config.port, internalPort, environmentId: config.environmentId });
