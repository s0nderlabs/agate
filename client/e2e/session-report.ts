// A demo session's report, read only (no key, no wallet; eth_call, eth_getBalance, one probe of anvil_nodeInfo and
// hardhat_metadata to tell a fork, and GraphQL): for the demo
// index and factory of the deployments file, per demo day whether each GPU's record is closed, final, countersigned or
// carried and how many slices each writer posted; the series the payer listed; the maker's books (every level and its
// size); the claims (who paid them, per day); the alerts the wall raised since the session began; the MON each key
// spent since the session's deploy block. Meant to be run every 30 minutes during a live check:
//
//   bun run e2e/session-report.ts [--rpc URL] [--deployments FILE] [--indexes FILE] [--graphql URL | --no-indexer]
//     [--alerts FILE] [--roles real|rehearsal] [--state DIR] [--json FILE]
//   while true; do bun run e2e/session-report.ts | tee -a <notes>/session.log; sleep 1800; done
//
// Defaults: the public RPC, contracts/deployments/10143.json and its -indexes.json beside it, the indexer at
// AGATE_E2E_GRAPHQL or http://localhost:8080/v1/graphql, ~/.agate-wall/alerts/alerts.jsonl, the real keys of
// ops/testnet/lib.sh (--roles rehearsal: the public rehearsal keys a fork rehearsal runs with). The MON out of a key is
// its balance at the deploy block less its balance now: its gas and any top-up it sent (a top-up it received reads as
// less spent);
// the first report keeps those deploy-block values in --state (default ~/.agate-session-report) for an RPC that later
// holds no state that old (a fork keeps a few hundred blocks); a first report that cannot read them keeps now's.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Abi, type Address, createPublicClient, fallback, formatEther, type Hex, http, type PublicClient } from "viem";
import { abi, createAgateClient, type Deployments, type Gpu, MULTICALL3, PANELS, PUBLIC_RPC, toNumber6 } from "../src/index.ts";
import { dateOfDay } from "../src/units.ts";
import { isLoopback, redactUrl, scrubUrls } from "./fork.ts";
import { big } from "./flows.ts";
import { claimsWithoutText, indexerText, slicesText } from "./session-lines.ts";
import { localNodeMethod } from "./testnet.ts";

const ROOT = join(import.meta.dir, "..", "..");
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (n: string) => args.includes(`--${n}`);
const KNOWN = new Set(["rpc", "deployments", "indexes", "graphql", "no-indexer", "alerts", "roles", "state", "json"]);
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (!a.startsWith("--") || !KNOWN.has(a.slice(2))) {
    console.error(`unknown argument ${a.includes("://") ? redactUrl(a) : a}\nusage: bun run e2e/session-report.ts [--rpc URL] [--deployments FILE] [--indexes FILE] [--graphql URL | --no-indexer] [--alerts FILE] [--roles real|rehearsal] [--state DIR] [--json FILE]`);
    process.exit(2);
  }
  if (a !== "--no-indexer") i++;
}
const RPC = opt("rpc") ?? PUBLIC_RPC;
// a provider's URL carries its key: the report shows and writes each --rpc URL by scheme, host and port only, and an
// error that quotes one (viem's "URL: ..." line) is printed scrubbed
const RPC_SHOWN = redactUrl(RPC);
const scrub = (s: string) => scrubUrls(s, RPC.split(","));
for (const kind of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(kind, (e: unknown) => {
    process.stderr.write(`${scrub(e instanceof Error ? (e.stack ?? e.message) : String(e))}\n`);
    process.exit(1);
  });
}
const DEP_FILE = opt("deployments") ?? join(ROOT, "contracts", "deployments", "10143.json");
const IDX_FILE = opt("indexes") ?? DEP_FILE.replace(/\.json$/, "-indexes.json");
const GQL = flag("no-indexer") ? null : (opt("graphql") ?? process.env.AGATE_E2E_GRAPHQL ?? "http://localhost:8080/v1/graphql");
const ALERTS = opt("alerts") ?? join(homedir(), ".agate-wall", "alerts", "alerts.jsonl");
const ROLES = opt("roles") ?? "real";
const STATE = opt("state") ?? join(homedir(), ".agate-session-report");
if (ROLES !== "real" && ROLES !== "rehearsal") throw new Error("--roles is real or rehearsal");

