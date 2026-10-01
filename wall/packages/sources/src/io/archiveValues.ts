// Re-parses every archived hour with the pure parsers: per hour, per source, per GPU, the state and value (numbers
// only, never page content). Feeds the panel tool's VALID-hour counts and the archive-values test fixture.
import type { GpuModel, ReadState } from "@agate/report/types";
import { parse } from "../pure/parse.ts";
import { SOURCES } from "../pure/recipe.ts";
import type { ArchiveStats } from "../panelTool.ts";
import { type ArchiveHour, archivedFx, listHours, pageTimeOf, rawDir, readArchived } from "./archive.ts";

export interface HourValues {
  hour: string; // "2026-09-30T17"
  fx: { date: string; usdPerEur: string } | null;
  sources: Record<string, { pageTime: number; rows: Partial<Record<GpuModel, { s: ReadState; v: number }>> } | null>;
}

export function valuesOfHour(h: ArchiveHour, dir = rawDir()): HourValues {
  const fx = archivedFx(h.date, dir);
  const sources: HourValues["sources"] = {};
  for (const def of SOURCES) {
    const body = readArchived(h, def.id);
    if (body === null) {
      sources[def.id] = null;
      continue;
    }
    const pageTime = pageTimeOf(h, def.id, dir);
    const utcDate = new Date(pageTime * 1000).toISOString().slice(0, 10);
    const r = parse(def.id, body, { utcDate, nowSec: pageTime, ...(fx ? { fx } : {}) });
    const rows: Partial<Record<GpuModel, { s: ReadState; v: number }>> = {};
    for (const [g, row] of Object.entries(r) as [GpuModel, NonNullable<(typeof r)[GpuModel]>][]) rows[g] = { s: row.state, v: row.valueU };
    sources[def.id] = { pageTime, rows };
  }
  return { hour: `${h.date}T${h.hour}`, fx, sources };
}

export function archiveValues(dir = rawDir()): HourValues[] {
  return listHours(dir).map((h) => valuesOfHour(h, dir));
}

export function statsOf(values: readonly HourValues[]): ArchiveStats {
  const valid: ArchiveStats["valid"] = {};
  const present: ArchiveStats["present"] = {};
  for (const h of values) {
    for (const [id, src] of Object.entries(h.sources)) {
      if (!src) continue;
      present[id] = (present[id] ?? 0) + 1;
      const per = (valid[id] ??= {});
      for (const [g, r] of Object.entries(src.rows) as [GpuModel, { s: ReadState }][]) per[g] = (per[g] ?? 0) + (r.s === "VALID" ? 1 : 0);
    }
  }
  return { hours: values.length, valid, present };
}
