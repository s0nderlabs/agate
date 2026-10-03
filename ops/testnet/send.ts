// The kit's send helper: plain MON transfers, or one contract call, from one address.
//
//   bun run ops/testnet/send.ts transfers <address>=<MON>[,<address>=<MON>...] --rpc <url> --from <address> (--key-env <VAR> | --unlocked)
//   bun run ops/testnet/send.ts call <address> '<function signature>' '<JSON array of args>' --rpc <url> --from <address> (--key-env <VAR> | --unlocked)
//
// --key-env VAR: the signing key is in the environment variable VAR (put there by the operator's shell, read from the
// Keychain for this one command). It is taken out of the environment at once, must be a 0x-prefixed 32-byte hex key
// whose address is --from, and is never printed, logged or written. Anything wrong stops the run before a send.
// --unlocked: eth_sendTransaction as --from, for a local anvil fork only (loopback URL, anvil_nodeInfo answers).
// Monad bills the gas limit: a transfer is sent with exactly 21,000; a call with 1.3 x eth_estimateGas (forge's own
// default margin). Fees: the node's suggestion, capped by AGATE_MAX_FEE_GWEI (default 200). One send at a time,
// each waited for; a reverted receipt stops the run.
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  type Hex,
  http,
  parseAbiItem,
  parseEther,
} from "../../wall/packages/report/node_modules/viem";
import { privateKeyToAccount } from "../../wall/packages/report/node_modules/viem/accounts";

function fail(msg: string): never {
  console.error(`stopped: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value`);
  argv.splice(i, 2);
  return v;
}
function bool(name: string): boolean {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

const rpc = flag("rpc") ?? fail("--rpc is required");
const from = (flag("from") ?? fail("--from is required")) as Address;
const keyEnv = flag("key-env");
const unlocked = bool("unlocked");
const [cmd, ...rest] = argv;
if (!/^0x[0-9a-fA-F]{40}$/.test(from)) fail("--from is not an address");
if (Boolean(keyEnv) === unlocked) fail("give exactly one of --key-env <VAR> and --unlocked");

// the key first, out of the environment, before anything else can see or print it
let key: Hex | undefined;
if (keyEnv) {
  const v = process.env[keyEnv];
  delete process.env[keyEnv];
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) fail(`${keyEnv} is missing or is not a 0x-prefixed 32-byte hex key (nothing sent)`);
  key = v as Hex;
}

const loopback = /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(rpc);
if (unlocked && !loopback) fail("--unlocked is for a local fork only (http://127.0.0.1:<port>)");

const transport = http(rpc, { timeout: 30_000, retryCount: 2 });
const pub = createPublicClient({ transport });
const chainId = await pub.getChainId();
if (chainId !== 10143) fail(`the RPC answers chain ${chainId}, not 10143`);
if (unlocked) {
  try {
    await pub.request({ method: "anvil_nodeInfo" as never, params: [] as never });
  } catch {
    fail("the RPC is not an anvil node: --unlocked refused");
  }
}
const chain = defineChain({ id: 10143, name: "monad-testnet", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const account = key ? privateKeyToAccount(key) : undefined;
key = undefined;
if (account && account.address.toLowerCase() !== from.toLowerCase()) fail(`the key in ${keyEnv} is not the key of ${from} (nothing sent)`);
const wallet = account ? createWalletClient({ account, chain, transport }) : undefined;

const maxFeeCap = BigInt(Math.round(Number(process.env.AGATE_MAX_FEE_GWEI ?? 200) * 1e9));
async function fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const f = await pub.estimateFeesPerGas();
  const maxFeePerGas = f.maxFeePerGas > maxFeeCap ? maxFeeCap : f.maxFeePerGas;
  const tip = f.maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : f.maxPriorityFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas: tip };
}

async function send(to: Address, value: bigint, data: Hex | undefined, gas: bigint, what: string): Promise<void> {
  const f = await fees();
  let hash: Hex;
  if (wallet) {
    hash = await wallet.sendTransaction({ account: account!, chain, to, value, data, gas, ...f });
  } else {
    const tx: Record<string, string> = { from, to, value: `0x${value.toString(16)}`, gas: `0x${gas.toString(16)}` };
    if (data) tx.data = data;
    hash = (await pub.request({ method: "eth_sendTransaction" as never, params: [tx] as never })) as Hex;
  }
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 1_000 });
  const billed = gas * rc.effectiveGasPrice;
  console.log(JSON.stringify({ sent: what, hash, status: rc.status, block: Number(rc.blockNumber), gasLimit: Number(gas), gasUsed: Number(rc.gasUsed), effectiveGwei: Number(rc.effectiveGasPrice) / 1e9, billedMon: formatEther(billed) }));
  if (rc.status !== "success") fail(`${what} reverted (${hash})`);
}

if (cmd === "transfers") {
  const list = (rest[0] ?? fail("transfers needs <address>=<MON>[,...]")).split(",").filter(Boolean);
  const plan = list.map((x) => {
    const [to, amt] = x.split("=");
    if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) fail(`not an address: ${to}`);
    if (!amt || !/^\d+(\.\d{1,18})?$/.test(amt) || parseEther(amt) === 0n) fail(`not a MON amount: ${amt}`);
    if (to.toLowerCase() === from.toLowerCase()) fail("a transfer to the sender itself");
    return { to: to as Address, value: parseEther(amt) };
  });
  const total = plan.reduce((s, p) => s + p.value, 0n);
  const bal = await pub.getBalance({ address: from });
  const f = await fees();
  const fee = 21_000n * f.maxFeePerGas * BigInt(plan.length);
  if (bal < total + fee) fail(`${from} holds ${formatEther(bal)} MON, the plan needs ${formatEther(total + fee)} with fees (nothing sent)`);
  for (const p of plan) await send(p.to, p.value, undefined, 21_000n, `transfer ${formatEther(p.value)} MON to ${p.to}`);
  console.log(JSON.stringify({ done: plan.length, from, balanceAfter: formatEther(await pub.getBalance({ address: from })) }));
} else if (cmd === "call") {
  const [to, sig, args] = rest;
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) fail("call needs a contract address");
  if (!sig || !args) fail("call needs '<function signature>' '<JSON array of args>'");
  const item = parseAbiItem(`function ${sig.replace(/^function\s+/, "")}`) as never;
  const data = encodeFunctionData({ abi: [item], args: JSON.parse(args) as never[] } as never);
  const est = await pub.estimateGas({ account: from, to: to as Address, data });
  await send(to as Address, 0n, data, (est * 13n + 9n) / 10n, `call ${sig.split("(")[0]} on ${to}`);
} else {
  fail("usage: send.ts transfers <address>=<MON>[,...] | call <address> '<signature>' '<JSON args>' (--rpc, --from, --key-env or --unlocked)");
}
