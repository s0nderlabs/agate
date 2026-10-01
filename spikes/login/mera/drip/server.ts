// Tiny MON drip for the Mera spike. Mera accounts are plain EOAs with no gas sponsorship, so a new address
// gets 0.2 MON once, sent from DRIP_PRIVATE_KEY (read from env at run time, never logged or stored).
//
// env: DRIP_PRIVATE_KEY (required), DRIP_RPC_URL (default Monad testnet), DRIP_PORT (default 5181),
//      DRIP_AMOUNT_MON (default 0.2), DRIP_MAX_COUNT (default 50), DRIP_STATE_FILE (default drip/.dripped.json)
// API:  POST /drip {"address":"0x..."} -> {hash, from, amount} | {skipped, reason}
//       GET  /health -> {from, balance, chainId, dripped}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, formatEther, getAddress, type Hex, http, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defaultRpcUrl, monadTestnet } from "../app/src/core/chain";
import { GAS } from "../app/src/core/gas";

const key = process.env.DRIP_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("DRIP_PRIVATE_KEY is missing or malformed (0x + 64 hex). Set it in the shell or mera/.env.local.");
  process.exit(1);
}
const rpcUrl = process.env.DRIP_RPC_URL || defaultRpcUrl;
const port = Number(process.env.DRIP_PORT || 5181);
const amount = parseEther(process.env.DRIP_AMOUNT_MON || "0.2");
const maxCount = Number(process.env.DRIP_MAX_COUNT || 50);
const stateFile = process.env.DRIP_STATE_FILE || join(import.meta.dir, ".dripped.json");

const account = privateKeyToAccount(key as Hex);
const chain = monadTestnet(rpcUrl);
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

type Record = { hash: string; at: string };
let dripped: { [address: string]: Record } = {};
try {
  if (existsSync(stateFile)) dripped = JSON.parse(readFileSync(stateFile, "utf8"));
} catch {
  dripped = {};
}

// One send at a time so nonces never collide.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "http://localhost:5171" },
  });

async function drip(raw: unknown) {
  if (typeof raw !== "string" || !isAddress(raw)) return json({ error: "address must be a 0x address" }, 400);
  const to = getAddress(raw);
  return serial(async () => {
    const prior = dripped[to.toLowerCase()];
    if (prior) return json({ skipped: true, reason: "already dripped once", hash: prior.hash });
    if (Object.keys(dripped).length >= maxCount) return json({ error: "drip limit reached" }, 429);
    const balance = await client.getBalance({ address: to });
    if (balance >= amount / 2n) return json({ skipped: true, reason: `already has ${formatEther(balance)} MON` });
    const hash = await wallet.sendTransaction({ to, value: amount, gas: GAS.dripTransfer });
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 400 });
    if (receipt.status !== "success") return json({ error: "drip reverted", hash }, 502);
    dripped[to.toLowerCase()] = { hash, at: new Date().toISOString() };
    try {
      writeFileSync(stateFile, JSON.stringify(dripped, null, 2));
    } catch (e) {
      console.error("could not persist drip state:", (e as Error).message);
    }
    console.log(`dripped ${formatEther(amount)} MON to ${to}: ${hash}`);
    return json({ hash, from: account.address, amount: formatEther(amount) });
  });
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "http://localhost:5171",
          "access-control-allow-methods": "POST, GET",
          "access-control-allow-headers": "content-type",
        },
      });
    try {
      if (url.pathname === "/drip" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { address?: unknown };
        return await drip(body.address);
      }
      if (url.pathname === "/health") {
        const [balance, chainId] = await Promise.all([client.getBalance({ address: account.address }), client.getChainId()]);
        return json({ from: account.address, balance: formatEther(balance), chainId, dripped: Object.keys(dripped).length });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: (e as Error).message.split("\n")[0] }, 500);
    }
  },
});

console.log(`drip listening on http://127.0.0.1:${server.port} from ${account.address} via ${rpcUrl}`);
