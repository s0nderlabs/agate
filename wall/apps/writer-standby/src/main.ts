// The standby writer (writer slot 1): a plain bun service, its own key, the shared pipeline, posting through
// postReport. Env: AGATE_RPC_URLS_CMD (a command printing the URL list, run once at start: Alchemy's URL carries a
// key, 13.6) or AGATE_RPC_URLS (two or more; AGATE_RPC_URL alone raises RPC_SINGLE), AGATE_INDEX, AGATE_STANDBY_KEY,
// AGATE_PANELS (panels/launch.json for the launch indexes, 7.10); optional AGATE_WALL_HOME, AGATE_CHAIN_ID,
// SOURCE_BASE_URL (replay server), AGATE_MAX_FEE_GWEI, AGATE_GAS_POST / AGATE_GAS_CLOSE (MEASURED overrides),
// AGATE_LOGS_CHUNK / AGATE_LOGS_CALLS / AGATE_LOGS_BACKLOG (eth_getLogs range, calls per tick and blocks scanned
// back at a start, for KEY_MISMATCH, 8.5).
import { runService } from "./pipeline/service.ts";

await runService({ role: "standby", keyEnv: "AGATE_STANDBY_KEY", expectSlot: 1 });
