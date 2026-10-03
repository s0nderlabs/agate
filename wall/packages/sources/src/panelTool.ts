// The panel tool's rules (BUILD-SPEC 7.2, 14.1 items 3 to 5), as pure functions over measured inputs:
//  - eligible: a cloud with a rule for the GPU, priced in USD (EUR only with includeEur), a page under CRE's cap
//    (over-cap only with includeOverCap), and at least one VALID hour for that GPU in the logger archive;
//  - an odd live count: when the eligible count is even, one eligible cloud is the reserve (registered, liveFrom
//    NEVER): the one with the fewest VALID hours, ties to the last in 7.2's order, unless the operator names another;
//  - one family per company, famQ 1; slots in 7.2's order.
import type { GpuModel, Hex } from "@agate/report/types";
import { gpuIdOf, recipeHash } from "./pure/panel.ts";
import { CRE_CAP_BYTES, GPUS, SOURCE_META, SOURCES, specOf } from "./pure/recipe.ts";
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

/** The panel tool's --reserve value, GPU=sourceId, for any GPU of GPUS (18.3); whether the source is eligible is
 *  buildPanel's check. */
export function reserveArg(arg: string): [GpuModel, string] {
  const m = /^([A-Z0-9]{2,8})=(p_[a-z]+)$/.exec(arg);
  if (!m || !(GPUS as readonly string[]).includes(m[1]!)) throw new Error(`--reserve takes GPU=sourceId, GPU one of ${GPUS.join(", ")} (e.g. A100=p_coreweave)`);
  return [m[1] as GpuModel, m[2]!];
}

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

/** Live families of a deploy entry, as DeployIndex.s.sol counts them (distinct families of the slots live at start). */
export function liveFamilyCount(d: Pick<DeployEntry, "family" | "liveAtStartMask">): number {
  return new Set(d.family.filter((_, i) => ((d.liveAtStartMask >> i) & 1) === 1)).size;
}

/** The panel file a deploy config (contracts/script/config/<name>.json) registers (13.3, 18.3): a testnet config the
 *  launch indexes' panel, panels/launch.json (7.10); a local or fork config panels/default.json. */
export function panelFileFor(config: string): "launch.json" | "default.json" {
  return /^testnet-/.test(config) ? "launch.json" : "default.json";
}

/** A deploy config's GPU entries from a panel file's deploy entries. A testnet config takes launch.json only (never
 *  default.json, whose L40S has one live source and whose A100 is another set), and every entry there needs an odd
 *  count of at least three live families; elsewhere an odd count (7.2, as DeployIndex.s.sol checks). */
export function deployGpus(config: string, panelFile: string, deploy: readonly DeployEntry[]): DeployEntry[] {
  const testnet = panelFileFor(config) === "launch.json";
  if (testnet && panelFile !== "launch.json") throw new Error(`${config}: a testnet config registers panels/launch.json, not ${panelFile}`);
  for (const d of deploy) {
    const live = liveFamilyCount(d);
    if (live % 2 === 0) throw new Error(`${config}: ${d.gpu} has an even live family count (${live})`);
    if (testnet && live < 3) throw new Error(`${config}: ${d.gpu} has ${live} live famil${live === 1 ? "y" : "ies"}; a testnet index needs at least three`);
  }
  return deploy.map((d) => ({ ...d, family: [...d.family], famQ: [...d.famQ] }));
}

/** The config text with its "gpus" array replaced, everything else byte for byte (a config's chainSelector is above
 *  2^53, so the file is never parsed and written back whole). */
export function withGpus(text: string, gpus: readonly DeployEntry[]): string {
  const block = JSON.stringify(gpus, null, 1).replace(/\n/g, "\n ");
  const at = text.indexOf('"gpus":');
  if (at < 0) {
    const end = text.lastIndexOf("}");
    if (end < 0) throw new Error("not a JSON object");
    const head = text.slice(0, end).replace(/\s*$/, "");
    return `${head}${head.endsWith("{") ? "" : ","}\n "gpus": ${block}\n}\n`;
  }
  const open = text.indexOf("[", at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return `${text.slice(0, open)}${block}${text.slice(i + 1)}`;
  }
  throw new Error('unclosed "gpus" array');
}
