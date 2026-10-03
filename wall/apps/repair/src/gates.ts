// Gates 1 to 5 and the shadow judgement (BUILD-SPEC 15.2). A draft runs only in the sandbox (sandbox.ts); its result
// rows are judged here, in the agent, against the reader in force and the trackers.
import { dirname, join } from "node:path";
import type { GpuModel } from "@agate/report/types";
import { GPUS, httpsHost, inBounds, SOURCES } from "@agate/sources/pure";
import { renderPage, type SynthGpu, type SynthPage } from "@agate/sources";
import type { ParsedRow, ParseResult } from "@agate/sources/types";
import { isGap } from "@agate/pagecheck";
import { checkSyntax } from "./ast.ts";
import { checkPurity } from "./purity.ts";
import { type BatchPage, runBatch } from "./sandbox.ts";
import { typecheckScratch } from "./scratch.ts";
import type { Spawner } from "./spawn.ts";

export type GateResult = { ok: true; detail: string } | { ok: false; why: string };

export const GATE1_DETAIL = "allowed imports only, one extract, no forbidden word, the syntax allowlist holds (plain globals only, no reflection, safe keys, no writes outside its own values), typechecks under the pure settings. The program checks this much; read the draft line by line before installing it";

/** Gate 1: the word and import rules, the syntax allowlist (ast.ts), then tsc on the scratch copy. */
export async function gate1(spawner: Spawner, source: string, pkg: string, env: Record<string, string>): Promise<GateResult> {
  const p = checkPurity(source);
  if (!p.ok) return { ok: false, why: p.why };
  const a = await checkSyntax(source, join(dirname(pkg), "ast"));
  if (!a.ok) return { ok: false, why: `syntax allowlist: ${a.why}` };
  const t = await typecheckScratch(spawner, pkg, env);
  return t.ok ? { ok: true, detail: GATE1_DETAIL } : t;
}

/** Gate 5: a proposed URL must be https on the source's hosts; never fetched otherwise. */
export function gate5(sourceId: string, url: string | undefined): GateResult {
  if (url === undefined) return { ok: true, detail: "no new URL" };
  const def = SOURCES.find((s) => s.id === sourceId);
  const host = httpsHost(url);
  if (!def || host === null) return { ok: false, why: "the proposed URL is not a plain https URL" };
  if (!def.hosts.includes(host)) return { ok: false, why: `the proposed URL's host ${host} is not on ${sourceId}'s hosts` };
  return { ok: true, detail: `https on ${host}` };
}

const rowOf = (r: ParseResult | { error: string } | undefined, g: GpuModel): ParsedRow | undefined => (r && !("error" in r) ? (r as ParseResult)[g] : undefined);

/** One new page: VALID on every GPU the trackers list, within 10% of the tracker value, on the cent grid and inside
 *  the bounds; a GPU no tracker lists must be VALID (same grid and bounds) or NOT_RENTABLE. */
export function judgeNew(rows: ParseResult | { error: string } | undefined, gpus: readonly GpuModel[], tracker: (g: GpuModel, own: number) => number | null): { ok: true; compared: number } | { ok: false; why: string } {
  if (!rows || "error" in rows) return { ok: false, why: `the parser failed (${rows && "error" in rows ? String(rows.error).slice(0, 80) : "no result"})` };
  let compared = 0;
  for (const g of gpus) {
    const r = rowOf(rows, g);
    if (r?.state === "VALID" && !inBounds(r.valueU)) return { ok: false, why: `${g} ${r.valueU} is off the cent grid or out of bounds` };
    const t = r?.state === "VALID" ? tracker(g, r.valueU) : tracker(g, 0);
    if (t !== null) {
      if (r?.state !== "VALID") return { ok: false, why: `${g} reads ${r?.state ?? "nothing"} where the trackers list a price` };
      if (isGap(r.valueU, t)) return { ok: false, why: `${g} reads ${r.valueU} u, more than 10% from the trackers' ${t} u` };
      compared++;
    } else if (r?.state !== "VALID" && r?.state !== "NOT_RENTABLE") return { ok: false, why: `${g} reads ${r?.state ?? "nothing"}` };
  }
  return { ok: true, compared };
}

/** Same state and value on every GPU where the reader in force read VALID or NOT_RENTABLE. */
export function sameAsInForce(draft: ParseResult | { error: string } | undefined, inForce: ParseResult | { error: string } | undefined, gpus: readonly GpuModel[]): { ok: true; checked: number } | { ok: false; why: string } {
  let checked = 0;
  for (const g of gpus) {
    const f = rowOf(inForce, g);
    if (!f || (f.state !== "VALID" && f.state !== "NOT_RENTABLE")) continue;
    const d = rowOf(draft, g);
    if (!d || d.state !== f.state || d.valueU !== f.valueU) return { ok: false, why: `${g}: the reader in force read ${f.state} ${f.valueU}, the draft ${d?.state ?? "nothing"} ${d?.valueU ?? ""}`.trim() };
    checked++;
  }
  return { ok: true, checked };
}

export interface RunCtx {
  spawner: Spawner;
  bun: string;
  draftDir: string;
  pkg: string;
}

