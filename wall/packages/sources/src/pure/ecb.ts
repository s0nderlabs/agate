// ECB reference rates (eurofxref-hist-90d.xml or eurofxref-daily.xml): the USD rate of the last ECB business day
// strictly before the page's UTC date (BUILD-SPEC 7.4). Pure string parsing; returns null rather than guessing.
import type { FxRate } from "../types.ts";
import { DecimalError, fxMicro } from "./money.ts";
import { elements } from "./text.ts";

/** A rate older than this many days before the page's date means a stale file, never a long ECB holiday. */
export const FX_MAX_AGE_DAYS = 7;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a valid YYYY-MM-DD, else null. */
export function dayNumber(d: string): number | null {
  const m = DATE.exec(d);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const t = Date.UTC(y, mo - 1, da);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== da) return null;
  return t / 86_400_000;
}

/** A rate is usable for a page dated pageDate: dated strictly before it, at most FX_MAX_AGE_DAYS before, sane value. */
export function fxUsableFor(fx: FxRate | undefined, pageDate: string): boolean {
  if (!fx) return false;
  const a = dayNumber(fx.date);
  const b = dayNumber(pageDate);
  if (a === null || b === null || a >= b || b - a > FX_MAX_AGE_DAYS) return false;
  try {
    fxMicro(fx);
    return true;
  } catch {
    return false;
  }
}

export function parseEcb(body: string, forUtcDate: string): FxRate | null {
  if (typeof body !== "string" || dayNumber(forUtcDate) === null) return null;
  if (!body.includes("eurofxref") || !body.includes("European Central Bank")) return null;
  // A day without a USD rate is kept as "" so that, if it is the latest day, nothing older is used silently.
  const byDate = new Map<string, string>();
  for (const d of elements(body, /<Cube\s+time=(["'])(\d{4}-\d{2}-\d{2})\1\s*>/g, "</Cube>")) {
    const date = d.open[2]!;
    const usd = [...d.inner.matchAll(/<Cube\s+currency=(["'])USD\1\s+rate=(["'])([^"'<>]*)\2\s*\/>/g)];
    if (usd.length > 1) return null; // two USD rates on one day: a corrupt file
    const rate = usd.length === 1 ? usd[0]![3]! : "";
    const prev = byDate.get(date);
    if (prev !== undefined && prev !== rate) return null; // the same day twice with different rates
    byDate.set(date, rate);
  }
  let best: string | null = null;
  for (const d of byDate.keys()) if (d < forUtcDate && (best === null || d > best)) best = d;
  if (best === null || byDate.get(best) === "") return null;
  const fx: FxRate = { date: best, usdPerEur: byDate.get(best)! };
  try {
    fxMicro(fx);
  } catch (e) {
    if (e instanceof DecimalError) return null;
    throw e;
  }
  return fxUsableFor(fx, forUtcDate) ? fx : null;
}