const out: Record<string, unknown> = { at: new Date().toISOString(), rpc: RPC_SHOWN, deployments: DEP_FILE };
const say = (s = "") => console.log(scrub(s));
const l = (a: string) => a.toLowerCase();
const mon = (wei: bigint, dp = 3) => Number(formatEther(wei)).toFixed(dp);
const hhmm = (t: bigint | number) => new Date(Number(t) * 1000).toISOString().slice(11, 16);
const pop = (x: bigint) => {
  let n = 0;
  for (let v = x; v > 0n; v >>= 1n) n += Number(v & 1n);
  return n;
};

// ------------------------------------------------------------------ the keys (ops/testnet/lib.sh)

function keyList(profile: string): { role: string; address: Address }[] {
  const lib = readFileSync(join(ROOT, "ops", "testnet", "lib.sh"), "utf8");
  const parse = (fn: string) => {
    const at = lib.indexOf(`${fn}() {`);
    const body = lib.slice(at, lib.indexOf("\n}", at));
    return new Map([...body.matchAll(/^\s*([a-z]+)\)\s*echo\s+(0x[0-9a-fA-F]{40})/gm)].map((m) => [m[1]!, m[2]! as Address]));
  };
  const real = parse("role_addr_real");
  const reh = parse("role_addr_rehearsal");
  const roles = ["deployer", "owner", "primary", "standby", "attester", "keeper", "bot", "payer"];
  return roles.map((r) => ({ role: r === "bot" ? "maker" : r, address: (profile === "rehearsal" ? (reh.get(r) ?? real.get(r)) : real.get(r))! })).filter((k) => !!k.address);
}

// ------------------------------------------------------------------ main

const dep = JSON.parse(readFileSync(DEP_FILE, "utf8")) as Deployments;
const rec = (existsSync(IDX_FILE) ? JSON.parse(readFileSync(IDX_FILE, "utf8")) : {}) as { demo?: { index: string; firstDay: number; deployBlock?: number; pendingBlock?: number; epochTs?: number; session?: string; at?: string; stoppedAt?: string } };
const demo = rec.demo;
if (!demo?.index) {
  say(`no demo session in ${IDX_FILE}`);
  process.exit(1);
}
const fac = dep.factories.demo && l(dep.factories.demo.index) === l(demo.index) ? dep.factories.demo : null;
// one URL, or several separated by commas (tried in order)
const pub = createPublicClient({ transport: RPC.includes(",") ? fallback(RPC.split(",").map((u) => http(u, { timeout: 30_000, retryCount: 3, retryDelay: 1_000 }))) : http(RPC, { timeout: 30_000, retryCount: 3, retryDelay: 1_000 }) }) as PublicClient;
const IX = demo.index as Address;
const IA = abi.agateIndexAbi as Abi;
const head = await pub.getBlockNumber();
// a fork: a loopback URL in any spelling, or a node that answers a local node's method whatever its URL (the label,
// and the snapshot file, never mix a fork with Monad testnet)
const FORK = isLoopback(RPC.split(",")[0]!) || (await localNodeMethod(pub)) !== null;
const now = (await pub.getBlock({ blockTag: "latest" })).timestamp;
const ck = (await pub.readContract({ address: IX, abi: IA, functionName: "clocks" })) as { day: number; slice: number; tPend: number; closeGrace: number; slices: number; epochTs: bigint; epochDay: number };
const day = Number(ck.day);
const today = Number(ck.epochDay) + Math.floor(Number(now - BigInt(ck.epochTs)) / day);
const deployBlock = BigInt(demo.deployBlock ?? demo.pendingBlock ?? 0);
const hours = Number(now - BigInt(ck.epochTs)) / 3600;
const [w0, w1] = (await pub.readContract({ address: IX, abi: IA, functionName: "writers" })) as readonly [Address, Address];
out.session = { index: IX, factory: fac?.factory ?? null, deployBlock: deployBlock.toString(), state: demo.session ?? null, startedAt: new Date(Number(ck.epochTs) * 1000).toISOString(), head: head.toString(), chainTime: new Date(Number(now) * 1000).toISOString(), demoDay: today };
say(`demo session report ${new Date().toISOString()}: ${FORK ? `FORK ${RPC_SHOWN}` : `Monad testnet ${RPC_SHOWN}`}, block ${head}, chain time ${new Date(Number(now) * 1000).toISOString()}`);
say(`index ${IX} (${demo.session ?? "?"}${demo.stoppedAt ? ` since ${demo.stoppedAt}` : ""}), a ${day} s day of ${ck.slices} slices, day ${demo.firstDay} began ${new Date(Number(ck.epochTs) * 1000).toISOString()} (${hours.toFixed(2)} h ago); demo day now ${today} (${dateOfDay(today)})${fac ? `; factory ${fac.factory}` : "; no demo factory for it in the deployments file"}`);

