// Step 4, the agent's half: buy 50 testUSD of spUP for the user, with no user present, using the grant the
// user's Mera session signed (SpikeMarket.approveAgent). The agent holds its own key and pays its own gas.
//
// env: AGENT_PRIVATE_KEY (required), USER_ADDRESS (or first argument), RPC_URL (default Monad testnet),
//      AGENT_BUY_AMOUNT (6-decimal units, default 50 testUSD)
// bun agent/run.ts --address      prints the agent address (put it in VITE_AGENT_ADDRESS)
// bun agent/run.ts 0xUser...      buys for that user
import { type Address, createPublicClient, createWalletClient, formatEther, formatUnits, type Hex, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defaultRpcUrl, flow, monadTestnet, txUrl } from "../app/src/core/chain";
import { agentBuy, readBalances } from "../app/src/core/flow";
import { GAS } from "../app/src/core/gas";

function fail(msg: string): never {
  console.error(`agent: ${msg}`);
  process.exit(1);
}

const key = process.env.AGENT_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) fail("AGENT_PRIVATE_KEY is missing or malformed (0x + 64 hex).");
const agent = privateKeyToAccount(key as Hex);
if (process.argv.includes("--address")) {
  console.log(agent.address);
  process.exit(0);
}

const user = (process.argv[2] ?? process.env.USER_ADDRESS) as Address | undefined;
if (!user || !isAddress(user)) fail("pass the user's address as the first argument or USER_ADDRESS.");
const amount = process.env.AGENT_BUY_AMOUNT ? BigInt(process.env.AGENT_BUY_AMOUNT) : flow.agentBuyAmount;
const rpcUrl = process.env.RPC_URL || defaultRpcUrl;
const chain = monadTestnet(rpcUrl);
const client = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ account: agent, chain, transport: http(rpcUrl) });

const before = await readBalances(client, user, agent.address);
const now = BigInt(Math.floor(Date.now() / 1000));
const usd = (v: bigint) => formatUnits(v, 6);
console.log(`agent ${agent.address} for user ${user}`);
console.log(`grant: ${usd(before.agentRemaining ?? 0n)} testUSD left, expires ${new Date(Number(before.agentExpiry ?? 0n) * 1000).toISOString()}`);
if ((before.agentExpiry ?? 0n) < now) fail("no live grant from this user (approveAgent not called or expired).");
if ((before.agentRemaining ?? 0n) < amount) fail(`grant has ${usd(before.agentRemaining ?? 0n)} left, below ${usd(amount)}.`);
if (before.marketAllowance < amount) fail("the user's testUSD allowance to the market is too low.");
if (before.usd < amount) fail("the user has too little testUSD.");
const agentMon = await client.getBalance({ address: agent.address });
const fees = await client.estimateFeesPerGas();
if (agentMon < GAS.buyUpFor * fees.maxFeePerGas) fail(`agent has ${formatEther(agentMon)} MON, too little for gas.`);

const sent = await agentBuy(wallet, client, user, amount);
const after = await readBalances(client, user, agent.address);
console.log(`bought ${usd(amount)} testUSD of spUP for the user: ${sent.hash}`);
console.log(`explorer: ${txUrl(sent.hash)}`);
console.log(`gas used ${sent.receipt.gasUsed} of declared ${sent.gasLimit} (Monad bills the declared limit), paid by the agent`);
console.log(`user spUP ${usd(before.up)} -> ${usd(after.up)}, grant left ${usd(after.agentRemaining ?? 0n)} testUSD`);
