// Check any day yourself: recompute a GPU's index price for one day from the chain alone (Monad testnet, the public
// RPC unless AGATE_RPC_URL names another) and compare it with the value the index stored. Usage:
//   bun run check-day H100 2026-10-10     one day (a UTC date)
//   bun run check-day H100                the newest final day
// Exit code 0 when the recomputed record matches the stored one, 1 when it does not, 2 on bad input or a failed read.
import { createAgateClient, GPUS } from "../src/client.ts";
import type { DayCheck, Gpu } from "../src/types.ts";
import { dateOfDay } from "../src/units.ts";

const usd = (v: number) => `$${v.toFixed(2)}`;

export function render(r: DayCheck, where: string): string {
  const out: string[] = [];
  out.push(`${r.gpu} on ${r.date} (index day ${r.day}), ${r.final ? "final" : "not final yet"}, ${r.status.toUpperCase()}`);
  out.push(`Recomputed from ${where}${r.source ? `, source writer ${r.source}` : ""}`);
  out.push("");
  if (r.status === "carried") {
    out.push("Carried: no usable readings that day, so the index repeated the day before's price.");
  } else {
    const w = Math.max(7, ...r.sources.map((s) => s.family.length));
    out.push(`  ${"company".padEnd(w)}  readings  day price  counted`);
    for (const s of r.sources) {
      const counted = s.kind === "fresh" ? "yes, at its day price" : s.kind === "held" ? `yes, at its last good day price ${usd(s.used!)} (under ${r.minReadings} readings)` : "no";
      out.push(`  ${s.family.padEnd(w)}  ${String(s.readings).padStart(8)}  ${(s.dayPrice === null ? "-" : usd(s.dayPrice)).padStart(9)}  ${counted}`);
    }
    const n = r.sources.filter((s) => s.kind !== "out").length;
    out.push("");
    out.push(`Median of the ${n} counted: ${usd(r.recomputed)}`);
  }
  const what = r.digest ? "price, status, counts and the record's digest" : "the day before's price";
  out.push(`Stored ${usd(r.stored)}, recomputed ${usd(r.recomputed)}: ${r.match ? `MATCH (${what})` : `MISMATCH (${r.differences.join(", ")})`}`);
  const earlier = r.replay.days - 1;
  if (earlier > 0) {
    out.push(`Replayed the ${earlier} earlier day${earlier === 1 ? "" : "s"} from ${r.replay.from} for the held prices: ${r.replay.mismatches.length === 0 ? "each matches its record" : `${r.replay.mismatches.join(", ")} did not match`}`);
  }
  return out.join("\n");
}

if (import.meta.main) {
  const [gpuArg, date] = process.argv.slice(2);
  const gpu = gpuArg?.toUpperCase() as Gpu | undefined;
  if (!gpu || !GPUS.includes(gpu) || process.argv.length > 4) {
    console.error(`usage: bun run check-day <${GPUS.join("|")}> [YYYY-MM-DD]`);
    process.exit(2);
  }
  try {
    const agate = createAgateClient({ rpcUrl: process.env.AGATE_RPC_URL, graphqlUrl: null });
    let day = date;
    if (!day) {
      const latest = (await agate.gpuViews([gpu]))[0]?.latest;
      if (!latest) throw new Error(`${gpu} has no final day yet`);
      day = dateOfDay(latest.day);
    }
    const r = await agate.checkDay({ gpu, date: day });
    console.log(render(r, `${agate.chain.name} (chain ${agate.chain.id}), index ${agate.index}`));
    process.exit(r.match ? 0 : 1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
