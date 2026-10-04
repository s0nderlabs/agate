// Recheck r1 (Oct 4): an independent pass over the fixes to live-check-20261004/check.md findings 1 to 5 in the testnet
// mode (e2e/testnet.ts, e2e/fork.ts). Spellings of this machine the builder's list does not hold, and public names
// that must stay public; a key glued to other hex digits in every option and in a failing key command's output; the
// redaction; the per-key lock raced by many processes at the same millisecond, with and without a stale lock; and what
// the mode prints of an --rpc URL that carries a provider key. No network: a fake transport, local processes only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { custom, type Hex, keccak256, toHex } from "viem";
import { isLoopback } from "../../../e2e/fork.ts";
import { accountFromCommand, GateError, knownHash, parseTestnetArgs, redact, runKeyCommand, runTestnet, takeLock } from "../../../e2e/testnet.ts";

const KEY = keccak256(toHex("agate recheck r1 user")) as Hex;
const HEX = KEY.slice(2);
/** every 16-digit window of the key: none may appear anywhere we print */
const FRAGMENTS = Array.from({ length: 64 - 15 }, (_, i) => HEX.slice(i, i + 16).toLowerCase());
const leaks = (s: string) => FRAGMENTS.some((f) => s.toLowerCase().includes(f)) || s.includes(BigInt(KEY).toString().slice(0, 20));
const made: string[] = [];
const scratch = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const ENV = { AGATE_E2E_KEY_CMD: "security find-generic-password -s agate.e2e.recheck -a private-key -w" };
const gate = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(GateError);
    return (e as Error).message;
  }
  throw new Error("not refused");
};

// ------------------------------------------------------------------ finding 1: the loopback gate

describe("finding 1: every spelling of this machine is loopback, every public name is not", () => {
  const LOOP = [
    "http://[::ffff:7f00:1]:8549",
    "http://[::127.0.0.1]:8549",
    "http://[0::1]:8549",
    "http://[0000:0000:0000:0000:0000:0000:0000:0001]:8549",
    "http://[::ffff:0.0.0.0]:8549",
    "http://0x7f.0x0.0x0.0x1:8549",
    "http://0x7f.1:8549",
    "http://127.0.1:8549",
    "http://0.0.0.0.:8549",
    "http://0x0:8549",
    "http://00000:8549",
    "http://127.0.0.1.:8549",
    "https://LOCALHOST:8549",
    "http://a.b.localhost:8549",
    "http://localhost.localhost.:8549",
    "http://\u{FF4C}\u{FF4F}\u{FF43}\u{FF41}\u{FF4C}\u{FF48}\u{FF4F}\u{FF53}\u{FF54}:8549", // fullwidth letters
    "http://\u{FF11}\u{FF12}\u{FF17}.\u{FF10}.\u{FF10}.\u{FF11}:8549", // fullwidth digits
    "http://127。0。0。1:8549", // ideographic full stops
  ];
  for (const u of LOOP) {
    test(`${JSON.stringify(u)} is loopback, or not an URL the mode takes`, () => {
      let host = "";
      try {
        host = new URL(u).hostname;
      } catch {
        host = "(no URL)";
      }
      if (host === "(no URL)") {
        // the mode refuses what does not parse
        expect(gate(() => parseTestnetArgs(["--i-mean-testnet", "--rpc", u], ENV))).toContain("not an http(s) URL");
        return;
      }
      expect({ u, host, loop: isLoopback(u) }).toEqual({ u, host, loop: true });
      expect(gate(() => parseTestnetArgs(["--i-mean-testnet", "--rpc", u], ENV))).toContain("loopback");
    });
  }

  const PUBLIC = [
    "https://testnet-rpc.monad.xyz",
    "https://10143.rpc.thirdweb.com",
    "https://rpc.ankr.com/monad_testnet",
    "http://[::ffff:8.8.8.8]:8549",
    "http://[::2]:8549",
    "http://[fe80::1]:8549",
    "http://126.255.255.255:8549",
    "http://128.0.0.1:8549",
    "http://0x80000001:8549",
    "http://localhostx:8549",
    "http://xlocalhost:8549",
    "http://localhost.monad.xyz:8549",
    "http://127.0.0.1.monad.xyz:8549",
    "http://monad.xyz/127.0.0.1",
    "http://monad.xyz?h=localhost",
    "http://127.0.0.1@monad.xyz:8549",
    "http://localhost:8549@monad.xyz",
  ];
  for (const u of PUBLIC) {
    test(`${JSON.stringify(u)} is not loopback (no literal key, no time travel there)`, () => {
      expect({ u, loop: isLoopback(u) }).toEqual({ u, loop: false });
      const o = parseTestnetArgs(["--i-mean-testnet", "--rpc", u], ENV);
      expect(o.allowFork).toBe(false);
      expect(gate(() => parseTestnetArgs(["--i-mean-testnet", "--allow-fork", "--time-travel", "--rpc", u], ENV))).toContain("--time-travel");
      expect(gate(() => parseTestnetArgs(["--i-mean-testnet", "--allow-fork", "--rpc", u], { AGATE_E2E_KEY_CMD: `printf %s ${KEY}` }))).toContain("literally");
    });
  }

  test("a loopback URL mixed into a list with a public one is refused, in either order and either spelling", () => {
    for (const rpc of ["https://testnet-rpc.monad.xyz,http://LOCALHOST:8549", "http://[::1]:8549,https://testnet-rpc.monad.xyz"]) {
      expect(gate(() => parseTestnetArgs(["--i-mean-testnet", "--allow-fork", "--rpc", rpc], ENV))).toContain("never mixed");
    }
  });
});

