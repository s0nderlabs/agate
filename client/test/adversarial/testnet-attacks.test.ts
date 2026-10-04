// Attacks on the testnet mode (e2e/testnet.ts), on a fake chain that answers the preflight's reads and records every
// send: a key leak (stdout, the report file, error text), a role address used as the user, a spend above the cap, the
// production factory by default, a loopback or a local node slipped past the fork gate, two runs of one key at once, a
// rerun after a finished journey, and any network call outside the loopback (every fetch of this file is checked). No
// key of anyone's: throwaway keys derived from labels.
//
// Every test here is a property the mode holds. The seven that were `test.failing` in the independent check of Oct 4
// (five loopback spellings, a key glued to other hex digits on a failing command's stderr, and in an option's value)
// are plain tests now.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, custom, encodeFunctionResult, type Hex, keccak256, parseAbi, type PublicClient, toFunctionSelector, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isLoopback } from "../../e2e/fork.ts";
import { claimsWithoutText, indexerText, slicesText } from "../../e2e/session-lines.ts";
import { accountFromCommand, Budget, buyBackMax, chooseMonth, GateError, journeyMonths, knownHash, lockName, type MarketView, monthFromReport, parseTestnetArgs, pickMonth, planSpend, preflight, redact, runTestnet, staticRoles, takeLock } from "../../e2e/testnet.ts";
import type { AgateClient } from "../../src/index.ts";
import { monthOfLabel, plus, U } from "../../src/units.ts";

const KEY = keccak256(toHex("agate adversarial testnet user")) as Hex;
const USER = privateKeyToAccount(KEY).address;
const KEY_HEX = KEY.slice(2).toLowerCase();
const KEY_DEC = BigInt(KEY).toString();
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const IX = A(0xa1), PIX = A(0xa2), FAC = A(0xf1), PFAC = A(0xf2), RT = A(0xb1), PRT = A(0xb2), DOL = A(0xd1);
const ROOT = join(import.meta.dir, "..", "..", "..");
/** the temp folders this file makes, removed after it */
const made: string[] = [];
const scratch = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
/** this file's lock folder: no run of it takes a lock in ~/.agate-e2e */
const LOCKS = scratch("agate-attacks-locks-");

// ------------------------------------------------------------------ every fetch of this file stays on the loopback

const realFetch = globalThis.fetch;
const fetched: string[] = [];
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetched.push(u);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u)) throw new Error(`a test reached for the network: ${u}`);
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const has = (text: string, ...keys: string[]) => keys.some((k) => text.toLowerCase().includes(k.toLowerCase()));

// ------------------------------------------------------------------ a fake chain

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

interface ChainOpts {
  /** per index (lowercase): role overrides */
  writers?: Record<string, [string, string]>;
  guardians?: Record<string, [string, string]>;
  owner?: Record<string, string>;
  /** per factory (lowercase): marketAdmin */
  admin?: Record<string, string>;
  /** per factory (lowercase): what its index() answers */
  factoryIndex?: Record<string, string>;
  /** per index (lowercase): its day in seconds */
  day?: Record<string, number>;
  /** function names that revert */
  revert?: string[];
  mon?: bigint;
  /** the chain id the node answers (default 10143) */
  chainId?: number;
  /** URLs whose node answers anvil_nodeInfo (a fork) or hardhat_metadata; "*" for every URL */
  anvilAt?: string[];
  hardhatAt?: string[];
  /** the node never answers anvil_nodeInfo nor hardhat_metadata (no error, no result) */
  probeHangs?: boolean;
  /** the key's nonce: landed, and with the pending transactions (null: the pending tag is refused) */
  nonce?: number;
  pending?: number | null;
  /** text every error of an unanswered call carries (a node's error message is not ours to trust) */
  errText?: string;
}

function fakeChain(o: ChainOpts = {}) {
  const sent: string[] = [];
  const methods: string[] = [];
  const fn = new Map<string, string>(ABI.map((f) => [toFunctionSelector(f), f.name]));
  const fIndex: Record<string, string> = { [FAC]: IX, [PFAC]: PIX, ...(o.factoryIndex ?? {}) };
  const fRouter: Record<string, string> = { [FAC]: RT, [PFAC]: PRT };
  const at = (list: string[] | undefined, url: string) => !!list && (list.includes("*") || list.includes(url));
  const result = (name: string, to: string): unknown => {
    const t = to.toLowerCase();
    switch (name) {
      case "owner": return o.owner?.[t] ?? A(0x101);
      case "writers": return o.writers?.[t] ?? [A(0x102), A(0x103)];
      case "attester": return A(0x104);
      case "guardians": return o.guardians?.[t] ?? [A(0x105), A(0)];
      case "marketAdmin": return o.admin?.[t] ?? A(0x106);
      case "minter": return A(0x107);
      case "index": return fIndex[t];
      case "router": return fRouter[t];
      case "dollar": return DOL;
      case "balanceOf": return 10_000_000_000n;
      case "clocks": return { day: o.day?.[t] ?? (t === PIX ? 86_400 : 600), slice: 150, tPend: 210, closeGrace: 150, grace: 600, holdMove: 4200, holdMin: 450, step: 100, reopenWait: 0, timelock: 0, slices: 4, minReadings: 2, qMin: 1, demoLabel: true, signAll: false, epochTs: 1_791_093_582n, epochDay: 20758, chainSelector: 1n };
    }
    throw new Error(`no answer for ${name}`);
  };
  const request = (url: string) => async ({ method, params }: { method: string; params?: unknown[] }) => {
    methods.push(method);
    switch (method) {
      case "eth_chainId": return toHex(o.chainId ?? 10143);
      case "anvil_nodeInfo":
        if (o.probeHangs) return new Promise(() => {});
        if (at(o.anvilAt, url)) return { forkConfig: { forkBlockNumber: 5 } };
        throw new Error("the method anvil_nodeInfo does not exist");
      case "hardhat_metadata":
        if (o.probeHangs) return new Promise(() => {});
        if (at(o.hardhatAt, url)) return { clientVersion: "HardhatNetwork/2.22.0", chainId: 10143 };
        throw new Error("the method hardhat_metadata does not exist");
      case "eth_getBalance": return toHex(o.mon ?? 10n ** 19n);
      case "eth_gasPrice": return toHex(102_000_000_000n);
      case "eth_blockNumber": return "0x10";
      case "eth_getTransactionCount": {
        const tag = (params as [string, string])[1];
        if (tag === "pending") {
          if (o.pending === null) throw new Error("the block tag pending is not supported");
          return toHex(o.pending ?? o.nonce ?? 0);
        }
        return toHex(o.nonce ?? 0);
      }
      case "eth_call": {
        const { to, data } = (params as [{ to: string; data: Hex }])[0];
        const name = fn.get(data.slice(0, 10) as string);
        if (!name) throw new Error(`unexpected call ${data.slice(0, 10)}${o.errText ? ` ${o.errText}` : ""}`);
        if (o.revert?.includes(name)) throw new Error(`execution reverted (${name})`);
        return encodeFunctionResult({ abi: ABI, functionName: name as never, result: result(name, to) as never });
      }
      case "eth_sendRawTransaction":
      case "eth_sendTransaction":
      case "eth_estimateGas":
        sent.push(method);
        return method === "eth_estimateGas" ? "0x5208" : `0x${"ab".repeat(32)}`;
    }
    throw new Error(`unexpected method ${method}${o.errText ? ` ${o.errText}` : ""}`);
  };
  return { transport: (url: string) => custom({ request: request(url) }), sent, methods };
}

