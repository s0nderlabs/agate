// Verda (formerly DataCrunch): the public instance-types JSON.
import type { GpuModel } from "@agate/report/types";
import type { ParseContext } from "../../types.ts";
import { agree, type Cell, LayoutError } from "../text.ts";

const NAMES: Record<GpuModel, string> = { H100: "H100", H200: "H200", B200: "B200" };
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
  for (const g of Object.keys(NAMES) as GpuModel[]) {
    const mine = typed.filter((r) => r.model === NAMES[g]);
    if (mine.length === 0) {
      out[g] = { kind: "missing", why: `no instance type with model ${NAMES[g]}` };
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
      if (typeof r.name !== "string" || !/\bSXM\d?\b/.test(r.name)) {
        bad = { kind: "error", code: "layout-changed", why: `${where}: name does not say SXM` };
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