// ------------------------------------------------------------------ findings 2 and 3: a key glued to hex digits

describe("findings 2 and 3: a key glued to other hex digits is never shown", () => {
  const FLAGS = ["rpc", "graphql", "deployments", "indexes", "factory", "gpu", "month", "max-dollars", "min-mon", "stop-after", "report", "from-block", "listing-wait-min", "claim-wait-min"];
  const SHAPES = [`${HEX}ab`, `ab${HEX}`, `0x${HEX}ff`, `0X${HEX.toUpperCase()}`, `x/${HEX}/y`, `https://x.example/ab${HEX}`, BigInt(KEY).toString(), `${HEX}${HEX}`, `--month=${HEX}`];
  test("every option, every shape, with --flag value and as a bare argument: refused, the argument not shown", () => {
    let n = 0;
    for (const f of FLAGS) {
      for (const v of SHAPES) {
        for (const argv of [["--i-mean-testnet", `--${f}`, v], [`--${f}`, v, "--i-mean-testnet"], ["--i-mean-testnet", v]]) {
          const m = gate(() => parseTestnetArgs(argv, ENV));
          expect(m).toContain("64 hex digits");
          expect(leaks(m)).toBe(false);
          n++;
        }
      }
    }
    expect(n).toBe(FLAGS.length * SHAPES.length * 3);
  });

  test("a failing key command: stdout and stderr are never shown, whatever they hold, and a signal says only its name", () => {
    const cmds = [
      `printf '0x%sff' ${HEX} >&2; exit 1`,
      `printf 'abc%s' ${HEX} >&2; exit 3`,
      `printf '%s%s' ${HEX.slice(0, 32)} ${HEX.slice(32)}; printf 'error near %s\\n' ${HEX} >&2; exit 1`,
      `printf '%s' ${HEX.toUpperCase()}; exit 1`,
      `printf 'k=%s' ${BigInt(KEY).toString()} >&2; kill -9 $$`,
    ];
    for (const c of cmds) {
      const m = gate(() => runKeyCommand(c, {}));
      expect(m).toMatch(/AGATE_E2E_KEY_CMD failed \((exit \d+|stopped by SIG[A-Z]+)\)/);
      expect(leaks(m)).toBe(false);
    }
  });

  test("a key command that prints more than one key, or a key with other text, or an invalid key: refused, nothing shown", () => {
    const outs = [`${KEY}\n${KEY}`, `key: ${KEY}`, `${KEY} `.repeat(2), `0x${"f".repeat(64)}`, `0x${"0".repeat(64)}`, `${HEX}00`];
    for (const o of outs) {
      const m = gate(() => accountFromCommand("x", {}, () => o));
      expect(leaks(m)).toBe(false);
      expect(m).not.toContain("f".repeat(16));
    }
  });

  test("redact hides every run of 64 or more hex digits but a known transaction hash of exactly 64", () => {
    const h = keccak256(toHex("a transaction of this run"));
    knownHash(h);
    const s = redact(`a ${KEY} b ${HEX.toUpperCase()}ff c 0x${HEX}${h.slice(2)} d ${BigInt(KEY).toString()} e ${h} f ${h.slice(2)}0`);
    expect(leaks(s)).toBe(false);
    expect(s).toContain(h); // the known hash alone is shown
    expect(s.split("[64+ hex digits hidden]").length - 1).toBe(5);
  });

  // INFO (recheck r1), fixed: a key split across two arguments was echoed half by half (each half 32 digits, under the
  // 64-digit rule). Every run of 16 or more hex digits of the arguments is now hidden from every refusal and line.
  test("a key split across two arguments: no half is shown, in a refusal that quotes the value or in a later line", () => {
    const [h1, h2] = [HEX.slice(0, 32), HEX.slice(32)];
    for (const argv of [["--i-mean-testnet", "--month", h1, "--gpu", h2], ["--i-mean-testnet", "--gpu", h2], ["--i-mean-testnet", "--factory", `x${h1}`], ["--i-mean-testnet", h2], ["--i-mean-testnet", "--min-mon", `1.${BigInt(KEY).toString().slice(0, 40)}`]]) {
      const m = gate(() => parseTestnetArgs(argv, ENV));
      expect({ argv: argv.length, leaks: leaks(m) }).toEqual({ argv: argv.length, leaks: false });
      expect(m).not.toContain(h1);
      expect(m).not.toContain(h2);
    }
    // a value no check refuses (a file path) is hidden from the lines after parsing too, any case
    parseTestnetArgs(["--i-mean-testnet", "--report", `/tmp/${h1}/r.json`, "--deployments", `/tmp/${h2.toUpperCase()}.json`], ENV);
    const line = redact(`the report /tmp/${h1}/r.json; refused: /tmp/${h2.toUpperCase()}.json cannot be read; ${h2}`);
    expect(leaks(line)).toBe(false);
  });
});

