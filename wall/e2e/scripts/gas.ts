// Measures the wall's sends on a private anvil (anvil-safe) and prints the gas table, the MON a day per key and what
// each key needs for a run of a given length.
//   bun run e2e/scripts/gas.ts [--gwei 102] [--run-hours 24] [--json out.json]
// --gwei: the gas price to cost at (Monad bills gas limit x price, never gas used); read it from the network with a
// read-only eth_gasPrice. --run-hours: the run to fund (wall hours). Local chain only: nothing is sent to any public
// network. The CRE limit comes from MEASURED onReport, the least limit that lands through the CRE simulation
// forwarder's own code (apps/writer-standby/test/adversarial/six-entry-sim-forwarder.test.ts prints it).
import { writeFileSync } from "node:fs";
import { gasLimitFor, MEASURED } from "@agate/writer-standby";
import { haveAnvil, PROFILES } from "../src/chain.ts";
import { type GasReport, type GasRow, measureGas, worst } from "../src/gas.ts";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const gwei = Number(opt("--gwei") ?? "102");
const runHours = Number(opt("--run-hours") ?? "24");
const jsonOut = opt("--json");
if (!haveAnvil()) {
  console.error("anvil or contracts/out is missing: install foundry and run `cd contracts && forge build`");
  process.exit(2);
}

const reports: GasReport[] = [];
for (const p of [PROFILES.PRODUCTION, PROFILES.DEMO]) reports.push(await measureGas(p));

const fmt = (n: number) => n.toLocaleString("en-US");
const label = (r: GasRow) => `${r.path} ${r.entries > 1 || r.path === "postReport" || r.path === "onReport" ? `${r.entries} entries ` : ""}${r.gpu ? `${r.gpu} ` : ""}(${r.slots.join("+")} slots)${r.cold === undefined ? "" : r.cold ? " cold" : " warm"}`;
for (const r of reports) {
  console.log(`== ${r.profile}`);
  for (const x of r.rows) console.log(`  ${label(x).padEnd(64)} used ${fmt(x.used).padStart(9)}${x.estimate !== undefined ? `  estimate ${fmt(x.estimate)}` : ""}`);
}

// The senders' limits (13.4): writers min(CAP, ceil(1.5 x max(estimate, MEASURED))), the CRE run ceil(1.5 x MEASURED
// onReport); the watcher's attest and carryDay without AGATE_GAS_MEASURED: ceil(1.5 x estimate)
const prod = reports[0]!;
const n = prod.gpus; // GPUs the launch panel registers: entries per report, closes a day
const postN = worst(prod, "postReport", (x) => x.entries === n && x.shape === "worst");
const onN = worst(prod, "onReport", (x) => x.entries === n && x.shape === "worst");
console.log(`\nworst ${n}-entry report (${n} x 15 slots, cold): postReport ${fmt(postN)}, onReport through the test forwarder ${fmt(onN)}`);
console.log(`MEASURED in force: postReport ${fmt(Number(MEASURED.postReport))}, onReport ${fmt(Number(MEASURED.onReport))}, closeDay ${fmt(Number(MEASURED.closeDay))}`);
const lim = (est: number, m: bigint) => {
  const g = gasLimitFor(BigInt(est), m);
  return g.ok ? Number(g.limit) : NaN;
};
const launchPost = worst(prod, "postReport", (x) => x.entries === n && x.shape === "launch");
const postLimit = lim(launchPost, MEASURED.postReport);
const creLimit = lim(Number(MEASURED.onReport), MEASURED.onReport); // the runner's creGasLimit
const closeLimit = lim(worst(prod, "closeDay", (x) => x.shape === "launch"), MEASURED.closeDay);
const est = (path: GasRow["path"]) => Math.max(0, ...prod.rows.filter((x) => x.path === path && x.shape === "launch").map((x) => x.estimate ?? x.used));
const attestLimit = Math.ceil(1.5 * est("attest"));
const carryLimit = Math.ceil(1.5 * est("carryDay"));
const mon = (gas: number) => (gas * gwei) / 1e9;
const days = (p: { day: number }) => 86_400 / p.day;
console.log(`limits: CRE report ${fmt(creLimit)}, standby report ${fmt(postLimit)}, closeDay ${fmt(closeLimit)}, attest ${fmt(attestLimit)}, carryDay ${fmt(carryLimit)}`);
console.log(`\nMON a real day per key at ${gwei} gwei (${n} GPUs; Monad bills the limit), and for a ${runHours} h run:`);
for (const p of [PROFILES.DEMO, PROFILES.PRODUCTION]) {
  const d = days(p);
  const reportsADay = d * p.slices;
  const perDay = { primary: mon(reportsADay * creLimit + d * n * closeLimit), standby: mon(reportsADay * postLimit), attester: mon(d * n * attestLimit), keeper: mon(d * n * carryLimit) };
  const run = (x: number) => ((x * runHours) / 24).toFixed(1);
  console.log(`  ${p.name.padEnd(10)} ${fmt(d)} index day${d === 1 ? "" : "s"}: primary ${perDay.primary.toFixed(2)} (${fmt(reportsADay)} reports + ${fmt(d * n)} closes), standby ${perDay.standby.toFixed(2)}, attester up to ${perDay.attester.toFixed(2)} (a countersign per GPU and day), keeper up to ${perDay.keeper.toFixed(2)} (a carry per GPU and day)`);
  console.log(`  ${"".padEnd(10)} a ${runHours} h run: primary ${run(perDay.primary)}, standby ${run(perDay.standby)}, attester up to ${run(perDay.attester)}, keeper up to ${run(perDay.keeper)} MON, plus the 10 MON floor each`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ gwei, reports }, null, 1));
