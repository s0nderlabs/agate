// The approval note (BUILD-SPEC 15.2, 15.4): notes/<incidentId>.md and .json, one owner action file per affected
// index (the AGATE_OWNER_ACTION file of 13.3), and the exact commands in the operator's order. The program writes the
// reason string, the action file and the commands; the model's notes reach the operator only quoted as model output.
// No key material ever: only the `security` command text for the operator to run themselves.
import type { GpuModel, Hex } from "@agate/report/types";
import { ACTION_WINDOW_DAYS } from "@agate/report/types";
import type { Diagnosis, Evidence, Incident } from "./incidents.ts";

export const PUBLIC_RPC = "https://testnet-rpc.monad.xyz";
export const REASON_MAX_BYTES = 280;

export interface ReaderEntry {
  kind: "READER";
  gpuId: Hex;
  slot: number;
  url: string;
  parserVersion: string;
  reason: string;
}
export interface ActionFile {
  actions: ReaderEntry[];
}

export interface NoteClock {
  day: number;
  slice: number;
  timelock: number;
  epochTs: number;
  epochDay: number;
}

const enc = new TextEncoder();
/** Cut to at most `max` UTF-8 bytes on a character boundary. */
export function cutBytes(s: string, max: number): string {
  if (enc.encode(s).length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (enc.encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}

export const isoMin = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function evidenceText(e: Evidence): string {
  return `${e.intervals} intervals: served ${e.served}, no row ${e.noRow}, bad value ${e.badValue}, not rentable ${e.notRentable}, failed ${e.failed}, valid ${e.valid}${e.faults ? `, page check fault ${e.faults}` : ""}`;
}

/** "<kind> since <UTC time>; <evidence counts>; draft <draftId>", at most 280 bytes. Program-written only. */
export function reasonString(kind: string, since: number, e: Evidence, draftId: string): string {
  return cutBytes(`${kind} since ${isoMin(since)}; ${evidenceText(e)}; draft ${draftId}`, REASON_MAX_BYTES);
}

const dayIdAt = (c: NoteClock, t: number) => (t < c.epochTs ? c.epochDay : c.epochDay + Math.floor((t - c.epochTs) / c.day));
const dayDate = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);

export interface CommandIndex {
  index: string; // 0x..., as the chain knows it
  actionFile: string;
  /** sha256 (hex, no 0x) of the action file's bytes, which `$(cat ...)` passes unchanged (no trailing newline) */
  actionSha256?: string;
  clock: NoteClock;
}

/** A path for the operator's shell, single-quoted; a path holding a quote or a control character is refused. */
export function shq(p: string): string {
  if (/['\u0000-\u001f\u007f]/.test(p)) throw new Error(`a path in the note's commands holds a quote or a control character: ${JSON.stringify(p.slice(0, 80))}`);
  return `'${p}'`;
}

export const labelsOf = (index8: string) => [`xyz.s0nderlabs.agate-writer-primary-${index8}`, `xyz.s0nderlabs.agate-writer-standby-${index8}`, `xyz.s0nderlabs.agate-watcher-log-${index8}`];

/** The commands of 15.2, filled in, in the order of 15.4. */
export function commandsText(o: { home: string; repo: string; draft: { id: string; sha256: string } | null; urlOnly: boolean; indexes: readonly CommandIndex[]; now: number }): string {
  const L: string[] = [];
  const pad = "            ";
  if (o.draft) {
    L.push(`1  review   ${shq(`${o.home}/repair/drafts/${o.draft.id}/extractor.ts`)}   (sha256 ${o.draft.sha256})`);
    L.push(`${pad}read it line by line: the gates and the sandbox are a filter, not a proof; once committed it runs inside the writers and the watcher`);
  } else L.push(`1  review   nothing to review: a URL-only swap (same parserVersion, the new URL passed gates 3 to 5 and the shadow run)`);
  for (const x of o.indexes) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(x.index)) throw new Error("an index in the note's commands is not an address");
    L.push(`2  queue    cd ${shq(`${o.repo}/contracts`)} && AGATE_OWNER_KEY="$(security find-generic-password -s agate.wall.owner -a private-key -w)" \\`);
    L.push(`${pad}AGATE_INDEX=${x.index} AGATE_OWNER_ACTION="$(cat ${shq(x.actionFile)})"${x.actionSha256 ? ` AGATE_OWNER_ACTION_SHA256=${x.actionSha256}` : ""} \\`);
    L.push(`${pad}forge script script/OwnerAction.s.sol --sig 'queue()' --rpc-url ${PUBLIC_RPC} --broadcast`);
  }
  if (o.urlOnly || !o.draft) {
    L.push(`3  install  skipped (URL-only swap: the parser version is already installed)`);
    L.push(`4  commit   skipped (URL-only swap)`);
    L.push(`5  restart  skipped (URL-only swap: the readers take the new URL from readerHistory)`);
  } else {
    L.push(`3  install  cd ${shq(`${o.repo}/wall`)} && bun run apps/repair/src/cli.ts install ${o.draft.id}`);
    L.push(`4  commit   review and commit`);
    L.push(`5  restart  the readers of every served index: copy the committed wall/ to the launchd app copy (13.2), then restart the primary`);
    L.push(`${pad}(its runner recompiles the CRE workflow at start; a prebuilt AGATE_CRE_WASM must be rebuilt first), the standby`);
    L.push(`${pad}and the watcher logger: launchctl kickstart -k gui/$(id -u)/<each label>`);
    for (const x of o.indexes) L.push(`${pad}labels: ${labelsOf(x.index.slice(2, 10).toLowerCase()).join(" ")}`);
  }
  L.push(`6  execute  after <eta> and before <eta + 14 DAY>: step 2 with --sig 'execute()'`);
  for (const x of o.indexes) L.push(`${pad}${x.index.slice(2, 10).toLowerCase()}: eta = the queue time + ${x.clock.timelock} s (step 2 prints it); the window ends ${ACTION_WINDOW_DAYS * x.clock.day} s after eta`);
  L.push(`7  effect   from day <dayId(execute + slice) + 1>; every earlier day stays as recorded`);
  for (const x of o.indexes) {
    const d = dayIdAt(x.clock, o.now + x.clock.timelock + x.clock.slice) + 1;
    L.push(`${pad}${x.index.slice(2, 10).toLowerCase()}: queued now and executed at eta, from day ${d} (${dayDate(d)})`);
  }
  return `${L.join("\n")}\n`;
}

/** The macOS notification (15.2): a fixed template; variable parts restricted to [A-Za-z0-9 _:,./-]. */
export function notificationScript(index8: string, sourceId: string, kind: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9 _:,./-]/g, "").slice(0, 64);
  return `display notification "${clean(index8)} ${clean(sourceId)}: ${clean(kind)}, note ready" with title "agate repair"`;
}

export interface NoteReader {
  index: string;
  gpu: GpuModel;
  gpuId: Hex;
  slot: number;
  inForce: { url: string; parserVersion: string };
  proposed: { url: string; parserVersion: string };
}

export interface NoteJson {
  kind: "agate.repair-note";
  version: 1;
  incident: Pick<Incident, "id" | "index" | "sourceId" | "kind" | "gpus" | "sinceK" | "since" | "evidence">;
  diagnosis: Diagnosis | null;
  modelNotes: string | null;
  draft: { id: string; path: string; sha256: string } | null;
  urlOnly: boolean;
  nothingToDo: boolean;
  gates: Record<string, string>;
  shadow: { good: number; seen: number; fromK: number; lastK: number } | null;
  readers: NoteReader[];
  actionFiles: string[];
  commands: string | null;
  writtenAt: number;
}

/** Every C0 and C1 control but LF, and the bidirectional and line-separator marks, shown as a visible escape
 *  (\x1b, \u202e as text): a terminal then prints them as text (recheck r1, L1: an ESC conceal, an OSC 52
 *  clipboard write or a bare CR in the model's notes reached the note the operator reads with cat). */
export function visible(s: string): string {
  return s.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => {
    const h = c.charCodeAt(0).toString(16);
    return h.length <= 2 ? `\\x${h.padStart(2, "0")}` : `\\u${h.padStart(4, "0")}`;
  });
}

/** Model text quoted line by line; code fences neutralised so it can never close the commands block; controls shown
 *  as escapes. */
export function quoteModel(s: string): string {
  return s
    .replace(/```/g, "'''")
    .split(/\r?\n/)
    .map((l) => `> ${visible(l)}`)
    .join("\n");
}

/** A value from a page or a header on one line, without control characters or backticks. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f`]/g, " ").slice(0, 300);

export function noteMarkdown(n: NoteJson): string {
  const i = n.incident;
  const L: string[] = [];
  L.push(`# agate repair note: ${i.index.slice(2, 10)} ${i.sourceId}, ${i.kind}`, "");
  L.push(`Incident ${i.id}: index ${i.index}, source ${i.sourceId}, GPUs ${i.gpus.join(", ")}, kind ${i.kind}, since ${isoMin(i.since)} (interval ${i.sinceK}).`);
  L.push(`Evidence: ${evidenceText(i.evidence)}.`, "");
  if (n.diagnosis) L.push(`Diagnosis (deterministic): ${n.diagnosis.kind}. ${n.diagnosis.why}${n.diagnosis.location ? ` Location: ${oneLine(n.diagnosis.location)}.` : ""}`);
  if (n.diagnosis?.support?.length) L.push(`Trackers still listing the cloud: ${n.diagnosis.support.map(oneLine).join("; ")}.`);
  if (n.nothingToDo) L.push("", "Nothing to do: no swap is proposed.");
  if (n.modelNotes !== null) L.push("", "Model output (untrusted):", "", quoteModel(n.modelNotes));
  if (n.draft) L.push("", `Draft: ${n.draft.path} (sha256 ${n.draft.sha256})`);
  if (Object.keys(n.gates).length) L.push("", "Gates:", ...Object.entries(n.gates).map(([k, v]) => `- ${k}: ${v}`));
  if (n.shadow) L.push("", `Shadow run: ${n.shadow.good} consecutive good intervals (${n.shadow.seen} seen, intervals ${n.shadow.fromK} to ${n.shadow.lastK}).`);
  if (n.readers.length) {
    L.push("", "| index | gpu | slot | reader in force | proposed reader |", "|---|---|---|---|---|");
    for (const r of n.readers) L.push(`| ${r.index.slice(2, 10)} | ${r.gpu} | ${r.slot} | ${r.inForce.parserVersion} ${r.inForce.url} | ${r.proposed.parserVersion} ${r.proposed.url} |`);
  }
  if (n.commands) L.push("", "Commands, in this order (15.4):", "", "```", n.commands.trimEnd(), "```");
  // gate results and readers can carry a draft's or the chain's text too: no control reaches the file
  return `${visible(L.join("\n"))}\n`;
}