/** A deployments file and its index records in a temp folder; `only` keeps one factory entry. */
function files(o: { demo?: { index: string; factory: string; router: string }; noReal?: boolean; production?: string | null; session?: string; chainId?: number } = {}) {
  const dir = scratch("agate-attacks-");
  const demo = { dollar: DOL, tag: "demo", tPend: 210, startBlock: 10, ...(o.demo ?? { index: IX, factory: FAC, router: RT }) };
  const factories: Record<string, unknown> = { demo };
  if (!o.noReal) factories.real = { index: PIX, dollar: DOL, tag: "", factory: PFAC, router: PRT, tPend: 21600, startBlock: 1 };
  const dep = { chainId: o.chainId ?? 10143, dollar: DOL, kuru: { router: A(0xc1), marginAccount: A(0xc2) }, factories };
  const recs: Record<string, unknown> = { chainId: 10143, demo: { index: demo.index, session: o.session ?? "active", deployBlock: 9 } };
  if (o.production !== null) recs.production = { index: o.production ?? PIX };
  const deployments = join(dir, "10143.json");
  writeFileSync(deployments, JSON.stringify(dep));
  writeFileSync(join(dir, "10143-indexes.json"), JSON.stringify(recs));
  return { deployments, dir };
}

const H100: MarketView = { month: "2026-11", symbol: "dH100-NOV26", floor: 1_950_000n, cap: 8_000_000n, n: 30, k: 3, S: 11_970_000n, ask: 4_030_000n, bid: 3_950_000n };
const ENV = { AGATE_E2E_KEY_CMD: "security find-generic-password -s agate.e2e.adversarial -a private-key -w" };
const base = (dep: string, more: string[] = []) => ["--i-mean-testnet", "--deployments", dep, "--no-indexer", ...more];

async function run(argv: string[], env: Record<string, string | undefined>, chain = fakeChain(), key: () => string = () => KEY, more: { lockDir?: string; probeMs?: number } = {}) {
  const lines: string[] = [];
  let keyRuns = 0;
  const code = await runTestnet(argv, env, { transport: chain.transport, runKeyCommand: () => { keyRuns++; return key(); }, marketView: async () => H100, log: (s) => lines.push(s), lockDir: more.lockDir ?? LOCKS, probeMs: more.probeMs });
  return { code, out: lines.join("\n"), sent: chain.sent, methods: chain.methods, keyRuns };
}

// ------------------------------------------------------------------ the key