// ------------------------------------------------------------------ finding 4: one run per key, raced

async function race(n: number, stale: boolean): Promise<string[]> {
  const dir = scratch("agate-recheck-r1-locks-");
  const name = "0xrecheck";
  if (stale) writeFileSync(join(dir, `${name}.pid`), JSON.stringify({ pid: 2_147_483_000, startedAt: "2026-10-04T00:00:00Z" }));
  const at = Date.now() + 1_500;
  const ps = Array.from({ length: n }, () => Bun.spawn(["bun", "run", join(import.meta.dir, "lock-child.ts"), dir, name, String(at), "1500"], { stdout: "pipe", stderr: "pipe" }));
  const outs = await Promise.all(ps.map(async (p) => (await new Response(p.stdout).text()).trim()));
  await Promise.all(ps.map((p) => p.exited));
  expect(existsSync(join(dir, `${name}.pid`))).toBe(false); // the winner released it
  return outs;
}

describe("finding 4: one live run per key, raced by processes started at the same millisecond", () => {
  test("no lock before: exactly one of 8 wins, every time (5 rounds)", async () => {
    for (let r = 0; r < 5; r++) {
      const outs = await race(8, false);
      expect(outs.filter((o) => o === "won").length).toBe(1);
      expect(outs.every((o) => o === "won" || o === "held")).toBe(true);
    }
  }, 120_000);

  // fixer r1: this test saw 2 winners of 8 in one round of 5 (wins [1,1,2,1,1]): two runs both found the lock stale and
  // the second removed the first one's new lock. The takeover now runs under a guard (testnet.ts takeOver), so a round
  // has exactly one winner; 10 rounds.
  test("a stale lock before (a dead pid): exactly one of 8 wins and the rest are refused, every time (10 rounds)", async () => {
    const wins: number[] = [];
    for (let r = 0; r < 10; r++) {
      const outs = await race(8, true);
      wins.push(outs.filter((o) => o === "won").length);
      expect(outs.every((o) => o === "won" || o === "held" || o === "refused")).toBe(true);
    }
    console.log(JSON.stringify({ recheck: "stale-lock race, winners per round of 8", wins }));
    expect(wins).toEqual(Array(10).fill(1));
  }, 240_000);

  test("a takeover guard left by a run that died mid-takeover: refused while fresh, removed once old, then taken", () => {
    const dir = scratch("agate-fixer-r1-guard-");
    writeFileSync(join(dir, "g.pid"), JSON.stringify({ pid: 2_147_483_000, startedAt: "2026-10-04T00:00:00Z" }));
    mkdirSync(join(dir, "g.pid.takeover"));
    expect(gate(() => takeLock(dir, "g"))).toContain("changed hands");
    expect(existsSync(join(dir, "g.pid.takeover"))).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "g.pid.takeover"), old, old);
    expect(gate(() => takeLock(dir, "g"))).toContain("changed hands");
    expect(existsSync(join(dir, "g.pid.takeover"))).toBe(false);
    const release = takeLock(dir, "g");
    expect(JSON.parse(readFileSync(join(dir, "g.pid"), "utf8")).pid).toBe(process.pid);
    release();
    expect(existsSync(join(dir, "g.pid"))).toBe(false);
  });
});

