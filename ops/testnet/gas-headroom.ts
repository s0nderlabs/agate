// Read only: how close the market bots' calls come to their gas caps on the chain they run on. Nothing is signed or
// sent, and no key or Keychain item is read.
//
//   bun run ops/testnet/gas-headroom.ts [--logs DIR] [--alerts FILE] [--rpc URL] [--limits FILE] [--since UNIX] [--per N]
//
//   --logs    the kit's window logs (default ~/.agate-kit/logs): shared-maker.log and shared-payer.log
//   --alerts  the alerts file (default ~/.agate-wall/alerts/alerts.jsonl)
//   --rpc     where to read each transaction (default the key-free public RPC, https://testnet-rpc.monad.xyz)
//   --limits  the LIMIT table override the bots run with (default ops/testnet/market-gas-limits.json)
//   --since   only log lines and alerts from this unix time on (after a change of the limits file)
//   --per     the most recent sends read per shape (default 40)
//
// For each "sent" line of the maker and the payer it reads the transaction (calldata, gas limit) and its receipt,
// computes the cap the bots' LIMIT table with the override gives that call (BOTS-SPEC 2.3: CAP = 1.5 x (LIMIT + 21,000 +
// calldata gas), or 1.5 x the provisional ceiling of an unmeasured shape) and the headroom, cap / gas limit, where the
// gas limit is 1.2 x the chain's own eth_estimateGas. A call whose estimate grows past cap / 1.2 is refused (GAS_CAP,
// nothing sent), so a headroom under 1.25 is flagged with the LIMIT that would restore 1.25. Then every refusal in the
// logs (gas_cap_split) and the alerts (GAS_CAP) with the LIMIT it needed. Exit 0 always; it only reports.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { decodeFunctionData, type Hex } from "../../wall/packages/market/node_modules/viem";
import { agateSeriesAbi } from "../../wall/packages/market/src/abi.ts";
import { kuruOrderBookAbi } from "../../wall/packages/market/src/kuru-abi.ts";
import { calldataGas, capFor, LimitTable } from "../../wall/packages/market/src/limits.ts";
import type { Shape } from "../../wall/packages/market/src/types.ts";

const argv = process.argv.slice(2);
const opt = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
};
const KIT = import.meta.dir;
const logs = opt("logs", join(homedir(), ".agate-kit/logs"));
const alertsFile = opt("alerts", join(homedir(), ".agate-wall/alerts/alerts.jsonl"));
const rpc = opt("rpc", "https://testnet-rpc.monad.xyz");
const limitsFile = resolve(opt("limits", join(KIT, "market-gas-limits.json")));
const since = Number(opt("since", "0"));
const per = Number(opt("per", "40"));
const HEADROOM = 1.25;
const FIXED = new Set<Shape>(["series.mint", "series.redeem", "factory.list", "factory.createMarket"]);

const table = LimitTable.fromEnv({ AGATE_MARKET_GAS_LIMITS: JSON.stringify(JSON.parse(readFileSync(limitsFile, "utf8"))) });

type Line = { t?: number; role?: string; event?: string; shape?: Shape; tx?: Hex; gasLimit?: string; label?: string; c?: number; n?: number; want?: string; cap?: string };
const lines: Line[] = [];
for (const f of ["shared-maker.log", "shared-payer.log"]) {
  const p = join(logs, f);
  if (!existsSync(p)) continue;
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l.startsWith("{")) continue;
    try {
      const j = JSON.parse(l) as Line;
      if ((j.t ?? 0) >= since) lines.push(j);
    } catch {
      // a line cut by a restart
    }
  }
}

let id = 0;
async function call<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (r.status === 429 && attempt < 5) {
      await Bun.sleep(1000 * (attempt + 1));
      continue;
    }
    const j = (await r.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result as T;
  }
}

/** c and n of a sent call, from its calldata (the cap depends on them); null when the calldata cannot tell. */
function shapeArgs(shape: Shape, input: Hex): { c: number; n: number; adds: number; cancels: number; cKnown: boolean } {
  const base = { c: 0, n: 1, adds: 0, cancels: 0, cKnown: true };
  try {
    if (shape === "series.sync") {
      const d = decodeFunctionData({ abi: agateSeriesAbi, data: input });
      return { ...base, c: Number(d.args![0] as bigint) };
    }
    if (shape === "series.claimMany") {
      const d = decodeFunctionData({ abi: agateSeriesAbi, data: input });
      return { ...base, n: (d.args![0] as readonly bigint[]).length, cKnown: false };
    }
    if (shape === "series.settle") return { ...base, cKnown: false };
    if (shape === "kuru.batchUpdate") {
      const d = decodeFunctionData({ abi: kuruOrderBookAbi, data: input });
      const a = d.args as readonly unknown[];
      return { ...base, adds: (a[0] as unknown[]).length + (a[2] as unknown[]).length, cancels: (a[4] as unknown[]).length };
    }
  } catch {
    return { ...base, cKnown: false };
  }
  return base;
}

/** The LIMIT that gives `gas` a headroom of 1.25 under CAP = 1.5 (LIMIT + 21,000 + calldata), rounded up to 1,000. */
const limitFor125 = (gas: number, cd: number) => Math.ceil(((gas * HEADROOM) / 1.5 - 21_000 - cd) / 1000) * 1000;

