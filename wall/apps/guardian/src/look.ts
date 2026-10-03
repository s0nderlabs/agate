// The guardian's look reader (BUILD-SPEC 10, `look`): fetch the panel's pages now from this machine and parse them
// with the writers' own code (parsePages: each page's UTC date from its own time, the ECB rate for that date), so a
// look reads a page exactly as a writer would. Also the e2e harness's guardian.
import type { GpuModel } from "@agate/report/types";
import { ECB, sourcesApi } from "@agate/sources/pure";
import type { ParseContext, SourceDef, SourcesPureApi } from "@agate/sources/types";
import { type PageResult, pageUrl, parsePages } from "@agate/writer-standby/core";
import type { LookReader } from "./commands.ts";

export interface LookOptions {
  fetchPage: (url: string, timeoutMs: number) => Promise<PageResult>;
  /** SOURCE_BASE_URL (replay): every page at `<base>/<sourceId>`, the ECB file at `<base>/fx_ecb` */
  base?: string;
  timeoutMs: number;
  /** the time of a page without an X-Agate-Page-Time header */
  now: () => number;
}

export function lookReader(o: LookOptions): LookReader {
  return async (ids, readers = {}) => {
    const out: Record<string, Partial<Record<GpuModel, { state: string; valueU: number }>>> = {};
    // 8.6: a slot whose reader in force this build may not use reads as no reading (MISSED, unknown), never with
    // another reader; an allowed swapped reader fetches its own URL and parses with its own version
    const api = sourcesApi as unknown as SourcesPureApi;
    const defs: SourceDef[] = [];
    const parseVersion: Record<string, string> = {};
    for (const d of sourcesApi.SOURCES.filter((s) => ids.includes(s.id))) {
      const r = readers[d.id];
      if (!r || (r.url === d.url && r.parserVersion === d.parserVersion)) {
        defs.push(d);
        continue;
      }
      const ok = typeof api.readerAllowed === "function" ? api.readerAllowed(d.id, r) : { ok: false as const, why: "this build has no reader registry" };
      if (!ok.ok) {
        out[d.id] = Object.fromEntries(Object.keys(d.rules).map((g) => [g, { state: "MISSED", valueU: 0, why: ok.why }]));
        continue;
      }
      defs.push({ ...d, url: r.url });
      parseVersion[d.id] = r.parserVersion;
    }
    const pages: Record<string, PageResult> = {};
    for (const d of defs) pages[d.id] = await o.fetchPage(pageUrl(d.id, d.url, o.base), o.timeoutMs);
    const eur = defs.some((d) => d.currency === "EUR" && pages[d.id]!.ok);
    const fx = eur ? await o.fetchPage(pageUrl(ECB.id, ECB.url, o.base), o.timeoutMs) : undefined;
    const withVersions = Object.keys(parseVersion).length === 0 ? api : { ...api, parse: (id: string, body: string, ctx: ParseContext) => (parseVersion[id] ? api.parseWith(parseVersion[id]!, body, ctx) : api.parse(id, body, ctx)) };
    const { logs } = parsePages(withVersions as typeof sourcesApi, defs, pages, fx, o.now());
    for (const l of logs) {
      const def = defs.find((d) => d.id === l.sourceId)!;
      // no ECB rate for the page's date is missing evidence (FAILED, as the logger writes it), never a dark page
      if (def.currency === "EUR" && pages[l.sourceId]!.ok && l.fxDate === undefined) {
        for (const g of Object.keys(l.rows) as GpuModel[]) l.rows[g] = { state: "FAILED", valueU: 0 };
      }
      out[l.sourceId] = l.rows;
    }
    return out;
  };
}
