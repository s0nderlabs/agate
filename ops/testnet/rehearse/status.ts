// Fork rehearsal only (read only, a loopback fork): what a demo session's processes did on chain since a block: the
// demo index's events, readings per writer, closed and attested days, the H100 record of each day, the series the
// factories listed, and per rehearsal key its transactions, gas limits and gas used (MON at 102 gwei: Monad bills
// the gas limit). Scans every block, so it is for a local fork, never a public RPC.
//   bun run ops/testnet/rehearse/status.ts <fork rpc> <records json> <deployments json> [fromBlock]
import { readFileSync } from "node:fs";
import { createPublicClient, decodeEventLog, http, type Hex, type Address } from "../../../wall/packages/report/node_modules/viem";
import { agateIndexAbi } from "../../../wall/packages/report/src/abi.ts";
import { agateFactoryAbi } from "../../../wall/packages/market/src/abi.ts";

const [rpc, recFile, depFile, fromArg] = process.argv.slice(2);
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(rpc ?? "")) throw new Error("a loopback fork URL only");
const rec = JSON.parse(readFileSync(recFile!, "utf8"));
const dep = JSON.parse(readFileSync(depFile!, "utf8"));
const pub = createPublicClient({ transport: http(rpc!, { timeout: 60_000 }) });
const demo = rec.demo.index as Address;
const from = BigInt(fromArg ?? rec.demo.deployBlock);
const latest = await pub.getBlockNumber();
const now = Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
const KEYS: Record<string, string> = {
  primary: "0x659D83f1f28bA0Dc3056d9aE426fcD9b8f5878cE",
  standby: "0x8b0153ABB9a995ee399e5acB4FEDaA2936f9c83b",
  attester: "0x62922A844f0473faBa6fd9bC0688b43a85Bf7959",
  keeper: "0xF2aCfEE043510402669f4F120F8BA06e8503cF01",
  maker: "0x9A410E49A53115E85b751fE8D3b589bb8F1a717F",
  payer: "0xe1eCba46ecaeba115f92F15C066FBE5335c409Ee",
};
const byAddr = new Map(Object.entries(KEYS).map(([k, v]) => [v.toLowerCase(), k]));

async function logs(address: Address | Address[]) {
  const out = [];
  for (let b = from; b <= latest; b += 2000n) {
    const to = b + 1999n > latest ? latest : b + 1999n;
    out.push(...(await pub.getLogs({ address, fromBlock: b, toBlock: to })));
  }
  return out;
}

const ix = await logs(demo);
const ev: Record<string, number> = {};
const posts: Record<string, number> = {};
const closed: string[] = [];
const attested: string[] = [];
for (const l of ix) {
  try {
    const d = decodeEventLog({ abi: agateIndexAbi, data: l.data, topics: l.topics as never }) as { eventName: string; args: Record<string, unknown> };
    ev[d.eventName] = (ev[d.eventName] ?? 0) + 1;
    if (d.eventName === "ReadingsPosted") {
      const w = byAddr.get(String(d.args.writer).toLowerCase()) ?? String(d.args.writer);
      posts[w] = (posts[w] ?? 0) + 1;
    }
    if (d.eventName === "DayClosed") closed.push(`${d.args.day ?? d.args.dayId}`);
    if (d.eventName === "Attested") attested.push(`${d.args.day ?? d.args.dayId}`);
  } catch {
    ev.undecoded = (ev.undecoded ?? 0) + 1;
  }
}
// per-day H100 record
const H100 = "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955" as Hex;
const head = Number(await pub.readContract({ address: demo, abi: agateIndexAbi, functionName: "head", args: [H100] }));
const days = [];
for (let d = rec.demo.firstDay as number; d < head; d++) {
  const [ex, fin, r] = (await pub.readContract({ address: demo, abi: agateIndexAbi, functionName: "record", args: [H100, d] })) as unknown as [boolean, boolean, { value: number; status: number; source: Address; attestedAt: bigint; needsSign: boolean }];
  days.push({ d, exists: ex, final: fin, value: r.value / 1e6, source: byAddr.get(r.source.toLowerCase()) ?? r.source, attested: r.attestedAt > 0n, status: r.status });
}
// factories
const fl = await logs(Object.values(dep.factories).map((f) => (f as { factory: Address }).factory));
const listed: string[] = [];
const markets: number[] = [];
for (const l of fl) {
  try {
    const d = decodeEventLog({ abi: agateFactoryAbi, data: l.data, topics: l.topics as never }) as { eventName: string; args: Record<string, unknown> };
    if (d.eventName === "SeriesListed") listed.push(`${l.address.slice(0, 8)} ${String(d.args.symbol ?? "")} m${d.args.month}`);
    if (d.eventName === "MarketRecorded") markets.push(1);
  } catch {}
}
// transactions of the rehearsal keys since `from`: count, gas limits, gas used
const spend: Record<string, { n: number; limit: bigint; used: bigint; reverted: number }> = {};
for (let b = from; b <= latest; b++) {
  const blk = await pub.getBlock({ blockNumber: b, includeTransactions: true });
  for (const t of blk.transactions) {
    const k = byAddr.get(t.from.toLowerCase());
    if (!k) continue;
    const rc = await pub.getTransactionReceipt({ hash: t.hash });
    const s = (spend[k] ??= { n: 0, limit: 0n, used: 0n, reverted: 0 });
    s.n++;
    s.limit += t.gas;
    s.used += rc.gasUsed;
    if (rc.status !== "success") s.reverted++;
  }
}
const hours = (now - Number((await pub.getBlock({ blockNumber: from })).timestamp)) / 3600;
const spendOut = Object.fromEntries(Object.entries(spend).map(([k, s]) => [k, { txs: s.n, reverted: s.reverted, gasLimit: s.limit.toString(), gasUsed: s.used.toString(), monAt102: (Number(s.limit) * 102e-9).toFixed(3), monPerHourAt102: ((Number(s.limit) * 102e-9) / hours).toFixed(3) }]));
console.log(JSON.stringify({ at: new Date(now * 1000).toISOString(), blocks: `${from}..${latest}`, hours: hours.toFixed(3), demoDayNow: Math.floor((now - rec.demo.epochTs) / 600) + rec.demo.firstDay, head, events: ev, postsByWriter: posts, closedDays: [...new Set(closed)], attestedDays: [...new Set(attested)], h100Days: days, listed, marketsRecorded: markets.length, spend: spendOut }, null, 1));
