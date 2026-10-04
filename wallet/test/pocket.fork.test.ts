// The pocket's onchain limits, against an anvil fork of Monad testnet (the real agate router, test dollar and Kuru
// books, the real ZeroDev Kernel and policy contracts). Fresh random keys stand in for the user's main wallet and the
// Assistant; a mini bundler calls EntryPoint.handleOps. Nothing touches the public testnet.
// Runs only with FORK=1 (it starts anvil through wall/scripts/anvil-safe.sh): FORK=1 bun test test/pocket.fork.test.ts
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { type Address, createPublicClient, encodeFunctionData, type Hex, hashMessage, http, type PublicClient, parseAbi, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { abi } from "@agate/client";
import { AGATE, accountClient, checkApproval, createPocketPermission, kernelAccount, monadTestnet, pocketSessionAccount, type PocketLimits, type PocketTerms, sendCalls, type Call } from "../src/index.ts";
import { miniBundler } from "./miniBundler.ts";

setDefaultTimeout(300_000);
const RUN = process.env.FORK === "1";
const PORT = Number(process.env.FORK_PORT ?? 18574);
const FORK = `http://127.0.0.1:${PORT}`;
const NOPERMIT = { value: 0n, deadline: 0n, v: 0, r: `0x${"00".repeat(32)}` as Hex, s: `0x${"00".repeat(32)}` as Hex };
const EVIL = "0x000000000000000000000000000000000000dEaD" as Address;

const main = privateKeyToAccount(generatePrivateKey());
const assistant = privateKeyToAccount(generatePrivateKey());
const executor = privateKeyToAccount(generatePrivateKey());

let anvil: Subprocess | undefined;
let pc: PublicClient;
let series: Address;
let mainAddr: Address;
let pocket: Address;
let approval: string;
let terms: PocketTerms;

const rpc = (method: string, params: unknown[]) =>
  fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json() as Promise<{ result?: unknown; error?: unknown }>);
const bundler = miniBundler(FORK, executor);
const sponsor = { bundler: bundler.transport };

