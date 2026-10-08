// Sends a little testnet MON from the agate deployer (Keychain agate.deployer, read in-process, never printed) to one
// of agate's own wallets. Refuses more than 1 MON.
// bun run scripts/fund.ts <address> <mon>
import { rpcTransport, rpcUrlsOf } from "@agate/client";
import { createPublicClient, createWalletClient, defineChain, type Hex, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../src/config.ts";

const [to, mon = "0.1"] = process.argv.slice(2);
if (!to || !isAddress(to)) throw new Error("usage: fund.ts <address> <mon>");
const value = parseEther(mon);
if (value > parseEther("1")) throw new Error("refusing more than 1 MON");
const r = Bun.spawnSync(["security", "find-generic-password", "-s", "agate.deployer", "-w"]);
if (r.exitCode !== 0) throw new Error("Keychain item agate.deployer not found");
const raw = r.stdout.toString().trim();
const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
const chain = defineChain({ id: config.chainId, name: "Monad Testnet", nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: rpcUrlsOf(config.rpcUrl) } } });
const wc = createWalletClient({ account, chain, transport: rpcTransport(config.rpcUrl) });
const pc = createPublicClient({ chain, transport: rpcTransport(config.rpcUrl) });
const hash = await wc.sendTransaction({ to, value });
const rc = await pc.waitForTransactionReceipt({ hash, timeout: 60_000 });
console.log(JSON.stringify({ from: account.address, to, mon, hash, status: rc.status }));
process.exit(0);
