// End-to-end check of the Mera spike's exact call sequence on an anvil fork of Monad testnet.
// Only anvil's public dev accounts sign: #0 funds the drip, #1 is the user (its key wrapped in a real Mera
// signing session, exactly as the app wraps the passkey-derived key), #2 is the agent. Nothing touches the
// public testnet except anvil's fork reads.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecp256k1SigningSession, getEvmAddress } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  hexToBytes,
  http,
  parseEther,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { abis, contracts, flow, monadTestnet, testUsdPermitDomain } from "../app/src/core/chain";
import { prfOutputToEvmPrivateKey } from "../app/src/core/derive";
import { claimTestUsd, feeOf, goLong, grantAgent, readBalances, type Signer } from "../app/src/core/flow";
import { GAS } from "../app/src/core/gas";
import { defaultScope, ScopeError, scopeAccount } from "../app/src/core/scope";

const KEYS = {
  drip: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  user: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const;
const PORT = Number(process.env.FORK_PORT || 8549);
const DRIP_PORT = 5199;
const rpc = `http://127.0.0.1:${PORT}`;
const chain = monadTestnet(rpc);
const root = join(import.meta.dir, "..");

let anvil: ReturnType<typeof Bun.spawn> | undefined;
let drip: ReturnType<typeof Bun.spawn> | undefined;
let client: PublicClient;

async function waitFor(fn: () => Promise<unknown>, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > end) throw e;
      await Bun.sleep(500);
    }
  }
}

