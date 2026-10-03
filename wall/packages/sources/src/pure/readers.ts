// Readers in force (BUILD-SPEC 4.15, 7.6, 7.7, 8.6). A slot's reader is its page URL plus the parser version that
// reads it: the registered recipe's until the first executed swap, then the newest swap whose fromDay has begun. A
// reader is used only when its URL is https on the source's own hosts and its version is installed for that source;
// anything else reads as no reading (READER_MISSING or READER_REFUSED), never with another reader. Pure: no URL class
// (CRE's WASM runtime has none), so the host is taken with a strict pattern.
import type { PanelSlot, ReaderProblem, ReaderRef, ReaderSwap, SourceDef } from "../types.ts";
import { installed } from "./parse.ts";
import { EXTRACTORS_BY_VERSION } from "./parsers/index.ts";
import { SOURCES } from "./recipe.ts";

/** Every installed parser version, in registry order. */
export const PARSER_VERSIONS: readonly string[] = Object.keys(EXTRACTORS_BY_VERSION);

/** "lambda/2" -> "p_lambda"; null when the version is not installed. */
export function sourceOfVersion(parserVersion: string): string | null {
  return installed(parserVersion)?.sourceId ?? null;
}

function defOf(sourceId: string): SourceDef | undefined {
  return SOURCES.find((s) => s.id === sourceId);
}

/** The registered reader of a source (its recipe's URL and parserVersion). */
export function registeredReader(sourceId: string): ReaderRef | null {
  const d = defOf(sourceId);
  return d ? { url: d.url, parserVersion: d.parserVersion } : null;
}

/** The host of an https URL ("https://host[/path][?query]"), lowercase; null for anything else (another scheme, a
 * port, user info, spaces or control characters, a bad host name, or a URL the contract would refuse by length). */
export function httpsHost(url: string): string | null {
  if (typeof url !== "string" || url.length < 9 || url.length > 256) return null;
  if (/[\s\u0000-\u001f\u007f\\]/.test(url)) return null;
  const m = /^https:\/\/([A-Za-z0-9.-]+)(?=[/?#]|$)/.exec(url);
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..") || !host.includes(".")) return null;
  return host;
}

/** Why a reader cannot be used for a source, or null when it can (8.6). */
export function readerProblem(sourceId: string, r: ReaderRef): ReaderProblem | null {
  const d = defOf(sourceId);
  if (!d) return { code: "refused", why: `unknown source ${String(sourceId)}` };
  const url = r?.url;
  const host = httpsHost(url);
  if (host === null) return { code: "refused", why: `the URL is not a plain https URL of 9 to 256 characters` };
  if (!d.hosts.includes(host)) return { code: "refused", why: `host ${host} is not on ${d.id}'s hosts (${d.hosts.join(", ")})` };
  const v = r?.parserVersion;
  if (typeof v !== "string" || v.length === 0 || v.length > 32) return { code: "refused", why: "the parserVersion is empty or longer than 32 characters" };
  const of = sourceOfVersion(v);
  if (of === null) return { code: "missing", why: `parser ${v} is not installed in this build` };
  if (of !== d.id) return { code: "refused", why: `parser ${v} reads ${of}, not ${d.id}` };
  return null;
}

/** https, host on the source's hosts, version installed and of this source. */
export function readerAllowed(sourceId: string, r: ReaderRef): { ok: true } | { ok: false; why: string } {
  const p = readerProblem(sourceId, r);
  return p ? { ok: false, why: p.why } : { ok: true };
}

/** The newest swap with fromDay <= day, else null (the registered reader applies). */
export function swapInForce(history: readonly ReaderSwap[], day: number): ReaderSwap | null {
  let best: ReaderSwap | null = null;
  for (const h of history ?? []) if (h.fromDay <= day && (best === null || h.fromDay > best.fromDay)) best = h;
  return best;
}

/** The reader in force on `day` for a panel slot: the registered reader before the first fromDay, then the newest
 * swap whose fromDay has begun (4.15: one swap per slot per fromDay, so the history's fromDay strictly increases). */
export function readerInForce(slot: PanelSlot, history: readonly ReaderSwap[], day: number): ReaderRef {
  const reg = registeredReader(slot.sourceId);
  if (!reg) throw new Error(`unknown source ${slot.sourceId} in slot ${slot.slot}`);
  const s = swapInForce(history, day);
  return s ? { url: s.url, parserVersion: s.parserVersion } : reg;
}

/** True when the reader is the source's registered one. */
export function isRegistered(sourceId: string, r: ReaderRef): boolean {
  const reg = registeredReader(sourceId);
  return reg !== null && reg.url === r.url && reg.parserVersion === r.parserVersion;
}