const approveCall = (to: Address, spender: Address, amt: bigint): Call => ({ to, value: 0n, data: encodeFunctionData({ abi: abi.agateDollarAbi, functionName: "approve", args: [spender, amt] }) });
const openLong = (dollars: bigint): Call => ({ to: AGATE.router, value: 0n, data: encodeFunctionData({ abi: abi.agateRouterAbi, functionName: "openLong", args: [series, dollars, 1n, NOPERMIT] }) });
const openLongDaily = (dollars: bigint, payee: Address): Call => ({ to: AGATE.router, value: 0n, data: encodeFunctionData({ abi: abi.agateRouterAbi, functionName: "openLongDaily", args: [series, dollars, 1n, 1n, payee, NOPERMIT] }) });
const drip: Call = { to: AGATE.dollar, value: 0n, data: encodeFunctionData({ abi: abi.agateDollarAbi, functionName: "drip", args: [] }) };
const transfer = (to: Address, amt: bigint): Call => ({ to: AGATE.dollar, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [to, amt] }) });
const balance = (who: Address) => pc.readContract({ address: AGATE.dollar, abi: abi.agateDollarAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

async function asAi(calls: Call[]) {
  const acct = await pocketSessionAccount(pc, approval, assistant);
  return sendCalls(accountClient(acct, pc, sponsor), calls);
}
/** true when the EntryPoint refused the operation at validation (the session key's limits said no) */
async function refused(calls: Call[]): Promise<boolean> {
  try {
    await asAi(calls);
    return false;
  } catch {
    return true;
  }
}

describe.if(RUN)("pocket on a Monad testnet fork", () => {
  beforeAll(async () => {
    anvil = spawn([join(import.meta.dir, "../../wall/scripts/anvil-safe.sh"), "--fork-url", "https://testnet-rpc.monad.xyz", "--chain-id", "10143", "--port", String(PORT), "--silent"], { stdout: "ignore", stderr: "inherit" });
    for (let i = 0; i < 120; i++) {
      try {
        if ((await rpc("eth_chainId", [])).result === "0x279f") break;
      } catch {}
      await Bun.sleep(500);
    }
    pc = createPublicClient({ chain: monadTestnet, transport: http(FORK) }) as PublicClient;
    // No series is listed on either factory today, so the trades target a non-series address: the session key's
    // validation is what is measured (accepted = the EntryPoint ran it, whatever the router then said; refused = the
    // EntryPoint rejected the signature). Real fills are checked live once a month is listed.
    series = AGATE.factory;
    mainAddr = (await kernelAccount(pc, main)).address;
    const limits: PocketLimits = { routers: [AGATE.router], dollar: AGATE.dollar, mainAccount: mainAddr, perTradeCap: 20_000_000n, shortTokensCap: 2_000_000n };
    const now = Number((await pc.getBlock()).timestamp);
    terms = { assistant: assistant.address, limits, validUntil: now + 7 * 86_400, tradesPerDay: 3 };
    ({ pocket, approval } = await createPocketPermission(pc, main, terms));
    for (const a of [executor.address, pocket, mainAddr]) await rpc("anvil_setBalance", [a, toHex(10n ** 20n)]);
  });
  afterAll(() => anvil?.kill());

  test("the approval is for this pocket, with exactly the agreed limits", async () => {
    expect(await checkApproval(pc, approval, main.address, terms)).toEqual([]);
    const tampered = await checkApproval(pc, approval, main.address, { ...terms, limits: { ...terms.limits, perTradeCap: 99_000_000n } });
    expect(tampered.join(" ")).toContain("limits differ");
  });

  test("a key other than the Assistant cannot use the approval (the enable signature binds the signer)", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const acct = await pocketSessionAccount(pc, approval, stranger);
    let ok = true;
    try {
      await sendCalls(accountClient(acct, pc, sponsor), [drip]);
    } catch {
      ok = false;
    }
    expect(ok).toBe(false);
  });

  test("trade 1: the first AI operation installs the key and takes test dollars (drip)", async () => {
    const r = await asAi([drip]);
    expect(r.success).toBe(true);
    expect(await balance(pocket)).toBeGreaterThan(0n);
  });

  test("trade 2: approve the router + open a long under the cap is accepted by the key", async () => {
    const r = await asAi([approveCall(AGATE.dollar, AGATE.router, 10_000_000n), openLong(10_000_000n)]);
    expect(r.userOpHash).toBeTruthy(); // validated and executed; the router itself reverts NotSeries on this fork
  });

  test("refused onchain: over the cap, a payee other than the main account, transfers, other approvals", async () => {
    expect(await refused([approveCall(AGATE.dollar, AGATE.router, 25_000_000n), openLong(25_000_000n)])).toBe(true);
    expect(await refused([approveCall(AGATE.dollar, AGATE.router, 5_000_000n), openLongDaily(5_000_000n, EVIL)])).toBe(true);
    expect(await refused([transfer(EVIL, 1_000_000n)])).toBe(true);
    expect(await refused([approveCall(AGATE.dollar, EVIL, 1_000_000n)])).toBe(true);
  });

  test("trade 3 (daily long paying the main account) passes; a 4th the same day is refused; the next day it passes", async () => {
    const r = await asAi([approveCall(AGATE.dollar, AGATE.router, 5_000_000n), openLongDaily(5_000_000n, mainAddr)]);
    expect(r.userOpHash).toBeTruthy();
    expect(await refused([drip])).toBe(true);
    await rpc("evm_increaseTime", [86_400 + 60]);
    await rpc("evm_mine", []);
    const again = await asAi([approveCall(AGATE.dollar, AGATE.router, 1_000_000n), openLong(1_000_000n)]);
    expect(again.userOpHash).toBeTruthy();
  });

  test("the key cannot sign for the pocket as a contract wallet (ERC-1271); the main wallet can", async () => {
    const isValid = (sig: Hex) =>
      pc.readContract({ address: pocket, abi: parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]), functionName: "isValidSignature", args: [hashMessage("permit anything"), sig] }) as Promise<Hex>;
    const ai = await pocketSessionAccount(pc, approval, assistant);
    const aiSig = await ai.signMessage({ message: "permit anything" });
    expect(aiSig.length).toBeGreaterThan(2);
    const aiAnswer = await isValid(aiSig).catch(() => "0xreverted" as Hex);
    expect(aiAnswer).not.toBe("0x1626ba7e");
    const owner = await kernelAccount(pc, main, terms.index ?? 1n);
    expect(await isValid(await owner.signMessage({ message: "permit anything" }))).toBe("0x1626ba7e");
  });

  test("the main wallet still owns the pocket: it can take the money back", async () => {
    const owner = await kernelAccount(pc, main, terms.index ?? 1n);
    expect(owner.address.toLowerCase()).toBe(pocket.toLowerCase());
    const left = await balance(pocket);
    const r = await sendCalls(accountClient(owner, pc, sponsor), [transfer(mainAddr, left)]);
    expect(r.success).toBe(true);
    expect(await balance(pocket)).toBe(0n);
  });
});