// ------------------------------------------------------------------ an --rpc URL with a provider key

describe("an --rpc URL that carries a provider key (B secrets, client side)", () => {
  // a made-up key in Alchemy's shape (32 characters), not a real one
  const ALCHEMY = "https://monad-testnet.g.alchemy.com/v2/Zx9fQm2LkT7vWp4RbN8cYd3HsJ6gAe1U";
  test("is accepted as testnet (not loopback)", () => {
    const o = parseTestnetArgs(["--i-mean-testnet", "--rpc", ALCHEMY], ENV);
    expect(o.rpc).toBe(ALCHEMY);
  });
  // FINDING (recheck r1, LOW), fixed: the mode printed its --rpc URLs whole ("MONAD TESTNET through <url>", "refused:
  // <url> answers chain ...") and wrote them to the --report file; a provider URL's key (32 characters, under the
  // 64-digit redaction) went with them. Now only the URL's scheme, host and port are shown and written.
  test("the key in an --rpc URL never reaches the output or the report", async () => {
    const dir = scratch("agate-recheck-r1-rpc-");
    const dep = join(dir, "10143.json");
    const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    writeFileSync(dep, JSON.stringify({ chainId: 10143, dollar: A(0xd1), kuru: { router: A(0xc1), marginAccount: A(0xc2) }, factories: { demo: { index: A(0xa1), factory: A(0xf1), router: A(0xb1), dollar: A(0xd1), tag: "demo", tPend: 210, startBlock: 10 } } }));
    writeFileSync(join(dir, "10143-indexes.json"), JSON.stringify({ chainId: 10143, demo: { index: A(0xa1), session: "active", deployBlock: 9 } }));
    const report = join(dir, "report.json");
    const lines: string[] = [];
    // the provider answers another chain: refused at once, before the key command
    const transport = () => custom({ request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0x1" : null) });
    const code = await runTestnet(["--i-mean-testnet", "--rpc", ALCHEMY, "--deployments", dep, "--no-indexer", "--report", report], ENV, { transport, log: (s) => lines.push(s), lockDir: dir, runKeyCommand: () => KEY });
    expect(code).toBe(2);
    const all = `${lines.join("\n")}\n${readFileSync(report, "utf8")}`;
    expect(all).not.toContain("Zx9fQm2LkT7vWp4RbN8cYd3HsJ6gAe1U");
    expect(all).toContain("refused: https://monad-testnet.g.alchemy.com/... answers chain 1");
    expect(JSON.parse(readFileSync(report, "utf8")).rpc).toBe("https://monad-testnet.g.alchemy.com/...");
  });

  test("an error that quotes the URL (viem's 'URL: ...' line) reaches neither the output nor the report", async () => {
    const dir = scratch("agate-fixer-r1-rpc-");
    const dep = join(dir, "10143.json");
    const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    writeFileSync(dep, JSON.stringify({ chainId: 10143, dollar: A(0xd1), kuru: { router: A(0xc1), marginAccount: A(0xc2) }, factories: { demo: { index: A(0xa1), factory: A(0xf1), router: A(0xb1), dollar: A(0xd1), tag: "demo", tPend: 210, startBlock: 10 } } }));
    writeFileSync(join(dir, "10143-indexes.json"), JSON.stringify({ chainId: 10143, demo: { index: A(0xa1), session: "active", deployBlock: 9 } }));
    const report = join(dir, "report.json");
    const lines: string[] = [];
    const transport = () =>
      custom({
        request: async () => {
          throw new Error(`HTTP request failed.\n\nStatus: 401\nURL: ${ALCHEMY}\nDetails: Must be authenticated! (key Zx9fQm2LkT7vWp4RbN8cYd3HsJ6gAe1U)`);
        },
      });
    const code = await runTestnet(["--i-mean-testnet", "--rpc", `${ALCHEMY},https://testnet-rpc.monad.xyz`, "--deployments", dep, "--no-indexer", "--report", report], ENV, { transport, log: (s) => lines.push(s), lockDir: dir, runKeyCommand: () => KEY });
    expect(code).toBe(1);
    const all = `${lines.join("\n")}\n${readFileSync(report, "utf8")}`;
    expect(all).toContain("STOPPED");
    expect(all).not.toContain("Zx9fQm2LkT7vWp4RbN8cYd3HsJ6gAe1U");
    expect(all).not.toContain("/v2/");
  });

  test("session-report.ts: an --rpc URL with a key is never printed, even by an error that quotes it", async () => {
    const key = "Zx9fQm2LkT7vWp4RbN8cYd3HsJ6gAe1U";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const j = (await req.json()) as { id: number; method: string };
        if (j.method === "eth_blockNumber") return Response.json({ jsonrpc: "2.0", id: j.id, result: "0x10" });
        return new Response("upstream error", { status: 500 });
      },
    });
    try {
      const dir = scratch("agate-fixer-r1-report-");
      const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
      writeFileSync(join(dir, "d.json"), JSON.stringify({ chainId: 10143, dollar: A(0xd1), factories: {} }));
      writeFileSync(join(dir, "d-indexes.json"), JSON.stringify({ demo: { index: A(0xa1), firstDay: 1, deployBlock: 9 } }));
      const p = Bun.spawn(["bun", "run", join(import.meta.dir, "../../../e2e/session-report.ts"), "--rpc", `http://127.0.0.1:${server.port}/v2/${key}`, "--deployments", join(dir, "d.json"), "--no-indexer", "--state", join(dir, "state")], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(code).toBe(1);
      expect(err).toContain(`http://127.0.0.1:${server.port}/...`);
      expect(`${out}\n${err}`).not.toContain(key);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