async function runAll(x: RunCtx, versions: string[], pages: BatchPage[], per = 25): Promise<{ ok: true; rows: Map<string, Record<string, ParseResult | { error: string }>> } | { ok: false; why: string }> {
  const all = new Map<string, Record<string, ParseResult | { error: string }>>();
  for (let i = 0; i < pages.length; i += per) {
    const r = await runBatch(x.spawner, x.bun, x.draftDir, x.pkg, versions, pages.slice(i, i + per));
    if (!r.ok) return r;
    for (const [k, v] of r.rows) all.set(k, v);
  }
  return { ok: true, rows: all };
}

/** Gate 2: on saved pages from before the incident, the draft equals the reader in force wherever that read VALID or
 *  NOT_RENTABLE. */
export async function gate2(x: RunCtx, draftV: string, inForceV: string, gpus: readonly GpuModel[], pages: BatchPage[]): Promise<GateResult> {
  if (pages.length === 0) return { ok: true, detail: "no saved page from before the incident" };
  const r = await runAll(x, [draftV, inForceV], pages);
  if (!r.ok) return r;
  let used = 0;
  for (const p of pages) {
    const rows = r.rows.get(p.id);
    const s = sameAsInForce(rows?.[draftV], rows?.[inForceV], gpus);
    if (!s.ok) return { ok: false, why: `page ${p.id}: ${s.why}` };
    if (s.checked > 0) used++;
  }
  return { ok: true, detail: `${used} of ${pages.length} saved pages from before the incident read the same` };
}

/** Gate 3: every saved page since the incident (at least three) judged by judgeNew; at least one tracker comparison. */
export async function gate3(x: RunCtx, version: string, gpus: readonly GpuModel[], pages: BatchPage[], tracker: (pageId: string, g: GpuModel, own: number) => number | null): Promise<GateResult> {
  if (pages.length < 3) return { ok: false, why: `only ${pages.length} saved pages since the incident (three needed)` };
  const r = await runAll(x, [version], pages);
  if (!r.ok) return r;
  let compared = 0;
  for (const p of pages) {
    const j = judgeNew(r.rows.get(p.id)?.[version], gpus, (g, own) => tracker(p.id, g, own));
    if (!j.ok) return { ok: false, why: `page ${p.id}: ${j.why}` };
    compared += j.compared;
  }
  if (compared === 0) return { ok: false, why: "no tracker value to compare with on any new page" };
  return { ok: true, detail: `${pages.length} pages since the incident VALID, ${compared} GPU readings within 10% of the trackers` };
}

/** The synthetic fixtures of gate 4: every row state on the source's own (old) layout. */
export function fixturePages(sourceId: string, now: number): BatchPage[] {
  const def = SOURCES.find((s) => s.id === sourceId);
  if (!def) return [];
  const gs = GPUS.filter((g) => def.rules[g]);
  const all = (v: SynthGpu): SynthPage => Object.fromEntries(gs.map((g) => [g, v]));
  const cases: [string, SynthPage][] = [
    ["eight", all({ price: "3.99", count: 8 })],
    ["one", all({ price: "4.29", count: 1 })],
    ["sold-out", all({ state: "not-rentable" })],
    ["no-row", all({ state: "missing" })],
    ["garbled", all({ state: "garbled" })],
    ["out-of-bounds", all({ price: "1500.00", count: 8 })],
    ["other-currency", all({ raw: def.currency === "USD" ? "\u20ac3.99" : "$3.99", count: 8 })],
  ];
  if (gs.length > 1) cases.push(["mixed", { [gs[0]!]: { price: "3.99", count: 8 }, [gs[1]!]: { state: "not-rentable" } }]);
  const utcDate = new Date(now * 1000).toISOString().slice(0, 10);
  const out: BatchPage[] = [];
  for (const [id, page] of cases) {
    try {
      out.push({ id: `fixture:${id}`, body: renderPage(sourceId, page), utcDate, nowSec: now });
    } catch {
      // a state the source's page cannot show
    }
  }
  return out;
}

/** Gate 4 (moved and wrong cell only): on every fixture the draft gives the reader in force's states and values. */
export async function gate4(x: RunCtx, draftV: string, inForceV: string, gpus: readonly GpuModel[], pages: BatchPage[]): Promise<GateResult> {
  const r = await runAll(x, [draftV, inForceV], pages);
  if (!r.ok) return r;
  for (const p of pages) {
    const rows = r.rows.get(p.id);
    for (const g of gpus) {
      const d = rowOf(rows?.[draftV], g);
      const f = rowOf(rows?.[inForceV], g);
      if ((d?.state ?? "none") !== (f?.state ?? "none") || (d?.valueU ?? 0) !== (f?.valueU ?? 0)) return { ok: false, why: `${p.id} ${g}: the reader in force reads ${f?.state ?? "nothing"}, the draft ${d?.state ?? "nothing"}` };
    }
  }
  return { ok: true, detail: `${pages.length} synthetic pages of every row state read as the reader in force reads them` };
}

export const shadowFile = (draftDir: string) => join(draftDir, "shadow.jsonl");