type Row = { shape: Shape; c: number; n: number; cKnown: boolean; gasLimit: number; gasUsed: number; cap: number; headroom: number; tx: Hex; need?: number };
const rows: Row[] = [];
const byShape = new Map<string, Line[]>();
for (const l of lines) {
  if (l.event !== "sent" || !l.shape || !l.tx) continue;
  const k = l.shape;
  byShape.set(k, [...(byShape.get(k) ?? []), l]);
}
for (const [, ls] of byShape) {
  for (const l of ls.slice(-per)) {
    const tx = await call<{ input: Hex; gas: Hex } | null>("eth_getTransactionByHash", [l.tx]);
    if (!tx) continue;
    const rc = await call<{ gasUsed: Hex; status: Hex } | null>("eth_getTransactionReceipt", [l.tx]);
    const a = shapeArgs(l.shape!, tx.input);
    const cap = Number(capFor(table, l.shape!, tx.input, { c: a.c, n: a.n, adds: a.adds, cancels: a.cancels }));
    const gasLimit = Number(BigInt(tx.gas));
    const row: Row = { shape: l.shape!, c: a.c, n: a.n, cKnown: a.cKnown, gasLimit, gasUsed: rc ? Number(BigInt(rc.gasUsed)) : 0, cap, headroom: cap / gasLimit, tx: l.tx! };
    // a flat LIMIT fits the fixed shapes; sync takes it per c ({"<c>": LIMIT}); claimMany and settle are raised by hand
    if (row.headroom < HEADROOM && (FIXED.has(l.shape!) || l.shape === "series.sync")) row.need = limitFor125(gasLimit, calldataGas(tx.input));
    rows.push(row);
  }
}

const pad = (s: string | number, w: number) => String(s).padStart(w);
console.log(`gas headroom of the market bots' sends (rpc ${rpc.replace(/\/v2\/.*/, "/v2/...")}, limits ${limitsFile}${since ? `, since ${since}` : ""})`);
console.log(`${"shape".padEnd(22)}${pad("sends", 6)}${pad("c", 4)}${pad("n", 4)}${pad("gas limit", 11)}${pad("gas used", 10)}${pad("cap", 11)}${pad("headroom", 10)}  LIMIT for 1.25`);
const shapes = [...new Set(rows.map((r) => `${r.shape}|${r.c}|${r.n}`))].sort();
for (const s of shapes) {
  const rs = rows.filter((r) => `${r.shape}|${r.c}|${r.n}` === s);
  const worst = rs.reduce((a, b) => (b.headroom < a.headroom ? b : a));
  // settle and claimMany: the sender's cap uses a c the calldata does not carry, so a cap figured at c 0 would be too
  // low and ask for a raise that is not needed; only their refusals (below, with the sender's own c) are evidence
  const flag = !worst.cKnown
    ? "cap depends on c (not in the calldata): see the refusals below"
    : worst.headroom < HEADROOM
      ? worst.need === undefined
        ? "raise by hand"
        : worst.shape === "series.sync"
          ? `{"${worst.c}": ${worst.need}}`
          : String(worst.need)
      : "";
  console.log(
    `${worst.shape.padEnd(22)}${pad(rs.length, 6)}${pad(worst.cKnown ? worst.c : "?", 4)}${pad(worst.n, 4)}${pad(worst.gasLimit, 11)}${pad(worst.gasUsed, 10)}${pad(worst.cKnown ? worst.cap : "?", 11)}${pad(worst.cKnown ? worst.headroom.toFixed(2) : "?", 10)}  ${flag}`,
  );
}
if (!rows.length) console.log("(no sends in the logs)");

// refusals: gas_cap_split lines (a caller that splits) and GAS_CAP alerts (nothing sent)
type Refusal = { shape: Shape; c: number; n: number; want: number; cap: number; from: string };
const refusals: Refusal[] = [];
for (const l of lines) {
  if (l.event === "gas_cap_split" && l.shape && l.want && l.cap) refusals.push({ shape: l.shape, c: l.c ?? 0, n: l.n ?? 1, want: Number(l.want), cap: Number(l.cap), from: `${l.role} log` });
}
if (existsSync(alertsFile)) {
  for (const l of readFileSync(alertsFile, "utf8").split("\n")) {
    if (!l.includes('"GAS_CAP"')) continue;
    try {
      const a = JSON.parse(l) as { code: string; at?: number; data?: { shape: Shape; c?: number; n?: number; want: string; cap: string } };
      if (a.code === "GAS_CAP" && a.data && (a.at ?? 0) >= since) refusals.push({ shape: a.data.shape, c: a.data.c ?? 0, n: a.data.n ?? 1, want: Number(a.data.want), cap: Number(a.data.cap), from: "GAS_CAP alert" });
    } catch {
      // a line cut by a restart
    }
  }
}
console.log(`\nrefused for gas (want = 1.2 x the chain's estimate > cap): ${refusals.length}`);
for (const r of refusals) {
  const need = FIXED.has(r.shape) || r.shape === "series.sync" ? Math.ceil((table.limitFor(r.shape, r.c, r.n) + (r.want * HEADROOM - r.cap) / 1.5) / 1000) * 1000 : null;
  const hint = need === null ? "raise by hand (RUNBOOK)" : r.shape === "series.sync" ? `{"${r.c}": ${need}}` : String(need);
  console.log(`  ${r.shape} c ${r.c} n ${r.n}: want ${r.want}, cap ${r.cap} (${r.from}); LIMIT for 1.25: ${hint}`);
}