// ------------------------------------------------------------------ the days

async function mc(calls: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }[]): Promise<({ ok: true; v: unknown } | { ok: false })[]> {
  const res: ({ ok: true; v: unknown } | { ok: false })[] = [];
  for (let i = 0; i < calls.length; i += 300) {
    const r = (await pub.multicall({ contracts: calls.slice(i, i + 300) as never, allowFailure: true, multicallAddress: MULTICALL3 })) as { status: string; result?: unknown }[];
    for (const x of r) res.push(x.status === "success" ? { ok: true, v: x.result } : { ok: false });
  }
  return res;
}
const gpus = PANELS.map((p) => ({ gpu: p.gpu as Gpu, id: p.gpuId as Hex }));
const days: number[] = [];
for (let d = demo.firstDay; d <= today; d++) days.push(d);
const calls = days.flatMap((d) => gpus.flatMap((g) => [
  { address: IX, abi: IA, functionName: "record", args: [g.id, d] },
  { address: IX, abi: IA, functionName: "readings", args: [g.id, d, w0] },
  { address: IX, abi: IA, functionName: "readings", args: [g.id, d, w1] },
]));
const res = await mc(calls);
type Rec = { value: number; status: number; needsSign: boolean; finalAt: bigint; attestedAt: bigint; source: string };
const dayRows: unknown[] = [];
say(`\n== days (closed, final, countersigned, carried; the slices each writer posted per GPU, of ${ck.slices})`);
say(`   writers: ${w0} (slot 0), ${w1} (slot 1)`);
let i = 0;
for (const d of days) {
  let closed = 0, final = 0, attested = 0, carried = 0, waiting = 0, unread = 0;
  // a slice count whose read failed is null (said "read failed"), never a number
  const s0: (number | null)[] = [];
  const s1: (number | null)[] = [];
  const vals: string[] = [];
  for (const g of gpus) {
    const r = res[i++]!;
    const a = res[i++]!;
    const b = res[i++]!;
    if (r.ok) {
      const [exists, isFinal, x] = r.v as readonly [boolean, boolean, Rec];
      if (exists) {
        closed++;
        if (isFinal) final++;
        if (BigInt(x.attestedAt) > 0n) attested++;
        if (Number(x.status) === 4) carried++;
        if (!isFinal && x.needsSign && BigInt(x.attestedAt) === 0n) waiting++;
        vals.push(`${g.gpu} ${toNumber6(BigInt(x.value))}`);
      }
    } else unread++;
    s0.push(a.ok ? pop(BigInt((a.v as { sliceBits: bigint }).sliceBits)) : null);
    s1.push(b.ok ? pop(BigInt((b.v as { sliceBits: bigint }).sliceBits)) : null);
  }
  const end = BigInt(ck.epochTs) + BigInt((d - Number(ck.epochDay) + 1) * day);
  const open = d === today;
  say(`${d} ${dateOfDay(d)} ${open ? `open, ends ${hhmm(end)}` : `ended ${hhmm(end)}`}: closed ${closed}/6 final ${final}/6 countersigned ${attested} carried ${carried}${waiting ? ` waiting for a countersign ${waiting}` : ""}${unread ? ` record read failed ${unread}` : ""} | slices: slot 0 ${slicesText(s0)}, slot 1 ${slicesText(s1)}${vals.length ? ` | ${vals.join(", ")}` : ""}`);
  dayRows.push({ day: d, date: dateOfDay(d), open, closed, final, attested, carried, waiting, recordReadFailed: unread, slices0: s0, slices1: s1, values: vals });
}
out.days = dayRows;

// ------------------------------------------------------------------ series, books, claims (the demo factory)