beforeAll(async () => {
  anvil = Bun.spawn(["anvil", "--fork-url", "https://testnet-rpc.monad.xyz", "--chain-id", "10143", "--port", String(PORT), "--silent"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  client = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  await waitFor(() => client.getChainId());
  // On real Monad testnet every anvil dev account carries an EIP-7702 delegation (0xef0100 6bd9...7606, a
  // sweeper) that forwards any MON it receives. Clear it on the fork so the dev accounts behave as plain EOAs.
  const testClient = createTestClient({ mode: "anvil", chain, transport: http(rpc) });
  for (const k of Object.values(KEYS)) await testClient.setCode({ address: privateKeyToAccount(k).address, bytecode: "0x" });
  drip = Bun.spawn(["bun", "drip/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      DRIP_PRIVATE_KEY: KEYS.drip,
      DRIP_RPC_URL: rpc,
      DRIP_PORT: String(DRIP_PORT),
      DRIP_STATE_FILE: join(mkdtempSync(join(tmpdir(), "mera-drip-")), "dripped.json"),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitFor(() => fetch(`http://127.0.0.1:${DRIP_PORT}/health`).then((r) => r.json()));
}, 90_000);

afterAll(() => {
  drip?.kill();
  anvil?.kill();
});

describe("derivation (no chain)", () => {
  test("PRF output -> same EOA as a standard BIP-39 wallet, and Mera's session agrees", () => {
    const prf = new Uint8Array(32).fill(7);
    const expected = mnemonicToAccount(entropyToMnemonic(prf, wordlist)).address;
    const key = prfOutputToEvmPrivateKey(prf.slice());
    const session = createSecp256k1SigningSession({ privateKey: key });
    expect(getEvmAddress(session.publicKey).toLowerCase()).toBe(expected.toLowerCase());
    session.end();
  });
});

describe("Mera flow on the fork", () => {
  const user = privateKeyToAccount(KEYS.user).address;
  const agent = privateKeyToAccount(KEYS.agent);
  const session = createSecp256k1SigningSession({ privateKey: hexToBytes(KEYS.user) });
  const scope = defaultScope();
  const state = { spent: 0n, signatures: 0 };
  const signer = () =>
    createWalletClient({ account: scopeAccount(toViemAccount(session), scope, state), chain, transport: http(rpc) }) as Signer;
  const fees: bigint[] = [];

  test("contracts and permit domain match the deployment", async () => {
    const domain = (await client.readContract({
      address: contracts.testUsd as Address,
      abi: [{ type: "function", name: "eip712Domain", stateMutability: "view", inputs: [], outputs: [
        { type: "bytes1" }, { type: "string" }, { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256[]" } ] }],
      functionName: "eip712Domain",
    })) as readonly unknown[];
    expect(domain[1]).toBe(testUsdPermitDomain.name);
    expect(domain[2]).toBe(testUsdPermitDomain.version);
    expect(Number(domain[3])).toBe(10143);
  });

  test("step 1b: drip sends 0.2 MON once to a zero-balance address", async () => {
    const test = createTestClient({ mode: "anvil", chain, transport: http(rpc) });
    await test.setBalance({ address: user, value: 0n });
    const r1 = await fetch(`http://127.0.0.1:${DRIP_PORT}/drip`, { method: "POST", body: JSON.stringify({ address: user }) }).then((r) => r.json());
    expect(r1.hash).toMatch(/^0x/);
    expect(await client.getBalance({ address: user })).toBe(parseEther("0.2"));
    const r2 = await fetch(`http://127.0.0.1:${DRIP_PORT}/drip`, { method: "POST", body: JSON.stringify({ address: user }) }).then((r) => r.json());
    expect(r2.skipped).toBe(true);
    const bad = await fetch(`http://127.0.0.1:${DRIP_PORT}/drip`, { method: "POST", body: JSON.stringify({ address: "nope" }) });
    expect(bad.status).toBe(400);
  }, 30_000);

  test("step 2: faucet from the Mera session, gas from the drip", async () => {
    const before = await readBalances(client, user);
    const sent = await claimTestUsd(signer(), client);
    fees.push(feeOf(sent.receipt, sent.gasLimit));
    const after = await readBalances(client, user);
    expect(after.usd - before.usd).toBe(flow.faucetAmount);
    expect(sent.receipt.from.toLowerCase()).toBe(user.toLowerCase());
    expect(sent.receipt.gasUsed <= GAS.faucet).toBe(true);
  }, 30_000);

  test("step 3: Go Long = one permit signature + one buyUpWithPermit transaction", async () => {
    const before = await readBalances(client, user);
    const startNonce = await client.getTransactionCount({ address: user });
    const sent = await goLong(signer(), client);
    fees.push(feeOf(sent.receipt, sent.gasLimit));
    const after = await readBalances(client, user);
    expect(after.up - before.up).toBe(flow.buyAmount);
    expect(before.usd - after.usd).toBe(flow.buyAmount);
    expect((await client.getTransactionCount({ address: user })) - startNonce).toBe(1);
    expect(sent.receipt.gasUsed <= GAS.buyUpWithPermit).toBe(true);
  }, 30_000);

  test("step 4: approve + approveAgent from the session, then agent/run.ts buys 50 with no user", async () => {
    const { approve, grant, expiry } = await grantAgent(signer(), client, agent.address);
    fees.push(feeOf(approve.receipt, approve.gasLimit), feeOf(grant.receipt, grant.gasLimit));
    const mid = await readBalances(client, user, agent.address);
    expect(mid.agentRemaining).toBe(flow.agentCap);
    expect(mid.agentExpiry).toBe(expiry);
    expect(mid.marketAllowance).toBe(flow.agentCap);

    // agent pays its own gas; anvil #2 is pre-funded on the fork
    const proc = Bun.spawn(["bun", "agent/run.ts", user], {
      cwd: root,
      env: { ...process.env, AGENT_PRIVATE_KEY: KEYS.agent, RPC_URL: rpc },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    console.log(out.trim());
    expect(err).toBe("");
    expect(code).toBe(0);
    const after = await readBalances(client, user, agent.address);
    expect(after.up - mid.up).toBe(flow.agentBuyAmount);
    expect(after.agentRemaining).toBe(flow.agentCap - flow.agentBuyAmount);
  }, 60_000);

  test("agent cannot exceed the grant", async () => {
    const data = encodeFunctionData({ abi: abis.market, functionName: "buyUpFor", args: [user, flow.agentCap] });
    await expect(client.call({ account: agent.address, to: contracts.market as Address, data })).rejects.toThrow();
  });

  test("0.2 MON covers all four user transactions at declared gas", async () => {
    const spent = fees.reduce((a, b) => a + b, 0n);
    const left = await client.getBalance({ address: user });
    console.log(`user paid ${Number(spent) / 1e18} MON for ${fees.length} txs (declared gas x price), ${Number(left) / 1e18} MON left`);
    expect(left > 0n).toBe(true);
    expect(state.signatures).toBe(5); // faucet, permit, buy, approve, approveAgent: 0 passkey prompts
  });

  test("the scoped session refuses anything outside its scope", async () => {
    const w = signer();
    const transfer = encodeFunctionData({ abi: abis.testUsd, functionName: "transfer", args: [agent.address, 1n] });
    await expect(w.sendTransaction({ to: contracts.testUsd as Address, data: transfer, gas: 80_000n })).rejects.toThrow(/not in scope/);
    await expect(w.sendTransaction({ to: agent.address, value: 1n, gas: 21_000n })).rejects.toThrow(/not in scope/);
    await expect(w.signMessage({ message: "hi" })).rejects.toThrow(ScopeError);
    await expect(goLong(w, client, 5_000_000_000n)).rejects.toThrow(/cap/);
    const expired = createWalletClient({
      account: scopeAccount(toViemAccount(session), { ...scope, expiresAt: Date.now() - 1 }),
      chain,
      transport: http(rpc),
    }) as Signer;
    await expect(claimTestUsd(expired, client)).rejects.toThrow(/expired/);
  }, 30_000);

  test("ending the Mera session zeroes the key: signing fails after end()", async () => {
    session.end();
    await expect(claimTestUsd(signer(), client)).rejects.toThrow();
  });
});
