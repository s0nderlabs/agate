// The standby writer (writer slot 1): a plain bun service, its own key, the shared pipeline, posting through
// postReport. Env: AGATE_RPC_URLS (two or more; AGATE_RPC_URL alone raises RPC_SINGLE), AGATE_INDEX,
// AGATE_STANDBY_KEY, AGATE_PANELS; optional AGATE_WALL_HOME, AGATE_CHAIN_ID, SOURCE_BASE_URL (replay server),
// AGATE_MAX_FEE_GWEI, AGATE_GAS_POST / AGATE_GAS_CLOSE (MEASURED overrides).
import { runService } from "./pipeline/service.ts";

await runService({ role: "standby", keyEnv: "AGATE_STANDBY_KEY", expectSlot: 1 });