const c = fac ? createAgateClient({ deployments: dep, factory: "demo", rpcUrl: RPC.split(",")[0], graphqlUrl: GQL, publicClient: pub }) : null;
const indexerUp = c ? await c.indexerUp() : false;
let indexed: bigint | null = null;
if (c?.gql && indexerUp) {
  const r = await c.gql.query<{ chain_metadata: { latest_processed_block: number | null }[] }>("{ chain_metadata { latest_processed_block } }").catch(() => null);
  indexed = r?.chain_metadata[0]?.latest_processed_block != null ? BigInt(r.chain_metadata[0].latest_processed_block) : null;
}
out.indexer = { url: GQL, used: GQL !== null, up: indexerUp, processed: indexed?.toString() ?? null, behind: indexed !== null ? (head - indexed).toString() : null };
say(`\n== ${indexerText(GQL, indexerUp, indexed, head)}`);

if (c) {
  const series = await c.getSeries();
  const listed = series.filter((s) => s.phase !== "upcoming");
  say(`\n== listings (${listed.length} listed)`);
  for (const s of series) say(`${s.symbol.padEnd(13)} ${s.phase.padEnd(8)} ${s.phase === "upcoming" ? `expected ${s.opensOn}` : `band $${s.floor} to $${s.cap}, k ${s.k} of ${s.n}, open interest ${s.openInterest} GPU-hours, market ${s.market ?? "none"}, listed ${s.listedAt || "(indexer)"}`}`);
  out.series = series;
  say("\n== the maker's books (price x GPU-hours, best first)");
  const books: Record<string, unknown> = {};
  for (const s of listed) {
    if (!s.market) continue;
    const b = await c.book(s.gpu, s.month);
    books[s.symbol] = b;
    const lv = (x: { price: number; size: number }[]) => x.map((y) => `${y.price.toFixed(2)}x${y.size}`).join(" ") || "empty";
    say(`${s.symbol.padEnd(13)} asks ${lv(b.asks)} | bids ${lv(b.bids)}${b.spread ? ` | spread ${b.spread.toFixed(2)}` : ""}`);
  }
  out.books = books;
  // the claims of the demo series, per day (k) and by who sent them
  say("\n== claims");
  if (c.gql && indexerUp && listed.length) {
    const keys = keyList(ROLES);
    const payer = l(keys.find((k) => k.role === "payer")!.address);
    const rows = await c.gql.query<{ Claim: { series_id: string; k: number; amount: string; by: string | null; payee_id: string }[] }>(`query($s: [String!]!) { Claim(where: {series_id: {_in: $s}}, limit: 50000) { series_id k amount by payee_id } }`, { s: listed.map((s) => l(s.address)) }).catch(() => null);
    if (!rows) say("the indexer refused the claims query");
    else {
      const per = new Map<string, { n: number; sum: bigint; byPayer: number }>();
      for (const r of rows.Claim) {
        const sym = listed.find((s) => l(s.address) === r.series_id)?.symbol ?? r.series_id;
        const key = `${sym} k ${r.k}`;
        const e = per.get(key) ?? { n: 0, sum: 0n, byPayer: 0 };
        e.n++;
        e.sum += BigInt(r.amount);
        if (l(r.by ?? "") === payer) e.byPayer++;
        per.set(key, e);
      }
      const all = rows.Claim.length;
      const byPayer = rows.Claim.filter((r) => l(r.by ?? "") === payer).length;
      say(`${all} claims, ${byPayer} sent by the payer (${payer}), ${all - byPayer} by others`);
      for (const [k, e] of [...per.entries()].sort()) say(`  ${k}: ${e.n} claims ($${toNumber6(e.sum)}), ${e.byPayer} by the payer`);
      out.claims = { total: all, byPayer, perDay: Object.fromEntries([...per.entries()].map(([k, e]) => [k, { n: e.n, dollars: toNumber6(e.sum), byPayer: e.byPayer }])) };
    }
  } else say(claimsWithoutText(GQL, indexerUp));
} else say("\n== no demo factory in the deployments file for this index: no listings, books or claims");

// ------------------------------------------------------------------ alerts

