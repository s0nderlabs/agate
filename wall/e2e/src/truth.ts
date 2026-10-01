// What a page truly showed at a second, to a requester role: the scripted price or state, else the archived hour's
// row (parsed numbers from AGATE_RAW_DIR, never page content kept). The honest reference is built from these values,
// independent of what any writer posted.
import type { GpuModel } from "@agate/report/types";
import { type Replay, type ReplayScenario, type ScriptedSource, valuesOfHour } from "@agate/sources/io";
import { parseMicro } from "@agate/sources/pure";

type StepAt = { day: number; slice?: number };
function current<T extends { from: StepAt }>(steps: readonly T[] | undefined, day: number, slice: number): T | undefined {
  const key = (a: StepAt) => a.day * 1_000_000 + (a.slice ?? 0);
  const now = key({ day, slice });
  let best: T | undefined;
  for (const s of steps ?? []) if (key(s.from) <= now && (!best || key(s.from) >= key(best.from))) best = s;
  return best;
}

export class Truth {
  private readonly hourCache = new Map<string, ReturnType<typeof valuesOfHour>>();
  constructor(
    readonly replay: Replay,
    readonly scenario: ReplayScenario,
  ) {}

  private script(id: string, role?: string): ScriptedSource | undefined {
    return (role ? this.scenario.roles?.[role]?.[id] : undefined) ?? this.scenario.scripted?.[id];
  }

  /** The valid reading (u) a correct parser takes from the page, or 0 when the page shows none. */
  value(id: string, gpu: GpuModel, t: number, role?: string): number {
    const r = this.replay.resolve(t);
    const sc = this.script(id, role);
    const page = current(sc?.page, r.day, r.slice);
    if (page && page.state !== "ok" && page.state !== "gzip-raw") return 0;
    if (page?.state === "gzip-raw") return 0; // compressed bytes without Content-Encoding: unreadable
    const step = current(sc?.gpus?.[gpu], r.day, r.slice);
    if (step) return step.price !== undefined ? Number(parseMicro(step.price)) : 0;
    if (!r.hour) return 0;
    const key = `${r.hour.date}T${r.hour.hour}`;
    let hv = this.hourCache.get(key);
    if (!hv) {
      hv = valuesOfHour(r.hour);
      this.hourCache.set(key, hv);
    }
    const row = hv.sources[id]?.rows[gpu];
    return row && row.s === "VALID" ? row.v : 0;
  }
}
