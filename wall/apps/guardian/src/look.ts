// The guardian's look reader (BUILD-SPEC 10, `look`): fetch the panel's pages now from this machine and parse them
// with the writers' own code (parsePages: each page's UTC date from its own time, the ECB rate for that date), so a
// look reads a page exactly as a writer would. Also the e2e harness's guardian.
import type { GpuModel } from "@agate/report/types";
import { ECB, sourcesApi } from "@agate/sources/pure";
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
  return async (ids) => {
    const defs = sourcesApi.SOURCES.filter((s) => ids.includes(s.id));
    const pages: Record<string, PageResult> = {};
    for (const d of defs) pages[d.id] = await o.fetchPage(pageUrl(d.id, d.url, o.base), o.timeoutMs);
    const eur = defs.some((d) => d.currency === "EUR" && pages[d.id]!.ok);
    const fx = eur ? await o.fetchPage(pageUrl(ECB.id, ECB.url, o.base), o.timeoutMs) : undefined;
    const { logs } = parsePages(sourcesApi, defs, pages, fx, o.now());
    const out: Record<string, Partial<Record<GpuModel, { state: string; valueU: number }>>> = {};
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
