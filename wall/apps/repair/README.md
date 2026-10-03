# @agate/repair: the repair agent (BUILD-SPEC 15.2 to 15.4)

Watches every served index, opens incidents when a page stops reading, diagnoses them, drafts a reader v2 with Claude Code headless (Claude Code's own sign-in, no API key), gates and sandboxes the draft, shadow-runs it beside the reader in force, then writes an **approval note** (a file, an action alert and a macOS notification) with the exact owner commands for the reader swap of 4.15. **It never holds or reads a key, never sends a transaction, never commits, and never edits the repo**: only `repair install`, run by the operator in their checkout, writes there. Never imported by a writer or the watcher (a test greps the imports).

## Run

```
bun run apps/repair/src/main.ts watch                                    # one process for every index
bun run apps/repair/src/cli.ts status | notes | draft <incidentId> | install <draftId>
```

Env: `AGATE_WALL_HOME`, `AGATE_INDEXES` (comma-separated), `AGATE_PANELS` (`AGATE_PANELS_<index8>` overrides), `AGATE_RPC_URLS_CMD` (optional, read only: `readerHistory`, `queuedEta`; without it the registered readers are assumed and queued swaps are not followed), `AGATE_RAW_DIR` (the logger archive, read only), `AGATE_CLAUDE_BIN` (default `claude`; give the absolute path under launchd), `AGATE_REPAIR_MODEL`, `AGATE_REPO` (the checkout printed in the commands), `AGATE_REPAIR_MAX_CALLS_INCIDENT` (3), `AGATE_REPAIR_MAX_CALLS_DAY` (8), `AGATE_REPAIR_CLAUDE_TIMEOUT_S` (600), `AGATE_REPAIR_NOTIFY` (`0`: no macOS notification), `AGATE_NOTIFY_CMD`, `AGATE_WATCHER_LOG_DIR_<index8>`. It refuses to start with any `*_KEY`, `*_KEY_CMD`, `CRE_ETH_PRIVATE_KEY` or `ANTHROPIC_API_KEY` variable set. Every RPC URL is scrubbed from its output and files (`@agate/report/env`). launchd: `launchd/xyz.s0nderlabs.agate-repair.plist.template` (not loaded; Label `xyz.s0nderlabs.agate-repair`; PATH must hold node, which tsc runs on, and the Claude CLI). Heartbeat: `repair/heartbeat.json`.

Cadence: each index every `min(3,600 s, slice)`, and at once when the alerts file gains a PAGECHECK_FAULT, READER_MISSING or READER_REFUSED of a served index.

## Incidents and diagnosis

Per (index, source) for every source with a live or reserve slot, from the watcher's log (the GPUs are the source's panel GPUs):

| Trigger | Kind |
|---|---|
| NO_ROW or BAD_VALUE on a GPU in 3 consecutive served (2xx) intervals | `reader` |
| FAILED in 6 consecutive intervals | `fetch` |
| NOT_RENTABLE on every GPU for DAY of intervals | `sold_out` |
| an open PAGECHECK_FAULT on a slot of the source | `wrong_cell` |

Diagnosis (deterministic; the model may add a reason, never overrule it): **sold out** (note "nothing to do"), **blocked** (401, 403, 429, 503 or a bot-wall body: note "reroute the fetch (R4, R4b); a reader swap does not help", with the trackers still listing the cloud quoted), **moved** (a redirect with a `location` in the watcher's line, or 404 / 410: a Location on the source's `hosts` is fetched once per interval and tried with the reader in force, giving a **URL-only swap** when it reads, or a redesign on the new URL; anything else REPAIR_REFUSED), **redesign** (2xx, the reader gives NO_ROW or BAD_VALUE and the page differs from every page it read VALID: a Claude draft), **wrong cell** (a Claude draft), **unsure** (a note, no draft). An incident closes when the source reads VALID, within 10% of the trackers where compared, for 3 intervals after it opened.

## Drafting with Claude Code headless

```
<AGATE_CLAUDE_BIN> -p --restricted --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --disable-slash-commands --no-session-persistence --output-format json \
  --json-schema '<ANSWER_SCHEMA>' --system-prompt '<SYSTEM_PROMPT>' [--model <AGATE_REPAIR_MODEL>]
```

