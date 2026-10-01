// The panel tool's rules (BUILD-SPEC 7.2, 14.1 items 3 to 5), as pure functions over measured inputs:
//  - eligible: a cloud with a rule for the GPU, priced in USD (EUR only with includeEur), a page under CRE's cap
//    (over-cap only with includeOverCap), and at least one VALID hour for that GPU in the logger archive;
//  - an odd live count: when the eligible count is even, one eligible cloud is the reserve (registered, liveFrom
//    NEVER): the one with the fewest VALID hours, ties to the last in 7.2's order, unless the operator names another;
//  - one family per company, famQ 1; slots in 7.2's order.
import type { GpuModel, Hex } from "@agate/report/types";
import { gpuIdOf, recipeHash } from "./pure/panel.ts";
import { CRE_CAP_BYTES, SOURCE_META, SOURCES, specOf } from "./pure/recipe.ts";
import type { Panel } from "./types.ts";

export interface PanelFlags {
  includeEur?: boolean;
  includeOverCap?: boolean;
  reserve?: Partial<Record<GpuModel, string>>;
}

/** VALID hours per source and GPU in the archive, and how many hours each source was present. */
export interface ArchiveStats {
  hours: number;
  valid: Record<string, Partial<Record<GpuModel, number>>>;
  present: Record<string, number>;
}

export interface DeployEntry {
  gpu: GpuModel;
  spec: string;
  gpuId: Hex;
  recipeHash: Hex;
  family: number[];
  famQ: number[];
  liveAtStartMask: number;
}

export interface PanelChoice {
  gpu: GpuModel;
  panel: Panel;
  deploy: DeployEntry;
  live: string[];
  reserve: string | null;
  displayOnly: { sourceId: string; reasons: string[] }[];
  validHours: Record<string, number>;
  warnings: string[];
}

export const CAP_WARN_SHARE = 0.75;

export function buildPanel(gpu: GpuModel, stats: ArchiveStats | null, flags: PanelFlags = {}): PanelChoice {
  const candidates = SOURCES.filter((s) => s.rules[gpu]);
  const eligible: string[] = [];
  const displayOnly: { sourceId: string; reasons: string[] }[] = [];
  const validHours: Record<string, number> = {};
  const warnings: string[] = [];
  for (const s of candidates) {
    const reasons: string[] = [];
    const bytes = SOURCE_META[s.id]?.bytes;
    if (s.currency === "EUR" && !flags.includeEur) reasons.push("EUR price (display-only by default; flag --include-eur)");
    if (bytes === undefined) reasons.push("page size never measured");
    else if (bytes > CRE_CAP_BYTES && !flags.includeOverCap) {
      reasons.push(`page is ${bytes} bytes, over CRE's ${CRE_CAP_BYTES}-byte cap, no narrower URL (flag --include-over-cap)`);
    }
    if (stats) {
      validHours[s.id] = stats.valid[s.id]?.[gpu] ?? 0;
      if (validHours[s.id] === 0) reasons.push(`no VALID ${gpu} hour in the archive (${stats.present[s.id] ?? 0} hours read)`);
    }
    if (reasons.length) displayOnly.push({ sourceId: s.id, reasons });
    else {
      eligible.push(s.id);
      if (bytes !== undefined && bytes > CAP_WARN_SHARE * CRE_CAP_BYTES && bytes <= CRE_CAP_BYTES) {
        warnings.push(`${s.id} page is ${bytes} bytes, ${Math.round((100 * bytes) / CRE_CAP_BYTES)}% of CRE's cap`);
      }
    }
  }
  if (!stats) warnings.push("no archive: eligibility does not check VALID hours and the reserve is the last eligible cloud");
  if (eligible.length === 0) throw new Error(`${gpu}: no eligible source`);

  let reserve: string | null = null;
  if (eligible.length % 2 === 0) {
    const named = flags.reserve?.[gpu];
    if (named) {
      if (!eligible.includes(named)) throw new Error(`${gpu}: reserve ${named} is not eligible (${eligible.join(", ")})`);
      reserve = named;
    } else {
      // Fewest VALID hours; ties go to the last in 7.2's order (>= keeps the later one).
      let best = -1;
      for (const id of eligible) {
        const v = stats ? validHours[id]! : 0;
        if (reserve === null || v <= best) {
          reserve = id;
          best = v;
        }
      }
    }
  } else if (flags.reserve?.[gpu]) {
    warnings.push(`${gpu}: reserve ${flags.reserve[gpu]} ignored, the eligible count ${eligible.length} is already odd`);
  }

  const spec = specOf(gpu);
  const panel: Panel = {
    gpu,
    spec,
    gpuId: gpuIdOf(spec),
    families: eligible.map((id) => ({ name: SOURCES.find((s) => s.id === id)!.company, famQ: 1 })),
    slots: eligible.map((sourceId, i) => ({ slot: i, sourceId, family: i, liveAtStart: sourceId !== reserve })),
  };
  const deploy: DeployEntry = {
    gpu,
    spec,
    gpuId: panel.gpuId,
    recipeHash: recipeHash(panel),
    family: panel.slots.map((s) => s.family),
    famQ: panel.families.map((f) => f.famQ),
    liveAtStartMask: panel.slots.reduce((m, s) => (s.liveAtStart ? m | (1 << s.slot) : m), 0),
  };
  return {
    gpu,
    panel,
    deploy,
    live: eligible.filter((id) => id !== reserve),
    reserve,
    displayOnly,
    validHours,
    warnings,
  };
}
