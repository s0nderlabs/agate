// The agent: buys 50 testUSD of spUP for the user, from the user's own Privy wallet, with the user away.
// It signs as the server signer the user added in step 4, so Privy evaluates the agent policy
// (buyUp only, <= 200, before expiry) in its enclave before signing. Gas is sponsored.
//
//   bun run agent --user 0xUserAddress [--wallet-id <privy wallet id>] [--amount 50] [--dry-run]
//
// Needs PRIVY_APP_SECRET and PRIVY_AUTHORIZATION_PRIVATE_KEY in agent/.env.local (except --dry-run).
// AGENT_RPC_URL overrides the read RPC (for example an anvil fork) for the pre and post checks.
import { PrivyClient } from "@privy-io/node";
import { createPublicClient, decodeEventLog, getAddress, http, parseUnits, type Address, type Hex } from "viem";
import { abis, chain, contracts, flow } from "../../shared/config";
import { agentBuyCall, caip2, explorerTx, marketAbi, spUpAbi, testUsdAbi } from "../app/src/calls";
import { appId, arg, fail, flag, savedPolicy, secret } from "./env";

const userArg = arg("user");
if (!userArg) fail("pass --user 0x... (the address shown on the web app after sign in)");
const user = getAddress(userArg!) as Address;
const amount = arg("amount") ? parseUnits(arg("amount")!, 6) : flow.agentBuyAmount;
const dryRun = flag("dry-run");

const rpcUrl = process.env.AGENT_RPC_URL || chain.rpcUrl;
const pub = createPublicClient({ transport: http(rpcUrl) });

const [budget, usdBal, upBefore] = (await Promise.all([
  pub.readContract({ address: contracts.testUsd, abi: testUsdAbi, functionName: "allowance", args: [user, contracts.market] }),
  pub.readContract({ address: contracts.testUsd, abi: testUsdAbi, functionName: "balanceOf", args: [user] }),
  pub.readContract({ address: contracts.spUp, abi: spUpAbi, functionName: "balanceOf", args: [user] }),
])) as [bigint, bigint, bigint];
console.log(`user ${user}: testUSD ${fmt(usdBal)}, spUP ${fmt(upBefore)}, agent budget left ${fmt(budget)}`);
if (budget < amount) fail(`agent budget ${fmt(budget)} is below ${fmt(amount)}: the user has not granted step 4, or it is used up`);
if (usdBal < amount) fail(`user holds ${fmt(usdBal)} testUSD, below ${fmt(amount)}`);

const policy = savedPolicy();
if (policy.expiry && policy.expiry * 1000 < Date.now()) console.warn("warning: policy.json says the policy window has passed; Privy should refuse");

const call = agentBuyCall(amount);
const request = {
  caip2,
  params: { transaction: { to: call.to, data: call.data, chain_id: chain.id } },
  sponsor: true,
};

if (dryRun) {
  console.log("dry run, request that would be sent to Privy (wallet RPC eth_sendTransaction):");
  console.log(JSON.stringify(request, null, 2));
  process.exit(0);
}

const privy = new PrivyClient({ appId: appId(), appSecret: secret("PRIVY_APP_SECRET") });
const authKey = secret("PRIVY_AUTHORIZATION_PRIVATE_KEY");

let walletId = arg("wallet-id");
if (!walletId) {
  for await (const w of privy.wallets().list({ address: user, chain_type: "ethereum" })) {
    walletId = w.id;
    break;
  }
}
if (!walletId) fail(`no Privy wallet found for ${user} in this app; pass --wallet-id from the web app`);

const t0 = Date.now();
let res;
try {
  res = await privy.wallets().ethereum().sendTransaction(walletId!, {
    ...request,
    authorization_context: { authorization_private_keys: [authKey] },
  });
} catch (e) {
  const err = e as { status?: number; message?: string };
  fail(`Privy refused the send (${err.status ?? "?"}): ${err.message ?? String(e)}. A 4xx here usually means the signer is not on the wallet or the policy denied it.`);
}
let hash = res!.hash;
console.log(`Privy accepted in ${Date.now() - t0} ms${res!.transaction_id ? `, transaction_id ${res!.transaction_id}` : ""}`);

// Sponsored sends can come back with an empty hash and a transaction id to poll.
if (!hash && res!.transaction_id) {
  const deadline = Date.now() + 90_000;
  while (!hash && Date.now() < deadline) {
    await Bun.sleep(1500);
    const tx = await privy.transactions().get(res!.transaction_id);
    if (tx.transaction_hash) hash = tx.transaction_hash;
    else if (["failed", "execution_reverted", "provider_error"].includes(tx.status)) fail(`Privy transaction ${tx.status}`);
  }
}
if (!hash) fail("no transaction hash after 90 s");

const receipt = await pub.waitForTransactionReceipt({ hash: hash as Hex, timeout: 90_000 });
const payer = receipt.from.toLowerCase() === user.toLowerCase() ? "user" : `sponsor (${receipt.from})`;
const bought = receipt.logs
  .filter((l) => l.address.toLowerCase() === contracts.market.toLowerCase())
  .map((l) => {
    try {
      return decodeEventLog({ abi: abis.market as typeof marketAbi, data: l.data, topics: l.topics });
    } catch {
      return null;
    }
  })
  .find((e) => e?.eventName === "Bought");
const upAfter = (await pub.readContract({ address: contracts.spUp, abi: spUpAbi, functionName: "balanceOf", args: [user] })) as bigint;
console.log(`status ${receipt.status}, block ${receipt.blockNumber}, gas paid by ${payer}`);
console.log(`Bought event: ${bought ? "yes" : "no"}, spUP ${fmt(upBefore)} -> ${fmt(upAfter)}, total ${Date.now() - t0} ms`);
console.log(explorerTx(hash));

function fmt(v: bigint) {
  return (Number(v) / 1e6).toLocaleString();
}
