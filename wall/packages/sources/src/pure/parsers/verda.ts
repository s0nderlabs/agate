// Verda (formerly DataCrunch): the public instance-types JSON.
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, type Cell, LayoutError } from "../text.ts";

const SXM = /\bSXM\d?\b/;
/** The model field per GPU and the name its rows must carry: SXM for the first three, a per-GPU pattern for the
 * price-only ones (18.2; "B300 CC" and "A100 40GB" are other models, so never read). */
const ROWS: Partial<Record<GpuModel, { model: string; name: RegExp }>> = {
  H100: { model: "H100", name: SXM },
  H200: { model: "H200", name: SXM },
  B200: { model: "B200", name: SXM },
  B300: { model: "B300", name: /^B300 SXM6 / },
  A100: { model: "A100 80GB", name: /^A100 SXM4 80GB$/ },
  L40S: { model: "L40S", name: /^L40S 48GB$/ },
};
const PRICE = /^\d{1,6}(?:\.\d+)?$/;

interface Row {
  model?: unknown;
  name?: unknown;
  currency?: unknown;
  price_per_hour?: unknown;
  gpu?: { number_of_gpus?: unknown; description?: unknown } | null;
}

export function extractVerda(body: string, _ctx: ParseContext): Partial<Record<GpuModel, Cell>> {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new LayoutError("body is not JSON");
  }
  if (!Array.isArray(data) || data.length < 5) throw new LayoutError("expected a JSON array of instance types");
  const rows = data as Row[];
  // The array must still look like instance types: model, price_per_hour and gpu on (nearly) every row.
  const typed = rows.filter((r) => r && typeof r === "object" && typeof r.model === "string" && "price_per_hour" in r && r.gpu);
  if (typed.length < rows.length * 0.9) throw new LayoutError("instance-type rows lost model, price_per_hour or gpu");

  const out: Partial<Record<GpuModel, Cell>> = {};
  for (const [g, want] of Object.entries(ROWS) as [GpuModel, { model: string; name: RegExp }][]) {
    const mine = typed.filter((r) => r.model === want.model);
    if (mine.length === 0) {
      out[g] = { kind: "missing", why: `no instance type with model ${want.model}` };
      continue;
    }
    const sized: { n: number; cell: Cell }[] = [];
    let bad: Cell | undefined;
    for (const r of mine) {
      const n = r.gpu?.number_of_gpus;
      const desc = r.gpu?.description;
      const where = `${String(r.name)} x${String(n)}`;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 16) {
        bad = { kind: "error", code: "layout-changed", why: `${where}: gpu.number_of_gpus is not a small integer` };
        break;
      }
      if (typeof desc !== "string" || !desc.startsWith(`${n}x `)) {
        bad = { kind: "error", code: "layout-changed", why: `${where}: gpu.description does not start with ${n}x` };
        break;
      }
      if (typeof r.name !== "string" || !want.name.test(r.name)) {
        bad = { kind: "error", code: "layout-changed", why: `${where}: name does not ${want.name === SXM ? "say SXM" : `match ${want.name}`}` };
        break;
      }
      if (r.currency !== "usd") {
        bad = { kind: "error", code: "other-currency", why: `${where}: currency ${JSON.stringify(r.currency)}` };
        break;
      }
      if (typeof r.price_per_hour !== "string" || !PRICE.test(r.price_per_hour)) {
        bad = { kind: "error", code: "parse-error", why: `${where}: price_per_hour ${JSON.stringify(r.price_per_hour)} is not a decimal string` };
        break;
      }
      sized.push({ n, cell: { kind: "price", raw: r.price_per_hour, gpuCount: n, where } });
    }
    if (bad) {
      out[g] = bad;
      continue;
    }
    const pick = sized.some((s) => s.n === 8) ? 8 : sized.some((s) => s.n === 1) ? 1 : 0;
    out[g] = pick
      ? agree(
          sized.filter((s) => s.n === pick).map((s) => s.cell),
          `${g} ${pick}-GPU`,
        )
      : { kind: "missing", why: `${g}: no 8-GPU or 1-GPU instance type` };
  }
  return out;
}