say(`\n== alerts since the session began (${ALERTS})`);
const t0 = Number(ck.epochTs);
if (existsSync(ALERTS)) {
  const all = readFileSync(ALERTS, "utf8").split("\n").filter(Boolean).flatMap((x) => {
    try {
      return [JSON.parse(x) as { code: string; severity: string; message: string; at: number; index?: string; cleared?: unknown; updated?: number }];
    } catch {
      return [];
    }
  });
  const mine = all.filter((a) => (a.updated ?? a.at) >= t0 || (a.index && l(a.index) === l(IX)));
  const by = new Map<string, number>();
  for (const a of mine) by.set(`${a.severity} ${a.code}`, (by.get(`${a.severity} ${a.code}`) ?? 0) + 1);
  say(`${mine.length} of ${all.length} lines: ${[...by.entries()].sort().map(([k, n]) => `${k} x${n}`).join(", ") || "none"}`);
  const open = mine.filter((a) => !a.cleared && a.severity !== "info");
  for (const a of open.slice(-8)) say(`  open ${a.severity} ${a.code} ${new Date(a.at * 1000).toISOString().slice(11, 19)}: ${a.message.slice(0, 160)}`);
  out.alerts = { lines: mine.length, byCode: Object.fromEntries(by), open: open.map((a) => ({ code: a.code, severity: a.severity, at: a.at, message: a.message })) };
} else say("no alerts file");

// ------------------------------------------------------------------ MON per key since the deploy block

say(`\n== MON out of each key since the deploy block ${deployBlock} (gas and top-ups it sent; ${hours.toFixed(2)} h; roles: ${ROLES})`);
const keys = keyList(ROLES);
const gp = await pub.getGasPrice();
const snapFile = join(STATE, `${l(IX)}-${deployBlock}-${FORK ? "fork" : "testnet"}.json`);
let snap: { block: string; at: number; keys: Record<string, { balance: string; nonce: number }> } | null = existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, "utf8")) : null;
const nowBal = await Promise.all(keys.map((k) => pub.getBalance({ address: k.address })));
const nowNonce = await Promise.all(keys.map((k) => pub.getTransactionCount({ address: k.address })));
let base: { balance: bigint; nonce: number }[] | null = null;
let baseFrom = `the deploy block ${deployBlock}`;
let baseHours = hours;
try {
  base = await Promise.all(keys.map(async (k) => ({ balance: await pub.getBalance({ address: k.address, blockNumber: deployBlock }), nonce: await pub.getTransactionCount({ address: k.address, blockNumber: deployBlock }) })));
  // kept for the reports after the RPC has pruned that block's state (a fork keeps a few hundred blocks)
  if (!snap) {
    mkdirSync(STATE, { recursive: true });
    writeFileSync(snapFile, JSON.stringify({ block: deployBlock.toString(), at: Number(ck.epochTs), keys: Object.fromEntries(keys.map((k, j) => [l(k.address), { balance: base![j]!.balance.toString(), nonce: base![j]!.nonce }])) }, null, 1));
  }
} catch {
  if (!snap) {
    snap = { block: head.toString(), at: Number(now), keys: Object.fromEntries(keys.map((k, j) => [l(k.address), { balance: nowBal[j]!.toString(), nonce: nowNonce[j]! }])) };
    mkdirSync(STATE, { recursive: true });
    writeFileSync(snapFile, JSON.stringify(snap, null, 1));
    say(`the RPC holds no state at the deploy block: snapshot taken now (block ${head}) in ${snapFile}; the next report counts from it`);
  }
  base = keys.map((k) => ({ balance: BigInt(snap!.keys[l(k.address)]?.balance ?? 0), nonce: snap!.keys[l(k.address)]?.nonce ?? 0 }));
  baseFrom = BigInt(snap.block) === deployBlock ? `the deploy block ${deployBlock} (kept by the first report)` : `the first report's snapshot (block ${snap.block})`;
  baseHours = (Number(now) - snap.at) / 3600;
}
say(`from ${baseFrom}; gas price now ${(Number(gp) / 1e9).toFixed(1)} gwei`);
const monRows: unknown[] = [];
for (const [j, k] of keys.entries()) {
  const spent = base![j]!.balance - nowBal[j]!;
  const txs = nowNonce[j]! - base![j]!.nonce;
  say(`${k.role.padEnd(9)} ${k.address} ${mon(nowBal[j]!).padStart(10)} MON now, out ${mon(spent).padStart(8)} in ${String(txs).padStart(5)} txs${baseHours > 0.05 ? `, ${(Number(formatEther(spent)) / baseHours).toFixed(3)} an hour` : ""}`);
  monRows.push({ role: k.role, address: k.address, balance: nowBal[j]!.toString(), spent: spent.toString(), txs });
}
out.mon = { from: baseFrom, hours: baseHours, keys: monRows };
const path = opt("json");
if (path) {
  writeFileSync(path, scrub(big(out)));
  say(`\njson: ${path}`);
}
