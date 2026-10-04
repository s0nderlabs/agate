// The testnet mode's gates (e2e/testnet.ts), on a fake chain that answers the reads and records every send: each
// refuses before anything is sent. No network, no key of anyone's: a throwaway key derived from a label.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { custom, encodeFunctionResult, type Hex, keccak256, parseAbi, toFunctionSelector, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountFromCommand, Budget, GateError, type MarketView, parseTestnetArgs, planSpend, preflight, runTestnet, staticRoles, type TestnetOptions } from "../e2e/testnet.ts";

const KEY = keccak256(toHex("agate e2e gate test user")) as Hex;
const USER = privateKeyToAccount(KEY).address;
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const IX = A(0xa1), PIX = A(0xa2), FAC = A(0xf1), PFAC = A(0xf2), RT = A(0xb1), PRT = A(0xb2), DOL = A(0xd1);
const OWNER = A(0x101), W0 = A(0x102), W1 = A(0x103), ATT = A(0x104), G0 = A(0x105), ADMIN = A(0x106), MINTER = A(0x107);
/** the temp folders this file makes, removed after it */
const made: string[] = [];
const scratch = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const ABI = parseAbi([
  "function owner() view returns (address)",
  "function writers() view returns (address[2])",
  "function attester() view returns (address)",
  "function guardians() view returns (address[2])",
  "function marketAdmin() view returns (address)",
  "function minter() view returns (address)",
  "function index() view returns (address)",
  "function router() view returns (address)",
  "function dollar() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function clocks() view returns ((uint32 day, uint32 slice, uint32 tPend, uint32 closeGrace, uint32 grace, uint32 holdMove, uint32 holdMin, uint32 step, uint32 reopenWait, uint32 timelock, uint8 slices, uint8 minReadings, uint8 qMin, bool demoLabel, bool signAll, uint64 epochTs, uint32 epochDay, uint64 chainSelector))",
]);

/** A chain that answers the preflight's reads; every send (and estimate) is recorded and answered, so a gate that let
 *  one through would show up in `sent`. */
