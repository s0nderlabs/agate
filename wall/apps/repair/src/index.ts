// @agate/repair: the repair agent (BUILD-SPEC 15.2 to 15.4). Offchain, keyless, never in the price path.
export { CODES, httpFetchMoved, readIndexClock, RepairAgent, SHADOW_MAX, SHADOW_MIN, type AgentDeps, type FetchMoved, type IndexClock } from "./agent.ts";
export { ANSWER_SCHEMA, answerFromStdout, callClaude, checkCli, childEnv, claudeArgs, CHILD_ENV_KEYS, REQUIRED_FLAGS, STRUCTURED_FIELD, validateAnswer, type Answer } from "./claude.ts";
export { readerHash, readerSwapId, viemChain, type ChainView, type HistoryEntry } from "./chain.ts";
export { index8, loadConfig, refuseKeys, type RepairConfig } from "./config.ts";
export { diagnose, looksLikeBotWall } from "./diagnose.ts";
export { closes, detect, servedSources, IncidentStore, type Incident } from "./incidents.ts";
export { commandsText, notificationScript, reasonString, noteMarkdown, type ActionFile, type NoteJson } from "./note.ts";
export { checkPurity, FORBIDDEN_WORDS } from "./purity.ts";
export { buildPrompt, SYSTEM_PROMPT, wrapPage } from "./untrusted.ts";
export { install, noteOfDraft } from "./install.ts";
export { registryEdit, prepareScratch } from "./scratch.ts";
export { profileFor, runBatch, sandboxAvailable } from "./sandbox.ts";
export { Spawner, PROGRAM_KINDS } from "./spawn.ts";
