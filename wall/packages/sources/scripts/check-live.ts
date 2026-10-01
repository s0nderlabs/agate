// Fetches each source page ONCE (honest user agent) and prints size, cap status and the parsed rows. For a person
// confirming today's pages after a parser change; never run on a schedule (live pages are not for polling).
//   bun run scripts/check-live.ts [--role check]
import { fetchSource } from "../src/io/fetch.ts";
import { ECB, parse, parseEcb, SOURCES } from "../src/pure/index.ts";

const i = process.argv.indexOf("--role");
const role = i > 0 ? process.argv[i + 1]! : "check";
const now = Math.floor(Date.now() / 1000);
const utcDate = new Date(now * 1000).toISOString().slice(0, 10);
const ecb = await fetchSource(ECB.url, { role, retryBefore: now });
const fx = ecb.ok ? parseEcb(ecb.body, utcDate) : null;
console.log(`fx_ecb http=${ecb.httpStatus} bytes=${ecb.bytes} overCap=${ecb.overCap} rate=${fx ? `${fx.date} ${fx.usdPerEur}` : "none"}`);
for (const s of SOURCES) {
  const r = await fetchSource(s.url, { role, retryBefore: now });
  const rows = r.ok ? parse(s.id, r.body, { utcDate, nowSec: r.fetchedAt, ...(fx ? { fx } : {}) }) : {};
  const shown = Object.entries(rows)
    .map(([g, x]) => `${g}=${x!.state === "VALID" ? (x!.valueU / 1e6).toFixed(2) : `${x!.state}(${x!.detail})`}`)
    .join(" ");
  console.log(`${s.id} http=${r.httpStatus} bytes=${r.bytes} overCap=${r.overCap} ${r.error ?? ""} ${shown}`);
}
