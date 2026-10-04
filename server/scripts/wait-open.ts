// Waits until a month is listed with a market (polls every 15 s, gives up after 20 min). Uses the same market env as the server.
// bun run scripts/wait-open.ts H200 2026-11
import type { Gpu } from "@agate/client";
import { marketClient } from "../src/app.ts";

const [gpu = "H200", month = "2026-11"] = process.argv.slice(2);
const c = marketClient();
const until = Date.now() + 20 * 60_000;
while (Date.now() < until) {
  // seriesAt throws "not listed" until the lister has listed the month
  const s = await c.seriesAt(gpu as Gpu, month).then((x) => ({ note: "listed", market: x.market }), (e) => ({ note: (e as Error).message.slice(0, 80), market: null }));
  console.log(new Date().toISOString().slice(11, 19), gpu, month, s.note, s.market ? "market" : "no market");
  if (s.market) process.exit(0);
  await new Promise((r) => setTimeout(r, 15_000));
}
process.exit(1);