The prompt goes on stdin (never argv); the child runs in a fresh empty `repair/claude-cwd/<random>/` (deleted after) with only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`, `TERM`. At start `--help` must list `--restricted`, `--tools`, `--json-schema`, `--strict-mcp-config` and `--no-session-persistence`, else REPAIR_REFUSED and no call is ever made. The answer is read from the CLI's **`structured_output`** field (Claude Code docs, headless mode: "The parsed output is placed in the structured_output field"), a `result` string holding the JSON as the fallback, and validated again against the schema. Budgets: 3 calls per incident, 8 per UTC day (`repair/budget.json`), a 600 s timeout. A refused draft is retried at the next interval while the incident's budget lasts, with the program's refusal reason in the next TASK. A new URL is taken only from a redirect's Location, never from the model.

Untrusted input (15.3): each page sits in `<<<PAGE id=<n> nonce=<32 hex>>>` ... `<<<END nonce=...>>>` with the markers and the nonce removed from its text first; at most 60,000 characters around the rule's product names per page, four pages, 250,000 characters in all; HTML comments and hidden text are kept as data. The model's `notes` reach the operator only quoted as "Model output (untrusted)"; the program writes the reason string, the action file and the commands; no page or model text reaches a command line, an osascript string, a file name or a reason.

## Gates (`drafts/<draftId>/gates.json`; any failure raises REPAIR_REFUSED naming the gate)

1. **Purity**: at most 40,000 characters; imports only `{ ... } from "../text.ts"`, `type { ... } from "../../types.ts"`, `type { ... } from "@agate/report/types"`; exactly one export, `extract`; none of the forbidden words anywhere (`fetch`, `Bun`, `process`, `require`, `eval`, `Function`, `globalThis`, `window`, `self`, `import(`, `XMLHttpRequest`, `WebSocket`, `setTimeout`, `setInterval`, `queueMicrotask`, `Deno`, `__proto__`, `Reflect`, `Proxy`, `Atomics`, `SharedArrayBuffer`, `WebAssembly`; also `constructor`, `module`, `exports`, `arguments`, control and bidi characters), checked on the whole source, comments and strings included; and it typechecks as `src/pure/parsers/<name>.v<N>.ts` in a scratch copy of the sources package (`drafts/<draftId>/pkg/`, registered between the repair markers exactly as install registers it) under the pure settings.
2. **Back compatibility**: on up to 200 saved pages from before the incident (the watcher's raw pages of 14 days and, for the registered URL, the logger archive), wherever the reader in force read VALID or NOT_RENTABLE, the draft reads the same state and value.
3. **New pages**: on the saved pages since the incident (at least three, the newest 24): VALID within 10% of the page check's tracker value of that interval on every GPU the trackers list (VALID or NOT_RENTABLE where they list none), on the cent grid, inside the bounds, and at least one tracker comparison in all.
4. **Fixtures** (wrong cell and moved): on synthetic pages of every row state in the source's own layout, the draft reads as the reader in force.
5. **Hosts**: a proposed URL is https on the source's `hosts`.

**Sandbox**: a draft runs only as `sandbox-exec -p '(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath "<draft dir>/out"))' <bun> run src/runner.ts <batch>`, with only `PATH`, `HOME` and `TMPDIR` (the out folder) and `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, 60 s per batch (then killed), stdout capped at 4 MB. Without `sandbox-exec` (not macOS) drafts are refused ("no sandbox"). Gate 1 is a filter, not a proof (a computed property name can still reach a global at run time); the sandbox and the operator's review and install are the locks.

**Shadow run**: every new watcher interval runs the draft (or, for a URL-only swap, the reader in force on the agent's fetch of the new URL) and appends to `shadow.jsonl`; the note is written after 6 good intervals in a row (a bad one resets the count); 24 intervals without reaching 6 raise REPAIR_REFUSED ("shadow failed").

## The approval note (15.4)

`notes/<incidentId>.md` and `.json`, `actions/<incidentId>-<index8>.json` for every served index whose panel holds the source (the `AGATE_OWNER_ACTION` file of `contracts/script/OwnerAction.s.sol`: one `READER` entry per (gpuId, slot), with the url, the parserVersion and a reason of at most 280 bytes), REPAIR_NOTE (action, through the alert sink, so `AGATE_NOTIFY_CMD` forwards it) and `display notification "<index8> <sourceId>: <kind>, note ready" with title "agate repair"`. The commands, in order: review the draft (path and sha256), queue (`forge script script/OwnerAction.s.sol --sig 'queue()'` with the owner key read by `security` inline, the public RPC, never the Alchemy URL), install, review and commit, restart the readers (the labels printed), execute after eta inside the 14 DAY window, and the first day it applies. After the note the agent follows the swap: REPAIR_WINDOW when it is past its eta, unexecuted, with less than 2 DAY of its window left.

`repair install <draftId>` (a TTY only): checks the draft's sha256 against its note and its gates, re-runs gate 1, writes `packages/sources/src/pure/parsers/<name>.v<N>.ts` (never over an existing file), adds its import and registry line, runs `bun test packages/sources` and prints the next steps. It never runs git.

## Data (`<AGATE_WALL_HOME>/repair/`)

`incidents.jsonl` (append-only, newest line per id), `drafts/<draftId>/` (`extractor.ts`, `prompt.txt`, `response.json`, `notes.txt`, `gates.json`, `shadow.jsonl`, `sha256`, `pkg/`, `out/`, `batches/`), `notes/`, `actions/`, `fetched/<incidentId>/` (a moved source's new page), `budget.json`, `requests.jsonl` (from `cli draft`), `claude-cwd/`, `heartbeat.json`, `repair.lock`.

## Known limits

- The watcher's logger follows redirects, so a 3xx reaches the agent only if the logger records the redirect (`location` in its line); a page that moved to a new layout shows as a redesign and is drafted on the URL in force.
- Only USD sources are drafted (EUR sources need the FX context in the sandbox; the launch panels are USD only).
- A draft that typechecks but reads the old layout differently from v1 fails gate 2: a v2 must read every older page as v1 did.

## Tests

`bun test apps/repair` (no real Claude call anywhere: `AGATE_CLAUDE_BIN` points at a fixture that records argv, environment, stdin and cwd and prints a canned answer): purity, prompt wrapping and caps, the pinned system prompt, the exact argv, the scrubbed environment and the empty cwd, the start check, budgets, every diagnosis row, triggers and closure, the commands byte for byte, the reason and notification templates, the registry edit, the spawn allowlist, no wallet client, the key guard; on macOS the sandbox (a loop killed, a socket and a file write stopped, the environment inside), gates 1 to 4 on synthetic pages including the replay's redesigned Lambda layout (a correct v2 passes, a spot-cell v2 fails gate 3, a v2 that forgot the old layout fails gate 2), and the whole loop end to end (incident, draft, gates, a shadow run with a reset, note, action file, alerts, closure; REPAIR_WINDOW; off-host and model URLs refused; an impure draft refused until the budget is spent; a moved source's URL-only swap); `repair install`.
