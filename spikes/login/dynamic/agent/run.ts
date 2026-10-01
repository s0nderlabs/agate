// The agent buys spUP for the user with the session key the user granted in step 4, with the user absent.
// Usage (from spikes/login/dynamic): bun agent/run.ts [--amount 50] [--grant agent/grant.json]
// Needs: AGENT_SESSION_PRIVATE_KEY in .env.local (the operator creates this key themselves; its ADDRESS goes into
// VITE_AGENT_ADDRESS for the app), the grant file downloaded from the app, and ZeroDev RPCs in shared/ids.json.
// The user operation is sponsored by the ZeroDev paymaster, so the session key needs no MON.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Hex, createPublicClient, http, isHex, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, contracts, flow } from "../../shared/config";
import {
  type AgentGrant,
  type Ids,
  agentBuyCalls,
  agentSend,
  gasPayer,
  monadTestnet,
  testUsdAbi,
  zerodevRpcs,
} from "../lib/aa";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const fail = (msg: string): never => {
  console.error(`agent: ${msg}`);
  process.exit(1);
};

const here = import.meta.dir;
const idsPath = resolve(here, "../../shared/ids.json");
let ids: Ids = {};
try {
  ids = JSON.parse(readFileSync(idsPath, "utf8"));
} catch {
  fail(`cannot read ${idsPath}; the setup step writes it once the ZeroDev project exists`);
}
const rpcs = zerodevRpcs(ids);
if ("error" in rpcs) fail(rpcs.error);
const { bundler, paymaster } = rpcs as { bundler: string; paymaster: string };

const key = process.env.AGENT_SESSION_PRIVATE_KEY;
if (!key || !isHex(key) || key.length !== 66) fail("AGENT_SESSION_PRIVATE_KEY is missing or malformed (.env.local)");
const sessionKey = privateKeyToAccount(key as Hex);

const grantPath = resolve(arg("grant") ?? process.env.AGENT_GRANT_FILE ?? resolve(here, "grant.json"));
let grant: AgentGrant;
try {
  grant = JSON.parse(readFileSync(grantPath, "utf8"));
} catch {
  fail(`cannot read the grant at ${grantPath}; download it from step 4 of the app`);
}
grant = grant!;
if (grant.chainId !== chain.id) fail(`grant is for chain ${grant.chainId}, expected ${chain.id}`);
if (grant.agent.toLowerCase() !== sessionKey.address.toLowerCase())
  fail(`grant names agent ${grant.agent} but the session key is ${sessionKey.address}`);
if (Date.now() / 1000 > grant.validUntil) fail(`grant expired at ${new Date(grant.validUntil * 1000).toISOString()}`);

const amount = arg("amount") ? parseUnits(arg("amount")!, 6) : flow.agentBuyAmount;
const publicClient = createPublicClient({ chain: monadTestnet, transport: http(process.env.MONAD_RPC_URL ?? chain.rpcUrl) });
const spUp = () =>
  publicClient.readContract({ address: contracts.spUp, abi: testUsdAbi, functionName: "balanceOf", args: [grant.userAccount] });

console.log(`agent ${sessionKey.address} buying ${Number(amount) / 1e6} testUSD of spUP for ${grant.userAccount} (${grant.mode} mode)`);
const before = await spUp();
const t0 = performance.now();
const receipt = await agentSend({
  publicClient,
  bundlerTransport: http(bundler),
  paymasterTransport: http(paymaster),
  sessionKey,
  approval: grant.approval,
  calls: agentBuyCalls(grant.mode, amount),
});
const ms = Math.round(performance.now() - t0);
const g = gasPayer(receipt);
console.log(
  JSON.stringify(
    {
      success: receipt.success,
      userOpHash: receipt.userOpHash,
      tx: receipt.receipt.transactionHash,
      explorer: `${chain.explorer}/tx/${receipt.receipt.transactionHash}`,
      gasPaidBy: g.payer,
      bundler: g.bundler,
      spUpDelta: Number((await spUp()) - before) / 1e6,
      ms,
    },
    null,
    2,
  ),
);
if (!receipt.success) process.exit(2);
