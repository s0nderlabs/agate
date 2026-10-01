// gpuId, recipeHash and slotValues (BUILD-SPEC 7.5, 7.6). A panel that does not match the recipe is refused loudly:
// a writer must never start, or send values in a slot order, that the registered recipeHash does not describe.
import { type GpuModel, type Hex, MAX_SLOTS } from "@agate/report/types";
import { keccak256 } from "viem";
import type { Panel, ParseResult } from "../types.ts";
import { asciiBytes, canonicalJson } from "./canonical.ts";
import { inBounds } from "./money.ts";
import { BOUNDS, FX_RECIPE, GPUS, ROUNDING, SOURCES } from "./recipe.ts";

export function gpuIdOf(spec: string): Hex {
  return keccak256(asciiBytes(spec));
}

export class PanelError extends Error {
  override name = "PanelError";
}

/** Throws PanelError unless the panel is internally consistent and every slot is a known source that prices its GPU. */
export function checkPanel(panel: Panel): void {
  const p = panel;
  if (!p || !GPUS.includes(p.gpu)) throw new PanelError(`unknown GPU ${String(p?.gpu)}`);
  if (typeof p.spec !== "string" || !p.spec.startsWith(`${p.gpu}-SXM/`)) throw new PanelError(`${p.gpu}: spec ${String(p.spec)} does not name ${p.gpu}-SXM`);
  if (String(p.gpuId).toLowerCase() !== gpuIdOf(p.spec)) throw new PanelError(`${p.gpu}: gpuId is not keccak256 of the spec`);
  if (!Array.isArray(p.families) || p.families.length === 0) throw new PanelError(`${p.gpu}: no families`);
  if (!Array.isArray(p.slots) || p.slots.length === 0 || p.slots.length > MAX_SLOTS) throw new PanelError(`${p.gpu}: ${p.slots?.length} slots`);
  const used = new Set<number>();
  const seen = new Set<string>();
  p.slots.forEach((s, i) => {
    if (s.slot !== i) throw new PanelError(`${p.gpu}: slot ${i} is numbered ${s.slot}`);
    const def = SOURCES.find((d) => d.id === s.sourceId);
    if (!def) throw new PanelError(`${p.gpu}: slot ${i} names unknown source ${s.sourceId}`);
    if (!def.rules[p.gpu]) throw new PanelError(`${p.gpu}: source ${s.sourceId} has no rule for ${p.gpu}`);
    if (seen.has(s.sourceId)) throw new PanelError(`${p.gpu}: source ${s.sourceId} in two slots`);
    seen.add(s.sourceId);
    if (!Number.isInteger(s.family) || s.family < 0 || s.family >= p.families.length) throw new PanelError(`${p.gpu}: slot ${i} family ${s.family}`);
    if (typeof s.liveAtStart !== "boolean") throw new PanelError(`${p.gpu}: slot ${i} liveAtStart is not a boolean`);
    used.add(s.family);
  });
  p.families.forEach((f, i) => {
    if (!used.has(i)) throw new PanelError(`${p.gpu}: family ${i} has no slot`);
    const size = p.slots.filter((s) => s.family === i).length;
    if (!Number.isInteger(f.famQ) || f.famQ < 1 || f.famQ > size) throw new PanelError(`${p.gpu}: family ${i} famQ ${f.famQ} with ${size} slots`);
  });
  if (!p.slots.some((s) => s.liveAtStart)) throw new PanelError(`${p.gpu}: no slot is live at start`);
}

/** The exact object recipeHash hashes (7.6), exported so tools can print it. */
export function recipeObject(panel: Panel): Record<string, unknown> {
  checkPanel(panel);
  return {
    version: 1,
    spec: panel.spec,
    slots: panel.slots.map((s) => {
      const def = SOURCES.find((d) => d.id === s.sourceId)!;
      return {
        slot: s.slot,
        sourceId: def.id,
        company: def.company,
        url: def.url,
        currency: def.currency,
        family: s.family,
        famQ: panel.families[s.family]!.famQ,
        liveAtStart: s.liveAtStart,
        parserVersion: def.parserVersion,
        rule: def.rules[panel.gpu]!,
      };
    }),
    fx: { ...FX_RECIPE },
    rounding: ROUNDING,
    bounds: [...BOUNDS],
  };
}

export function recipeHash(panel: Panel): Hex {
  return keccak256(asciiBytes(canonicalJson(recipeObject(panel))));
}

/** One report entry's values for one GPU: VALID rows' valueU (on the grid, in bounds), 0 for everything else. */
export function slotValues(panel: Panel, rows: Readonly<Record<string, ParseResult>>): number[] {
  if (!Array.isArray(panel?.slots) || panel.slots.some((s, i) => s.slot !== i)) throw new PanelError(`${panel?.gpu}: slots are not in slot order`);
  const gpu: GpuModel = panel.gpu;
  return panel.slots.map((s) => {
    const def = SOURCES.find((d) => d.id === s.sourceId);
    if (!def?.rules[gpu]) return 0;
    const r = rows?.[s.sourceId]?.[gpu];
    return r?.state === "VALID" && inBounds(r.valueU) ? r.valueU : 0;
  });
}