function fakeChain(o: { owner?: string; minter?: string; day?: number; mon?: bigint; usd?: bigint; fork?: boolean; pending?: number } = {}) {
  const sent: string[] = [];
  const methods: string[] = [];
  const fn = new Map<string, string>(ABI.map((f) => [toFunctionSelector(f), f.name]));
  const factoryIndex: Record<string, string> = { [FAC]: IX, [PFAC]: PIX };
  const factoryRouter: Record<string, string> = { [FAC]: RT, [PFAC]: PRT };
  const result = (name: string, to: string): unknown => {
    switch (name) {
      case "owner": return o.owner ?? OWNER;
      case "writers": return [W0, W1];
      case "attester": return ATT;
      case "guardians": return [G0, A(0)];
      case "marketAdmin": return ADMIN;
      case "minter": return o.minter ?? MINTER;
      case "index": return factoryIndex[to.toLowerCase()];
      case "router": return factoryRouter[to.toLowerCase()];
      case "dollar": return DOL;
      case "balanceOf": return o.usd ?? 10_000_000_000n;
      case "clocks": return { day: o.day ?? 600, slice: 150, tPend: 210, closeGrace: 150, grace: 600, holdMove: 4200, holdMin: 450, step: 100, reopenWait: 0, timelock: 0, slices: 4, minReadings: 2, qMin: 1, demoLabel: true, signAll: false, epochTs: 1_791_093_582n, epochDay: 20758, chainSelector: 1n };
    }
    throw new Error(`no answer for ${name}`);
  };
  const request = async ({ method, params }: { method: string; params?: unknown[] }) => {
    methods.push(method);
    switch (method) {
      case "eth_chainId": return "0x279f";
      case "anvil_nodeInfo":
        if (o.fork) return { forkConfig: { forkBlockNumber: 5 } };
        throw new Error("the method anvil_nodeInfo does not exist");
      case "eth_getBalance": return toHex(o.mon ?? 10n ** 19n);
      case "eth_gasPrice": return toHex(102_000_000_000n);
      case "eth_blockNumber": return "0x10";
      case "eth_getCode": return "0x";
      case "eth_getTransactionCount": return toHex((params as [string, string])[1] === "pending" ? (o.pending ?? 0) : 0);
      case "eth_call": {
        const { to, data } = (params as [{ to: string; data: Hex }])[0];
        const name = fn.get(data.slice(0, 10) as string);
        if (!name) throw new Error(`unexpected call ${data.slice(0, 10)}`);
        return encodeFunctionResult({ abi: ABI, functionName: name as never, result: result(name, to) as never });
      }
      case "eth_sendRawTransaction":
      case "eth_sendTransaction":
      case "eth_estimateGas":
        sent.push(method);
        return method === "eth_estimateGas" ? "0x5208" : `0x${"ab".repeat(32)}`;
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { transport: (_url: string) => custom({ request }), sent, methods };
}

/** A deployments file (real and demo factories) and its index records, in a temp folder. */
function files(o: { demoSameAsReal?: boolean; session?: string; demoIndexIsProduction?: boolean } = {}) {
  const dir = scratch("agate-gates-");
  const demo = o.demoSameAsReal ? { index: PIX, dollar: DOL, tag: "demo", factory: PFAC, router: PRT, tPend: 210, startBlock: 10 } : { index: IX, dollar: DOL, tag: "demo", factory: FAC, router: RT, tPend: 210, startBlock: 10 };
  const dep = { chainId: 10143, dollar: DOL, kuru: { router: A(0xc1), marginAccount: A(0xc2) }, factories: { real: { index: PIX, dollar: DOL, tag: "", factory: PFAC, router: PRT, tPend: 21600, startBlock: 1 }, demo } };
  const recs = { chainId: 10143, production: { index: o.demoIndexIsProduction ? IX : PIX }, demo: { index: demo.index, session: o.session ?? "active", deployBlock: 9 } };
  const deployments = join(dir, "10143.json");
  writeFileSync(deployments, JSON.stringify(dep));
  writeFileSync(join(dir, "10143-indexes.json"), JSON.stringify(recs));
  return deployments;
}

const H100: MarketView = { month: "2026-11", symbol: "dH100-NOV26", floor: 1_950_000n, cap: 8_000_000n, n: 30, k: 3, S: 11_970_000n, ask: 4_030_000n, bid: 3_950_000n };
const B200: MarketView = { month: "2026-11", symbol: "dB200-NOV26", floor: 3_450_000n, cap: 14_000_000n, n: 30, k: 3, S: 20_970_000n, ask: 7_060_000n, bid: 6_920_000n };

/** this file's lock folder: no run of it takes a lock in ~/.agate-e2e */
const LOCKS = scratch("agate-gates-locks-");

async function run(argv: string[], env: Record<string, string | undefined>, o: Parameters<typeof fakeChain>[0] = {}, view: MarketView = H100) {
  const chain = fakeChain(o);
  const lines: string[] = [];
  const code = await runTestnet(argv, env, { transport: chain.transport, runKeyCommand: () => KEY, marketView: async () => view, log: (s) => lines.push(s), lockDir: LOCKS });
  return { code, out: lines.join("\n"), sent: chain.sent, methods: chain.methods };
}
const base = (dep: string, more: string[] = []) => ["--i-mean-testnet", "--deployments", dep, "--no-indexer", ...more];
const ENV = { AGATE_E2E_KEY_CMD: "security find-generic-password -s agate.e2e.test -a private-key -w" };

describe("testnet gates: each refuses before anything is sent", () => {
  test("no --i-mean-testnet: refused before any read", async () => {
    const r = await run(["--deployments", files(), "--no-indexer"], ENV);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--i-mean-testnet");
    expect(r.methods).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  test("a loopback RPC without --allow-fork: refused before any read", async () => {
    const r = await run(base(files(), ["--rpc", "http://127.0.0.1:8549"]), ENV);
    expect(r.code).toBe(2);
    expect(r.out).toContain("loopback");
    expect(r.methods).toEqual([]);
  });

  test("--rpc: a list of public URLs is accepted; a loopback mixed into a list is refused even with --allow-fork", () => {
    expect(parseTestnetArgs(base(files(), ["--rpc", "https://testnet-rpc.monad.xyz,https://rpc.ankr.com/monad_testnet"]), ENV).rpc.split(",").length).toBe(2);
    expect(() => parseTestnetArgs(base(files(), ["--allow-fork", "--rpc", "https://testnet-rpc.monad.xyz,http://127.0.0.1:8549"]), ENV)).toThrow("never mixed");
    expect(() => parseTestnetArgs(base(files(), ["--rpc", "https://testnet-rpc.monad.xyz,http://localhost:8545"]), ENV)).toThrow("loopback");
  });

  test("a key in a variable instead of the command: refused before any read", async () => {
    const r = await run(base(files()), { ...ENV, AGATE_E2E_KEY: KEY });
    expect(r.code).toBe(2);
    expect(r.out).toContain("AGATE_E2E_KEY is set");
    expect(r.out).not.toContain(KEY.slice(2));
    expect(r.methods).toEqual([]);
  });

  test("a key command that only echoes a variable holding the key: refused, the variable named, the key never printed", async () => {
    const dep = files();
    const chain = fakeChain();
    const lines: string[] = [];
    // the real command runner: sh -c 'printf "%s" "$WALLET_SECRET"'
    const code = await runTestnet(base(dep), { PATH: process.env.PATH, WALLET_SECRET: KEY, AGATE_E2E_KEY_CMD: 'printf "%s" "$WALLET_SECRET"' }, { transport: chain.transport, marketView: async () => H100, log: (s) => lines.push(s), lockDir: LOCKS });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("also the value of the variable WALLET_SECRET");
    expect(lines.join("\n")).not.toContain(KEY.slice(2));
    expect(chain.sent).toEqual([]);
  });

  test("a key on the command line, or a literal key in the command without --allow-fork: refused", async () => {
    expect((await run([...base(files()), "--month", KEY], ENV)).code).toBe(2);
    const r = await run(base(files()), { AGATE_E2E_KEY_CMD: `printf ${KEY}` });
    expect(r.code).toBe(2);
    expect(r.out).toContain("holds a key literally");
    expect(r.methods).toEqual([]);
    // --allow-fork does not open it for Monad testnet: only a loopback fork takes a literal (anvil test) key
    const r2 = await run(base(files(), ["--allow-fork"]), { AGATE_E2E_KEY_CMD: `printf ${KEY}` });
    expect(r2.code).toBe(2);
    expect(r2.out).toContain("only against a loopback fork");
    expect(parseTestnetArgs(base(files(), ["--allow-fork", "--rpc", "http://127.0.0.1:8549"]), { AGATE_E2E_KEY_CMD: `printf ${KEY}` }).allowFork).toBe(true);
  });

  test("no key command at all: refused", async () => {
    const r = await run(base(files()), {});
    expect(r.code).toBe(2);
    expect(r.out).toContain("AGATE_E2E_KEY_CMD is not set");
  });

  test("an address with a role on chain (the index's owner): refused after printing its balances", async () => {
    const r = await run(base(files()), ENV, { owner: USER });
    expect(r.code).toBe(2);
    expect(r.out).toContain(`user ${USER}:`);
    expect(r.out).toContain("holds a role: index owner");
    expect(r.sent).toEqual([]);
  });

  test("an address with a role on chain (the dollar's minter): refused", async () => {
    const r = await run(base(files()), ENV, { minter: USER });
    expect(r.code).toBe(2);
    expect(r.out).toContain("dollar minter");
    expect(r.sent).toEqual([]);
  });

  test("a role address of the repo's lists (the public rehearsal maker key): refused", async () => {
    const maker = keccak256(toHex("agate kit rehearsal bot")) as Hex;
    const chain = fakeChain();
    const lines: string[] = [];
    const code = await runTestnet(base(files()), ENV, { transport: chain.transport, runKeyCommand: () => maker, marketView: async () => H100, log: (s) => lines.push(s), lockDir: LOCKS });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("rehearsal bot");
    expect(chain.sent).toEqual([]);
  });

  test("the production factory without --factory real: a demo entry that names production's addresses is refused", async () => {
    const r = await run(base(files({ demoSameAsReal: true })), ENV);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--factory real");
    expect(r.methods).toEqual([]);
  });

  test("the production factory without --factory real: a demo index that is the production index is refused", async () => {
    const r = await run(base(files({ demoIndexIsProduction: true })), ENV);
    expect(r.code).toBe(2);
    expect(r.out).toContain("production index");
  });

  test("the production factory without --factory real: a demo factory whose index runs the production clock is refused", async () => {
    const r = await run(base(files()), ENV, { day: 86_400 });
    expect(r.code).toBe(2);
    expect(r.out).toContain("production clock");
    expect(r.sent).toEqual([]);
  });

  test("the production factory without --factory real: AGATE_E2E_FACTORY=real in the environment is refused", async () => {
    const r = await run(base(files()), { ...ENV, AGATE_E2E_FACTORY: "real" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("only from --factory");
  });

  test("--factory real given explicitly passes the factory gate (the production clock is then expected)", async () => {
    const dep = files();
    const chain = fakeChain({ day: 86_400 });
    const o = parseTestnetArgs(base(dep, ["--factory", "real"]), ENV);
    const p = await preflight(o, ENV, { transport: chain.transport, runKeyCommand: () => KEY, marketView: async () => H100, lockDir: LOCKS }, () => {});
    p.release();
    expect(p.f.factory).toBe(PFAC);
    expect(chain.sent).toEqual([]);
  });

  test("a demo session marked stopped: refused (no day would turn final)", async () => {
    const r = await run(base(files({ session: "stopped" })), ENV);
    expect(r.code).toBe(2);
    expect(r.out).toContain('"stopped"');
  });

  test("the spend cap: a journey whose maximum is over --max-dollars is refused before the first send", async () => {
    const r1 = await run(base(files()), ENV, {}, B200);
    expect(r1.code).toBe(2);
    expect(r1.out).toContain("over --max-dollars $500.00");
    expect(r1.sent).toEqual([]);
    const r2 = await run(base(files(), ["--max-dollars", "100"]), ENV);
    expect(r2.code).toBe(2);
    expect(r2.sent).toEqual([]);
  });

  test("the spend cap at run time: a step over what is left of the cap is refused before it is sent", () => {
    const b = new Budget(500_000_000n);
    b.take("buy", 200_000_000n);
    b.take("short-open", 80_000_000n);
    expect(() => b.take("daily", 300_000_000n)).toThrow(GateError);
    expect(b.spent).toBe(280_000_000n);
  });

  test("the MON floor: a wallet under --min-mon is refused", async () => {
    const r = await run(base(files()), ENV, { mon: 5n * 10n ** 17n });
    expect(r.code).toBe(2);
    expect(r.out).toContain("under the floor");
    expect(r.sent).toEqual([]);
  });

  test("a transaction of the key still pending (a run that stopped mid-send): refused before any send", async () => {
    const r = await run(base(files()), ENV, { pending: 1 });
    expect(r.code).toBe(2);
    expect(r.out).toContain("1 transaction still pending");
    expect(r.sent).toEqual([]);
  });

  test("a non-loopback RPC that is a local node (it answers anvil_nodeInfo): refused before the key command", async () => {
    const chain = fakeChain({ fork: true });
    const lines: string[] = [];
    let keyRuns = 0;
    const code = await runTestnet(base(files(), ["--rpc", "https://looks-public.example"]), ENV, { transport: chain.transport, runKeyCommand: () => { keyRuns++; return KEY; }, marketView: async () => H100, log: (s) => lines.push(s), lockDir: LOCKS });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("answers anvil_nodeInfo");
    expect(keyRuns).toBe(0);
    expect(chain.sent).toEqual([]);
  });

  test("everything in order: the preflight passes, prints the plan, and has sent nothing", async () => {
    const dep = files();
    const chain = fakeChain();
    const lines: string[] = [];
    const o: TestnetOptions = parseTestnetArgs(base(dep), ENV);
    const p = await preflight(o, ENV, { transport: chain.transport, runKeyCommand: () => KEY, marketView: async () => H100, lockDir: LOCKS }, (s) => lines.push(s));
    p.release();
    expect(p.user).toBe(USER);
    expect(p.plan.total).toBeLessThanOrEqual(500_000_000n);
    expect(lines.join("\n")).toContain("spend plan on dH100-NOV26");
    expect(lines.join("\n")).not.toContain(KEY.slice(2));
    expect(chain.sent).toEqual([]);
  });
});

describe("testnet helpers", () => {
  test("the plan: buy $200, the short's collateral 10 x C, the buy-back at the ask plus 1%, daily $100, the bid's deposit", () => {
    const p = planSpend(H100);
    expect(p.items.map((x) => [x.step, x.max])).toEqual([
      ["buy", 200_000_000n],
      ["short-open", 80_000_000n],
      ["short-close", 40_703_000n],
      ["daily", 100_000_000n],
      ["limit", 39_000_000n],
    ]);
    expect(p.total).toBe(459_703_000n);
  });
  test("the static roles hold the real and the rehearsal keys of lib.sh and the configs' roles", () => {
    const r = staticRoles();
    expect(r.get("0xbfaa70a8b399097facf4a84b98da5b304587c8b8")?.join()).toContain("bot");
    expect(r.get("0x3786e99fc370506391be896e1d327a49de6a9505")?.join()).toContain("payer");
    expect(r.get("0x9a410e49a53115e85b751fe8d3b589bb8f1a717f")?.join()).toContain("rehearsal bot");
    expect(r.get("0x62565e5d1533af8c1f711c42e047e5f94c172411")?.join()).toContain("deployer");
    expect(r.has(USER.toLowerCase())).toBe(false);
  });
  test("a command that prints no key, or fails, is refused without showing its output", () => {
    expect(() => accountFromCommand("x", {}, () => "not a key\n")).toThrow("did not print exactly one 32-byte hex key");
    expect(() => accountFromCommand("exit 3", { PATH: process.env.PATH })).toThrow("failed (exit 3)");
    expect(accountFromCommand("x", {}, () => `${KEY.slice(2)}\n`).address).toBe(USER);
  });
  test("the CLI: run.ts testnet without the flag exits 2 and sends nothing (no network: refused at the arguments)", () => {
    const r = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "e2e", "run.ts"), "testnet", "--rpc", "http://127.0.0.1:1"], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    expect(r.exitCode).toBe(2);
    expect(r.stdout.toString()).toContain("--i-mean-testnet");
    const r2 = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "e2e", "run.ts"), "testnet", "--i-mean-testnet", "--rpc", "http://127.0.0.1:1"], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGATE_E2E_KEY_CMD: "true" } });
    expect(r2.exitCode).toBe(2);
    expect(r2.stdout.toString()).toContain("loopback");
  });
});