describe("the key: never printed, never written, never from a variable", () => {
  test("a run that passes every gate and then breaks inside the journey prints and writes nothing of the key; nothing is sent", async () => {
    const { deployments, dir } = files();
    const report = join(dir, "report.json");
    const r = await run(base(deployments, ["--report", report]), ENV);
    // the journey's first read is not answered by the fake chain: the run stops with an error, after the preflight
    expect(r.code).toBe(1);
    expect(r.out).toContain(`user ${USER}`);
    expect(r.out).toContain("spend plan on dH100-NOV26");
    expect(r.out).toContain("== reads");
    expect(r.keyRuns).toBe(1);
    const written = readFileSync(report, "utf8");
    expect(has(r.out, KEY_HEX, KEY_DEC)).toBe(false);
    expect(has(written, KEY_HEX, KEY_DEC)).toBe(false);
    expect(written).toContain(USER);
    expect(r.sent).toEqual([]);
  });

  test("the key command is not run before the flag, the fork gate, the factory gate or the session gate pass", async () => {
    const { deployments } = files();
    const stopped = files({ session: "stopped" }).deployments;
    for (const argv of [["--deployments", deployments, "--no-indexer"], base(deployments, ["--rpc", "http://127.0.0.1:8545"]), base(files({ demo: { index: PIX, factory: PFAC, router: PRT } }).deployments), base(stopped)]) {
      const r = await run(argv, ENV);
      expect(r.code).toBe(2);
      expect(r.keyRuns).toBe(0);
      expect(r.sent).toEqual([]);
    }
  });

  test("a key in a variable under any name, echoed by the command as is, with 0x added, or in capitals, is refused and never shown", () => {
    const sh = (cmd: string, env: Record<string, string>) => () => accountFromCommand(cmd, { PATH: process.env.PATH, ...env });
    for (const [cmd, env] of [
      ['printf "%s" "$WALLET_PK"', { WALLET_PK: KEY }],
      ['printf "0x%s" "$WALLET_PK"', { WALLET_PK: KEY_HEX }],
      ['printf "%s" "$WALLET_PK"', { WALLET_PK: `  ${KEY.toUpperCase().replace("0X", "0x")}\n` }],
      ['printf "%s" "$WALLET_PK"', { WALLET_PK: `0X${KEY_HEX.toUpperCase()}` }],
    ] as const) {
      let msg = "";
      try {
        sh(cmd, env)();
      } catch (e) {
        expect(e).toBeInstanceOf(GateError);
        msg = (e as Error).message;
      }
      expect(msg).not.toBe("");
      expect(has(msg, KEY_HEX)).toBe(false);
    }
  });

  test("a failing key command that writes the key alone on its last stderr line: the line is not shown", () => {
    for (const line of [KEY, KEY_HEX, `error: ${KEY} rejected`, `key=${KEY_HEX}`]) {
      try {
        accountFromCommand(`printf '%s\\n' '${line}' >&2; exit 1`, { PATH: process.env.PATH });
        throw new Error("accepted");
      } catch (e) {
        expect((e as Error).message).toContain("failed (exit 1)");
        expect(has((e as Error).message, KEY_HEX)).toBe(false);
      }
    }
  });

  test("a failing key command whose last stderr line holds the key next to other hex digits: the key is not shown", () => {
    // the old filter needed a non-hex character on both sides of the 64 digits, so `0x<key>ff` or `abc<key>` was shown
    let msg = "";
    try {
      accountFromCommand(`printf '%sff\\n' '${KEY}' >&2; exit 1`, { PATH: process.env.PATH });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("failed (exit 1)");
    expect(has(msg, KEY_HEX)).toBe(false);
  });

  test("a failing key command: nothing it wrote is shown, on stdout or stderr, whatever it is (only the exit code)", () => {
    for (const [cmd, code] of [[`printf 'abc%s\\n' '${KEY_HEX}'; exit 4`, 4], ["printf 'no such item in the keychain\\n' >&2; exit 44", 44], [`printf '%s' '${KEY_DEC}' >&2; printf 'stdout words'; exit 2`, 2]] as const) {
      let msg = "";
      try {
        accountFromCommand(cmd, { PATH: process.env.PATH });
      } catch (e) {
        expect(e).toBeInstanceOf(GateError);
        msg = (e as Error).message;
      }
      expect(msg).toContain(`failed (exit ${code})`);
      for (const word of ["keychain", "stdout words", "abc", KEY_HEX, KEY_DEC]) expect(has(msg, word)).toBe(false);
    }
  });

  test("a key pasted into an option's value next to other hex digits: the refusal does not echo it", () => {
    let msg = "";
    try {
      parseTestnetArgs(base(files().deployments, ["--month", `${KEY_HEX}ab`]), ENV);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toBe("");
    expect(has(msg, KEY_HEX)).toBe(false);
  });

  test("any argument holding 64 hex digits anywhere is refused before any read, unshown, the key command not run", async () => {
    const { deployments } = files();
    const bad = [
      ["--month", `${KEY_HEX}ab`],
      ["--gpu", `a${KEY_HEX}`],
      [`${KEY_HEX}ab`],
      ["--rpc", `https://x.example/ab${KEY_HEX}`],
      ["--rpc", `https://testnet-rpc.monad.xyz,https://x.example/${KEY}`],
      ["--report", join(tmpdir(), `${KEY_HEX}.json`)],
      ["--month", KEY_HEX.toUpperCase()],
      ["--from-block", KEY_DEC],
      ["--graphql", `http://127.0.0.1:8080/${KEY_HEX}`],
    ];
    for (const more of bad) {
      const r = await run(base(deployments, more), ENV);
      expect(r.code).toBe(2);
      expect(r.out).toContain("holds 64 hex digits in a row");
      expect(has(r.out, KEY_HEX, KEY_DEC)).toBe(false);
      expect(r.methods).toEqual([]);
      expect(r.keyRuns).toBe(0);
    }
  });

  test("redact() hides every run of 64 or more hex digits, whatever stands beside it, and shows only a transaction hash this run knows", () => {
    const hash = `0x${keccak256(toHex("a transaction of this run")).slice(2)}`;
    knownHash(hash);
    for (const s of [`0x${KEY_HEX}ff`, `abc${KEY_HEX}`, KEY_HEX.toUpperCase(), `key=${KEY}`, KEY_DEC, `${hash.slice(2)}${KEY_HEX}`, `${hash}0`]) {
      const r = redact(`before ${s} after`);
      expect(has(r, KEY_HEX, KEY_DEC)).toBe(false);
      expect(r).toContain("[64+ hex digits hidden]");
      expect(r).toStartWith("before ");
      expect(r).toEndWith(" after");
    }
    expect(redact(`sent openLong: ${hash} (gas limit 1)`)).toBe(`sent openLong: ${hash} (gas limit 1)`);
    expect(redact(`${hash.toUpperCase().replace("0X", "0x")}`)).toContain(hash.slice(2).toUpperCase());
    expect(redact("0x1234 and 63 digits " + "a".repeat(63))).toBe("0x1234 and 63 digits " + "a".repeat(63));
  });

  test("an error text that carries the key glued to other hex digits (a node's message): the output and the report hide it", async () => {
    const { deployments, dir } = files();
    const report = join(dir, "report.json");
    const r = await run(base(deployments, ["--report", report]), ENV, fakeChain({ errText: `node said 0x${KEY_HEX}ff and ${KEY_DEC}` }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("STOPPED");
    expect(r.out).toContain("[64+ hex digits hidden]");
    const written = readFileSync(report, "utf8");
    expect(has(r.out, KEY_HEX, KEY_DEC)).toBe(false);
    expect(has(written, KEY_HEX, KEY_DEC)).toBe(false);
    expect(JSON.parse(written).user).toBe(USER);
  });

  test("32 bytes that are no valid key (zero, at or over the curve's order): refused without the value", () => {
    for (const out of ["0".repeat(64), "f".repeat(64)]) {
      let msg = "";
      try {
        accountFromCommand("x", {}, () => out);
      } catch (e) {
        expect(e).toBeInstanceOf(GateError);
        msg = (e as Error).message;
      }
      expect(msg).toContain("not a valid secp256k1 key");
      expect(msg).not.toContain(out);
      expect(msg).not.toContain(BigInt(`0x${out}`).toString());
    }
  });
});

// ------------------------------------------------------------------ roles

describe("a role address as the user: refused before any send", () => {
  test("every role address of ops/testnet/lib.sh (read by bash itself) and of the index configs is in the static list", () => {
    const roles = ["deployer", "owner", "primary", "standby", "attester", "keeper", "guardian", "kick", "bot", "payer"];
    const r = Bun.spawnSync(["bash", "-c", `source ops/testnet/lib.sh >/dev/null 2>&1; for r in ${roles.join(" ")}; do role_addr_real $r; role_addr_rehearsal $r; done`], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const want = r.stdout.toString().trim().split("\n").filter(Boolean);
    expect(want.length).toBe(roles.length * 2);
    for (const f of ["testnet-demo.json", "testnet-production.json"]) {
      const j = JSON.parse(readFileSync(join(ROOT, "contracts", "script", "config", f), "utf8")) as { roles: Record<string, string> };
      for (const a of Object.values(j.roles)) if (!/^0x0{40}$/.test(a)) want.push(a);
    }
    const m = JSON.parse(readFileSync(join(ROOT, "contracts", "script", "config", "market-testnet.json"), "utf8")) as { marketAdmin: string; dollar: { minter: string }; botFloat: { to: string } };
    want.push(m.marketAdmin, m.dollar.minter, m.botFloat.to);
    const have = staticRoles();
    const missing = [...new Set(want.map((a) => a.toLowerCase()))].filter((a) => !have.has(a));
    expect(missing).toEqual([]);
  });

  test("the user in the second writer slot, the second guardian slot, or as owner (any case): refused", async () => {
    const { deployments } = files();
    for (const o of [{ writers: { [IX]: [A(0x102), USER] as [string, string] } }, { guardians: { [PIX]: [A(0x105), USER] as [string, string] } }, { owner: { [IX]: USER.toLowerCase() } }]) {
      const r = await run(base(deployments), ENV, fakeChain(o));
      expect(r.code).toBe(2);
      expect(r.out).toContain("holds a role");
      expect(r.sent).toEqual([]);
    }
  });

  test("with --factory real, the demo factory's market admin is a role too (every factory is checked)", async () => {
    const r = await run(base(files().deployments, ["--factory", "real"]), ENV, fakeChain({ admin: { [FAC]: USER } }));
    expect(r.code).toBe(2);
    expect(r.out).toContain("market admin (factory demo)");
    expect(r.sent).toEqual([]);
  });

  test("a role read that fails refuses the run (never read as no role)", async () => {
    for (const fn of ["guardians", "marketAdmin", "minter", "writers"]) {
      const r = await run(base(files().deployments), ENV, fakeChain({ revert: [fn] }));
      expect(r.code).toBe(2);
      expect(r.out).toContain(`the role read ${fn}()`);
      expect(r.sent).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------ the production factory

describe("the production factory never by default", () => {
  test("no --factory means demo; --factory takes only demo or real; AGATE_E2E_FACTORY is refused whatever it says", () => {
    const { deployments } = files();
    expect(parseTestnetArgs(base(deployments), ENV).factory).toBe("demo");
    expect(() => parseTestnetArgs(base(deployments, ["--factory", "REAL"]), ENV)).toThrow(GateError);
    expect(() => parseTestnetArgs(base(deployments, ["--factory", "production"]), ENV)).toThrow(GateError);
    expect(() => parseTestnetArgs(base(deployments), { ...ENV, AGATE_E2E_FACTORY: "demo" })).toThrow("only from --factory");
  });

  test("a demo entry whose factory answers the production index on chain is refused (the file says another index)", async () => {
    const r = await run(base(files().deployments), ENV, fakeChain({ factoryIndex: { [FAC]: PIX } }));
    expect(r.code).toBe(2);
    expect(r.out).toContain("on chain names index");
    expect(r.sent).toEqual([]);
  });

  test("a deployments file whose only entry is production's, named demo, with no production record: refused by the production clock", async () => {
    const { deployments } = files({ demo: { index: PIX, factory: PFAC, router: PRT }, noReal: true, production: null });
    const r = await run(base(deployments), ENV);
    expect(r.code).toBe(2);
    expect(r.out).toContain("production clock");
    expect(r.sent).toEqual([]);
  });

  test("a deployments file of another chain: refused", async () => {
    const r = await run(base(files({ chainId: 143 }).deployments), ENV);
    expect(r.code).toBe(2);
    expect(r.keyRuns).toBe(0);
  });
});

// ------------------------------------------------------------------ the spend cap

describe("the spend cap", () => {
  test("the plan exactly at --max-dollars passes; a millionth under it is refused before any send", async () => {
    const total = planSpend(H100).total;
    const at = (Number(total) / 1e6).toFixed(6);
    const under = (Number(total - 1n) / 1e6).toFixed(6);
    const { deployments } = files();
    const o = parseTestnetArgs(base(deployments, ["--max-dollars", at]), ENV);
    const chain = fakeChain();
    const p = await preflight(o, ENV, { transport: chain.transport, runKeyCommand: () => KEY, marketView: async () => H100, lockDir: LOCKS }, () => {});
    p.release();
    expect(p.plan.total).toBe(total);
    const r = await run(base(deployments, ["--max-dollars", under]), ENV);
    expect(r.code).toBe(2);
    expect(r.out).toContain("over --max-dollars");
    expect(r.sent).toEqual([]);
  });

  test("the run-time budget never lets the sum of the writes' maxima pass the cap, whatever the order", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 200; i++) {
      const cap = BigInt(Math.floor(rnd() * 1_000_000_000) + 1);
      const b = new Budget(cap);
      for (let j = 0; j < 12; j++) {
        const max = BigInt(Math.floor(rnd() * 300_000_000));
        const before = b.spent;
        try {
          b.take("x", max);
          expect(before + max).toBeLessThanOrEqual(cap);
        } catch (e) {
          expect(e).toBeInstanceOf(GateError);
          expect(b.spent).toBe(before);
        }
        expect(b.spent).toBeLessThanOrEqual(cap);
      }
    }
  });

  test("the buy-back's budget is the client's own bound: the shown cost plus 1%, rounded up", () => {
    for (const [q, ask] of [[10_000_000n, 4_030_000n], [7_500_000n, 3_990_000n], [1n, 1n], [123_456_789n, 7_777_777n]] as const) {
      const cost = (q * ask + U - 1n) / U;
      expect(buyBackMax(q, ask)).toBe(plus(cost, 100));
    }
  });

  test("--max-dollars takes only a plain positive decimal", () => {
    const { deployments } = files();
    for (const v of ["0", "-1", "1e3", "abc", "1.0000001", ""]) expect(() => parseTestnetArgs(base(deployments, ["--max-dollars", v]), ENV)).toThrow(GateError);
  });
});

// ------------------------------------------------------------------ the fork gate

describe("the fork gate", () => {
  test("loopback URLs in the spellings the gate knows are refused without --allow-fork", () => {
    const { deployments } = files();
    for (const u of ["http://127.0.0.1:8545", "http://127.0.0.1:8545/", "http://localhost:8545", "https://localhost"]) expect(() => parseTestnetArgs(base(deployments, ["--rpc", u]), ENV)).toThrow("loopback");
  });

  for (const u of ["http://LOCALHOST:8545", "http://[::1]:8545", "http://0.0.0.0:8545", "http://127.0.0.2:8545", "http://localhost.:8545"]) {
    test(`a loopback spelled ${u} is refused without --allow-fork`, () => {
      expect(() => parseTestnetArgs(base(files().deployments, ["--rpc", u]), ENV)).toThrow("loopback");
    });
  }

  test("every other spelling fetch reads as this machine is refused without --allow-fork, before any read", async () => {
    const { deployments } = files();
    const spellings = ["http://2130706433:8545", "http://0x7f000001:8545", "http://127.1:8545", "http://0177.0.0.1:8545", "http://017700000001:8545", "http://127.000.000.001:8545", "http://0:8545", "http://[::ffff:127.0.0.1]:8545", "http://[0:0:0:0:0:0:0:1]:8545", "http://[::]:8545", "http://foo.localhost:8545", "http://FOO.LocalHost.:8545", "http://localhost..:8545", "HTTP://LOCALHOST:8545", "http://%6c%6f%63%61%6c%68%6f%73%74:8545", "http://127.0.0.1%2e:8545", "http://user:pw@127.0.0.1:8545", "http://127.255.255.254:8545"];
    for (const u of spellings) {
      expect(isLoopback(u)).toBe(true);
      const r = await run(base(deployments, ["--rpc", u]), ENV);
      expect(r.code).toBe(2);
      expect(r.out).toContain("loopback");
      expect(r.methods).toEqual([]);
      expect(r.keyRuns).toBe(0);
    }
    // and in a list of URLs, even with --allow-fork
    expect(() => parseTestnetArgs(base(deployments, ["--rpc", "https://testnet-rpc.monad.xyz,http://2130706433:8545"]), ENV)).toThrow("loopback");
    expect(() => parseTestnetArgs(base(deployments, ["--allow-fork", "--rpc", "https://testnet-rpc.monad.xyz,http://[::1]:8545"]), ENV)).toThrow("never mixed");
  });

  test("a URL whose host is elsewhere is not read as loopback, however it is dressed", () => {
    for (const u of ["https://testnet-rpc.monad.xyz", "http://127.0.0.1.nip.io:8545", "http://localhost@evil.example:8545", "http://evil.example#@127.0.0.1", "http://localhost.evil.example:8545", "http://128.0.0.1:8545", "not a url", "ftp://127.0.0.1/"]) expect(isLoopback(u)).toBe(false);
  });

  test("a literal key and --time-travel open only for a loopback URL with --allow-fork, never a public URL or a name that is not this machine's", () => {
    const { deployments } = files();
    for (const u of ["https://testnet-rpc.monad.xyz", "http://127.0.0.1.nip.io:8545", "http://localhost@evil.example:8545"]) {
      expect(() => parseTestnetArgs(base(deployments, ["--allow-fork", "--rpc", u]), { AGATE_E2E_KEY_CMD: `printf ${KEY}` })).toThrow("holds a key literally");
      expect(() => parseTestnetArgs(base(deployments, ["--allow-fork", "--time-travel", "--rpc", u]), ENV)).toThrow("--time-travel");
    }
    for (const u of ["http://LOCALHOST:8545", "http://[::1]:8545", "http://2130706433:8545"]) expect(parseTestnetArgs(base(deployments, ["--allow-fork", "--time-travel", "--rpc", u]), { AGATE_E2E_KEY_CMD: `printf ${KEY}` }).timeTravel).toBe(true);
  });

  test("a loopback spelling with --allow-fork still has to be an anvil fork of chain 10143: a node that is not is refused before the key command", async () => {
    const r = await run(base(files().deployments, ["--allow-fork", "--rpc", "http://[::1]:8545"]), ENV);
    expect(r.code).toBe(2);
    expect(r.out).toContain("not an anvil fork");
    expect(r.keyRuns).toBe(0);
    expect(r.sent).toEqual([]);
  });

  test("an RPC that answers anvil_nodeInfo or hardhat_metadata is refused whatever its URL, with or without --allow-fork, before the key command", async () => {
    const { deployments } = files();
    const u = "https://fork.example:8545";
    for (const [chain, method] of [[fakeChain({ anvilAt: [u] }), "anvil_nodeInfo"], [fakeChain({ hardhatAt: [u] }), "hardhat_metadata"]] as const) {
      for (const more of [["--rpc", u], ["--allow-fork", "--rpc", u]]) {
        const r = await run(base(deployments, more), ENV, chain);
        expect(r.code).toBe(2);
        expect(r.out).toContain(`answers ${method}`);
        expect(r.keyRuns).toBe(0);
        expect(r.sent).toEqual([]);
      }
    }
  });

  test("with a list of URLs, each one is asked: a local node second in the list is refused, and so is a URL of another chain", async () => {
    const { deployments } = files();
    const list = "https://rpc-a.example,https://fork.example:8545";
    const r = await run(base(deployments, ["--rpc", list]), ENV, fakeChain({ anvilAt: ["https://fork.example:8545"] }));
    expect(r.code).toBe(2);
    expect(r.out).toContain("https://fork.example:8545 answers anvil_nodeInfo");
    expect(r.keyRuns).toBe(0);
    const r2 = await run(base(deployments, ["--rpc", "https://rpc-a.example"]), ENV, fakeChain({ chainId: 1 }));
    expect(r2.code).toBe(2);
    expect(r2.out).toContain("answers chain 1, not 10143");
    expect(r2.keyRuns).toBe(0);
  });

  test("an RPC that errors on the probe, or does not answer it in time, is not a local node: the run goes on", async () => {
    const { deployments } = files();
    for (const chain of [fakeChain(), fakeChain({ probeHangs: true })]) {
      const t0 = Date.now();
      const r = await run(base(deployments), ENV, chain, () => KEY, { probeMs: 50 });
      expect(r.code).toBe(1); // the fake chain does not answer the journey's reads
      expect(r.out).toContain("spend plan on dH100-NOV26");
      expect(r.keyRuns).toBe(1);
      expect(r.sent).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(10_000);
    }
  });
});

// ------------------------------------------------------------------ one run per key

describe("one live run per key", () => {
  test("a second run of the same key while the first lives exits 2 and sends nothing; once the first is gone its lock is taken over and released at the end", async () => {
    const dir = scratch("agate-attacks-lock-");
    const file = join(dir, `${lockName(USER, "https://testnet-rpc.monad.xyz", false)}.pid`);
    const other = Bun.spawn(["sleep", "30"]);
    writeFileSync(file, JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }));
    const { deployments, dir: d } = files();
    // the live run's --report file is left alone by the refused run
    const report = join(d, "live.json");
    writeFileSync(report, "the live run's report");
    const r = await run(base(deployments, ["--report", report]), ENV, fakeChain(), () => KEY, { lockDir: dir });
    expect(r.code).toBe(2);
    expect(r.out).toContain(`another run of this key is going (pid ${other.pid}`);
    expect(r.out).toContain("is left as it is");
    expect(readFileSync(report, "utf8")).toBe("the live run's report");
    expect(r.sent).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(other.pid);
    other.kill("SIGKILL");
    await other.exited;
    const r2 = await run(base(deployments), ENV, fakeChain(), () => KEY, { lockDir: dir });
    expect(r2.out).toContain("spend plan on dH100-NOV26");
    expect(r2.sent).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  test("two runs of one key in one process: the second is refused; another key, or the same key on a fork, has its own lock", () => {
    const dir = scratch("agate-attacks-lock-");
    const release = takeLock(dir, lockName(USER, "https://testnet-rpc.monad.xyz", false));
    expect(() => takeLock(dir, lockName(USER, "https://testnet-rpc.monad.xyz", false))).toThrow("another run of this key is going");
    const other = takeLock(dir, lockName(A(0x999), "https://testnet-rpc.monad.xyz", false));
    const fork = takeLock(dir, lockName(USER, "http://127.0.0.1:8549", true));
    expect(lockName(USER, "http://127.0.0.1:8549", true)).toBe(`${USER.toLowerCase()}-fork-8549`);
    for (const f of [release, other, fork]) f();
    expect(() => takeLock(dir, lockName(USER, "https://testnet-rpc.monad.xyz", false))()).not.toThrow();
  });

  test("a lock left by a run that died (SIGKILL) is stale and taken over; one held when the process exits (a second Ctrl-C) is removed", async () => {
    const dir = scratch("agate-attacks-lock-");
    const mod = join(import.meta.dir, "..", "..", "e2e", "testnet.ts");
    const killed = Bun.spawn(["bun", "-e", `import { takeLock } from ${JSON.stringify(mod)}; takeLock(${JSON.stringify(dir)}, "k"); await Bun.sleep(30_000);`], { stdout: "ignore", stderr: "ignore" });
    const file = join(dir, "k.pid");
    for (let i = 0; i < 200 && !existsSync(file); i++) await Bun.sleep(50);
    expect(existsSync(file)).toBe(true);
    expect(() => takeLock(dir, "k")).toThrow("another run of this key is going");
    killed.kill("SIGKILL");
    await killed.exited;
    expect(existsSync(file)).toBe(true);
    takeLock(dir, "k")();
    expect(existsSync(file)).toBe(false);
    // process.exit (what the second Ctrl-C does, and SIGTERM in run.ts) runs the exit hook
    const exited = Bun.spawnSync(["bun", "-e", `import { takeLock } from ${JSON.stringify(mod)}; takeLock(${JSON.stringify(dir)}, "e"); process.exit(130);`], { stdout: "ignore", stderr: "pipe" });
    expect(exited.exitCode).toBe(130);
    expect(existsSync(join(dir, "e.pid"))).toBe(false);
  });

  test("the CLI: a second run of the same key exits 2 while the first lives; Ctrl-C twice, or SIGTERM, ends a run with its lock removed", async () => {
    // a fake JSON-RPC node on the loopback (no anvil): an anvil fork of chain 10143 to the fork gate, then it never
    // answers, so a run holds its lock in its preflight until it is stopped
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const { id, method } = (await req.json()) as { id: number; method: string };
        if (method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id, result: "0x279f" });
        if (method === "anvil_nodeInfo") return Response.json({ jsonrpc: "2.0", id, result: { forkConfig: { forkBlockNumber: 5 } } });
        return new Promise<Response>(() => {});
      },
    });
    const home = scratch("agate-attacks-home-");
    const rpc = `http://127.0.0.1:${server.port}`;
    const argv = ["bun", "run", join(import.meta.dir, "..", "..", "e2e", "run.ts"), "testnet", "--i-mean-testnet", "--allow-fork", "--rpc", rpc, "--deployments", files().deployments, "--no-indexer"];
    // a literal (throwaway) key is accepted only on a loopback fork with --allow-fork
    const env = { PATH: process.env.PATH ?? "", HOME: home, AGATE_E2E_KEY_CMD: `printf ${KEY}` };
    const lock = join(home, ".agate-e2e", "locks", `${lockName(USER, rpc, true)}.pid`);
    const waitLock = async () => {
      for (let i = 0; i < 400 && !existsSync(lock); i++) await Bun.sleep(50);
      expect(existsSync(lock)).toBe(true);
    };
    try {
      const first = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
      await waitLock();
      const second = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
      expect(await second.exited).toBe(2);
      const out2 = await new Response(second.stdout).text();
      expect(out2).toContain("another run of this key is going");
      expect(has(out2 + (await new Response(second.stderr).text()), KEY_HEX, KEY_DEC)).toBe(false);
      expect(existsSync(lock)).toBe(true);
      first.kill("SIGINT");
      await Bun.sleep(300);
      first.kill("SIGINT");
      expect(await first.exited).toBe(130);
      expect(existsSync(lock)).toBe(false);
      const out1 = await new Response(first.stdout).text();
      expect(out1).toContain("FORK at");
      expect(out1).toContain("finishing the step in progress, then stopping");
      expect(has(out1 + (await new Response(first.stderr).text()), KEY_HEX, KEY_DEC)).toBe(false);
      const third = Bun.spawn(argv, { env, stdout: "ignore", stderr: "ignore" });
      await waitLock();
      third.kill("SIGTERM");
      expect(await third.exited).toBe(143);
      expect(existsSync(lock)).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("a lock file that is not a lock (garbage, no pid) is stale; nothing is left behind but the held lock", () => {
    const dir = scratch("agate-attacks-lock-");
    writeFileSync(join(dir, "g.pid"), "not json");
    const release = takeLock(dir, "g");
    expect(JSON.parse(readFileSync(join(dir, "g.pid"), "utf8")).pid).toBe(process.pid);
    expect(Bun.spawnSync(["ls", dir], { stdout: "pipe" }).stdout.toString().trim()).toBe("g.pid");
    release();
    expect(existsSync(join(dir, "g.pid"))).toBe(false);
  });

  test("a key with a transaction still pending (pending nonce above latest) is refused, and its lock released", async () => {
    const dir = scratch("agate-attacks-lock-");
    const r = await run(base(files().deployments), ENV, fakeChain({ nonce: 7, pending: 8 }), () => KEY, { lockDir: dir });
    expect(r.code).toBe(2);
    expect(r.out).toContain("1 transaction still pending (nonce 7 landed, 8 with the pending ones)");
    expect(r.sent).toEqual([]);
    expect(Bun.spawnSync(["ls", dir], { stdout: "pipe" }).stdout.toString().trim()).toBe("");
  });

  test("an RPC that refuses the pending tag: the run goes on and says the lock is the only guard", async () => {
    const r = await run(base(files().deployments), ENV, fakeChain({ nonce: 3, pending: null }));
    expect(r.out).toContain("does not answer");
    expect(r.out).toContain("pending nonce: only the lock rules out another run of this key");
    expect(r.out).toContain("spend plan on dH100-NOV26");
    expect(r.sent).toEqual([]);
  });
});

// ------------------------------------------------------------------ which month

describe("which month: a rerun after a finished journey stays on its month", () => {
  const SER_NOV = A(0x5e01), SER_DEC = A(0x5e02);
  const series = [
    { gpu: "H100", month: "2026-11", address: SER_NOV.toLowerCase() },
    { gpu: "H100", month: "2026-12", address: SER_DEC.toLowerCase() },
    { gpu: "H100", month: "2027-01", address: A(0) },
  ];
  /** a client and a chain where the key has a finished November (no position left) and December is current */
  function world(o: { gql?: { rows: string[]; block: number } | null; logs?: { series: string; block: bigint }[]; held?: string[] } = {}) {
    const scans: [bigint, bigint][] = [];
    const c = {
      gql: o.gql ? { url: "http://127.0.0.1:1/v1/graphql", query: async () => ({ RouterFlow: o.gql!.rows.map((s) => ({ series_id: s })), chain_metadata: [{ latest_processed_block: o.gql!.block }] }) } : null,
      router: RT,
      getSeries: async () => series,
      getWallet: async () => ({ positions: (o.held ?? []).map((m) => ({ gpu: "H100", month: m })) }),
      currentMonth: async () => monthOfLabel("2026-12"),
    } as unknown as AgateClient;
    const pub = {
      getBlockNumber: async () => 250n,
      getLogs: async (q: { args: { user: string }; fromBlock: bigint; toBlock: bigint }) => {
        scans.push([q.fromBlock, q.toBlock]);
        expect(q.args.user).toBe(USER);
        return (o.logs ?? []).filter((x) => x.block >= q.fromBlock && x.block <= q.toBlock).map((x) => ({ args: { user: USER, series: x.series }, transactionHash: `0x${"cd".repeat(32)}`, blockNumber: x.block }));
      },
    } as unknown as PublicClient;
    return { c, pub, scans };
  }
  const args = (w: ReturnType<typeof world>, more: string[] = []) => ({ c: w.c, pub: w.pub, user: USER as Address, gpu: "H100" as const, month: null, o: parseTestnetArgs(base(files().deployments, more), ENV), factory: FAC as Address, fork: false, startBlock: 10n, log: () => {} });

  test("chooseMonth: --month wins; else the newest month held or journeyed; the current month only for a key with no journey", () => {
    expect(chooseMonth({ given: "2027-01", held: ["2026-11"], journeyed: ["2026-12"], current: "2026-12" }).month).toBe("2027-01");
    expect(chooseMonth({ given: null, held: [], journeyed: ["2026-11"], current: "2026-12" }).month).toBe("2026-11");
    expect(chooseMonth({ given: null, held: ["2026-11"], journeyed: ["2026-12", "2026-10"], current: "2027-01" }).month).toBe("2026-12");
    const fresh = chooseMonth({ given: null, held: [], journeyed: [], current: "2026-12" });
    expect(fresh.month).toBe("2026-12");
    expect(fresh.why).toContain("no journey");
  });

  test("from the chain's Routed logs (no indexer): the finished November, not December, scanned from the factory's start block", async () => {
    const w = world({ logs: [{ series: SER_NOV, block: 120n }] });
    expect(await journeyMonths(w.c, w.pub, USER, "H100", 10n)).toEqual(["2026-11"]);
    expect(w.scans[0]![0]).toBe(10n);
    expect(w.scans.at(-1)![1]).toBe(250n);
    const r = await pickMonth(args(w));
    expect(r.month).toBe("2026-11");
    expect(r.why).toContain("another month needs --month");
  });

  test("from the indexer's rows, then the logs above its block; a flow on a series of another factory or GPU does not count", async () => {
    const w = world({ gql: { rows: [SER_NOV.toLowerCase(), A(0x777)], block: 200 }, logs: [{ series: SER_DEC, block: 90n }] });
    expect(await journeyMonths(w.c, w.pub, USER, "H100", 10n)).toEqual(["2026-11"]);
    expect(w.scans[0]![0]).toBe(201n);
    const w2 = world({ gql: { rows: [], block: 200 }, logs: [{ series: SER_DEC, block: 230n }] });
    expect(await journeyMonths(w2.c, w2.pub, USER, "H100", 10n)).toEqual(["2026-12"]);
  });

  test("from a previous run's --report file: its month when it is this key's, factory's, GPU's and chain's; not another's", async () => {
    const { dir } = files();
    const report = join(dir, "earlier.json");
    const rep = (o: Record<string, unknown>) => writeFileSync(report, JSON.stringify({ mode: "testnet", user: USER, factoryAddress: FAC, gpu: "H100", fork: false, month: "2026-11", ...o }));
    const w = { user: USER, factory: FAC, gpu: "H100" as const, fork: false };
    rep({});
    expect(monthFromReport(report, w)).toBe("2026-11");
    expect(monthFromReport(report, { ...w, user: USER.toLowerCase(), factory: FAC.toUpperCase().replace("0X", "0x") })).toBe("2026-11");
    for (const o of [{ user: A(0x999) }, { factoryAddress: PFAC }, { gpu: "H200" }, { fork: true }, { month: null }, { month: "2026-13" }, { mode: "fork" }]) {
      rep(o);
      expect(monthFromReport(report, w)).toBeNull();
    }
    writeFileSync(report, "{ not json");
    expect(monthFromReport(report, w)).toBeNull();
    expect(monthFromReport(join(dir, "none.json"), w)).toBeNull();
    expect(monthFromReport(null, w)).toBeNull();
    // with nothing on chain, the report alone keeps the rerun on November
    rep({});
    const r = await pickMonth(args(world(), ["--report", report]));
    expect(r.month).toBe("2026-11");
  });

  test("the report the mode itself writes is one it reads back (redacted, as written)", async () => {
    const { deployments, dir } = files();
    const report = join(dir, "run.json");
    await run(base(deployments, ["--report", report]), ENV);
    expect(monthFromReport(report, { user: USER, factory: FAC, gpu: "H100", fork: false })).toBe("2026-11");
  });

  test("a key with no journey on this factory takes the current month; --month always wins; a held month is resumed", async () => {
    expect((await pickMonth(args(world()))).month).toBe("2026-12");
    expect((await pickMonth({ ...args(world({ logs: [{ series: SER_NOV, block: 120n }] })), month: "2027-01" })).month).toBe("2027-01");
    expect((await pickMonth(args(world({ held: ["2026-12"], logs: [{ series: SER_NOV, block: 120n }] })))).month).toBe("2026-12");
  });
});

// ------------------------------------------------------------------ the session report's words

describe("the session report says what it could not read", () => {
  test("a slice read that failed is 'read failed', never -1", () => {
    expect(slicesText([4, 4, 4, 4, 4, 4])).toBe("4 each");
    expect(slicesText([null, null, null, null, null, null])).toBe("read failed");
    expect(slicesText([4, 4, null, 3, 4, 4])).toBe("4 4 (read failed) 3 4 4");
    for (const s of [[null, 4], [4, null], [null, null]]) expect(slicesText(s)).not.toContain("-1");
  });

  test("--no-indexer: the indexer is 'not used', and the claims say why they are not read", () => {
    expect(indexerText(null, false, null, 100n)).toBe("indexer not used (--no-indexer)");
    expect(indexerText("http://localhost:8080/v1/graphql", false, null, 100n)).toBe("indexer http://localhost:8080/v1/graphql: does not answer");
    expect(indexerText("http://localhost:8080/v1/graphql", true, 90n, 100n)).toBe("indexer http://localhost:8080/v1/graphql: answers, processed block 90 (10 behind)");
    expect(claimsWithoutText(null, false)).toContain("not used here (--no-indexer)");
    expect(claimsWithoutText("http://localhost:8080/v1/graphql", false)).toContain("does not answer");
    expect(claimsWithoutText("http://localhost:8080/v1/graphql", true)).toBe("no listed series yet");
    const src = readFileSync(join(import.meta.dir, "..", "..", "e2e", "session-report.ts"), "utf8");
    expect(src).not.toContain(": -1)");
    expect(src).not.toContain('"(none)"');
  });
});

describe("the docs say what the mode does", () => {
  test("README and run.ts: nothing the key command writes is shown; Ctrl-C finishes the step in progress, then stops", () => {
    const readme = readFileSync(join(import.meta.dir, "..", "..", "README.md"), "utf8");
    const runTs = readFileSync(join(import.meta.dir, "..", "..", "e2e", "run.ts"), "utf8");
    expect(readme).toContain("nothing the command writes is shown, on stdout or stderr, even when it fails");
    expect(readme).toContain("Ctrl-C finishes the step in progress");
    expect(readme).toContain("a new month for that key needs an");
    expect(readme).not.toContain("stops after the transaction in flight");
    expect(readme).not.toContain("last stderr line");
    expect(runTs).toContain("finishing the step in progress, then stopping");
    expect(runTs).not.toContain("stopping after the transaction in flight");
  });
});

describe("no test of this file reached for the network", () => {
  test("every fetch went to the loopback", () => {
    expect(fetched.filter((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u))).toEqual([]);
  });
});
