// Recheck r2 (Oct 4): a second independent pass over the testnet mode's gates after fixer round 1 (check.md findings 1
// to 7, check-r1.md findings 2 and 11). New angles only: loopback spellings neither earlier pass tried (zero-padded,
// whole-number octal, percent-encoded digits), arguments in --option=value form, a key command that floods its
// output, the stale-lock race with a garbage lock file and twice the racers, and a live holder raced by many runs.
// No network: local processes and temp folders only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Hex, keccak256, toHex } from "viem";
import { isLoopback, redactUrl } from "../../../e2e/fork.ts";
import { GateError, parseTestnetArgs, redact, runKeyCommand, runTestnet, takeLock } from "../../../e2e/testnet.ts";

const KEY = keccak256(toHex("agate recheck r2 user")) as Hex;
const HEX = KEY.slice(2);
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
const ENV = { AGATE_E2E_KEY_CMD: "security find-generic-password -s agate.e2e.recheck-r2 -a private-key -w" };
const gate = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(GateError);
    return (e as Error).message;
  }
  throw new Error("not refused");
};

describe("check.md finding 1 (r2): more spellings of this machine are loopback and refused without --allow-fork", () => {
  const LOOP = [
    "http://127.000.000.001:8549", // zero-padded parts read as octal 0
    "http://0177.0.0.1:8549",
    "http://0177.1:8549",
    "http://017700000001:8549", // the whole address in octal
    "http://0x7F000001:8549",
    "http://2130706433:8549",
    "http://127.255.255.254:8549",
    "http://%31%32%37.0.0.1:8549", // percent-encoded digits
    "http://localhost%2e:8549", // a percent-encoded trailing dot
    "http://LocalHost.:8549",
    "http://foo.LOCALHOST:8549",
    "http://[0:0:0:0:0:ffff:7f00:0001]:8549",
    "http://[::ffff:127.1.2.3]:8549",
    "http://[::]:8549",
    "http://0:8549",
    "HTTP://127.0.0.1:8549", // the scheme in capitals
  ];
  for (const u of LOOP) {
    test(`${u}: loopback, refused without --allow-fork, shown only by scheme, host and port`, () => {
      let parsed = true;
      try {
        new URL(u);
      } catch {
        parsed = false;
      }
      if (!parsed) {
        expect(gate(() => parseTestnetArgs(["--i-mean-testnet", "--rpc", u], ENV))).toContain("not an http(s) URL");
        return;
      }
      expect({ u, loop: isLoopback(u) }).toEqual({ u, loop: true });
      const m = gate(() => parseTestnetArgs(["--i-mean-testnet", "--rpc", u], ENV));
      expect(m).toContain("loopback");
      expect(m).toContain("nothing was read or sent");
    });
  }

  test("each of them, with a literal key in the key command: refused without --allow-fork (the loopback refusal comes first)", () => {
    for (const u of LOOP) {
      if (!URL.canParse(u)) continue;
      const m = gate(() => parseTestnetArgs(["--i-mean-testnet", "--rpc", u], { AGATE_E2E_KEY_CMD: `printf ${KEY}` }));
      expect(m).toContain("loopback");
      expect(leaks(m)).toBe(false);
    }
  });

  test("public names that only look local stay public (a DNS name is left to the anvil_nodeInfo probe)", () => {
    for (const u of ["http://127.0.0.1.nip.io:8549", "http://localhost.example.com:8549", "http://[::2]:8549", "http://126.255.255.255:8549", "http://128.0.0.1:8549", "https://testnet-rpc.monad.xyz", "http://localhost-8549.monad.xyz"]) {
      expect({ u, loop: isLoopback(u) }).toEqual({ u, loop: false });
    }
  });
});

describe("check.md findings 2 and 3 (r2): a key in --option=value form, or flooding the key command's output, is never shown", () => {
  test("--option=value arguments holding the key, glued to hex or not: refused before parsing, the argument not shown", () => {
    const shapes = [KEY, HEX, `${HEX}ab`, `ab${HEX}`, `0X${HEX.toUpperCase()}`, `${BigInt(KEY)}`.padStart(78, "1")];
    for (const opt of ["report", "month", "rpc", "gpu", "graphql", "deployments", "from-block", "max-dollars"]) {
      for (const s of shapes) {
        const arg = opt === "rpc" || opt === "graphql" ? `--${opt}=https://x.example/${s}` : `--${opt}=${s}`;
        if (!/[0-9a-fA-F]{64}/.test(arg)) continue;
        const m = gate(() => parseTestnetArgs(["--i-mean-testnet", arg], ENV));
        expect(m).toContain("64 hex digits");
        expect(leaks(m)).toBe(false);
      }
    }
  });

  test("runTestnet with such an argument: exit 2, and no line shows any part of the key", async () => {
    const lines: string[] = [];
    const code = await runTestnet(["--i-mean-testnet", `--report=/tmp/${HEX}.json`], ENV, { log: (s) => void lines.push(s) });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("64 hex digits");
    expect(leaks(lines.join("\n"))).toBe(false);
  });

  test("a key command that floods stdout and stderr with the key glued to hex, then fails: only its exit code is shown", () => {
    const dir = scratch("agate-recheck-r2-flood-");
    const script = join(dir, "flood.sh");
    writeFileSync(script, `i=0; while [ $i -lt 2000 ]; do printf 'ff${HEX}ee\\n'; printf 'x0x${HEX.toUpperCase()}y\\n' >&2; i=$((i+1)); done; exit 7\n`);
    const m = gate(() => runKeyCommand(`/bin/sh ${script}`, {}));
    expect(m).toContain("exit 7");
    expect(leaks(m)).toBe(false);
  });

  test("redact hides the key glued to anything, in upper or mixed case, and a run of 65 to 200 digits whole", () => {
    for (const s of [`a${HEX}`, `${HEX.toUpperCase()}z`, `0x${HEX}${HEX}`, `${HEX.slice(0, 32).toUpperCase()}${HEX.slice(32)}`, `[${HEX}0]`, "9".repeat(80)]) {
      const r = redact(`before ${s} after`);
      expect(leaks(r)).toBe(false);
      expect(/[0-9a-fA-F]{64}/.test(r)).toBe(false);
    }
  });

  test("redactUrl never shows a path, a query, a fragment or user info", () => {
    expect(redactUrl("https://u:p4ssw0rdp4ssw0rd@rpc.example:8443/v2/abcdef0123456789abcdef?key=zz#frag")).toBe("https://rpc.example:8443/...");
    expect(redactUrl("https://monad-testnet.g.alchemy.com/v2/FAKEfakeFAKEfakeFAKEfakeFAKEfake")).toBe("https://monad-testnet.g.alchemy.com/...");
    expect(redactUrl("not a url FAKEfakeFAKEfakeFAKEfakeFAKEfake")).toBe("<url>");
  });
});

describe("check.md finding 4 (r2): one live run per key", () => {
  const CHILD = join(import.meta.dir, "lock-child.ts");

  async function race(dir: string, name: string, n: number, holdMs: number): Promise<string[]> {
    const at = Date.now() + 1_500;
    const procs = Array.from({ length: n }, () => Bun.spawn(["bun", "run", CHILD, dir, name, String(at), String(holdMs)], { stdout: "pipe", stderr: "pipe" }));
    return Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
  }

  test("a garbage lock file (no pid): 16 runs started at the same millisecond, exactly one wins, 10 rounds", async () => {
    const dir = scratch("agate-recheck-r2-lock-");
    const tally: number[] = [];
    for (let r = 0; r < 10; r++) {
      writeFileSync(join(dir, "k.pid"), "not json at all");
      const out = await race(dir, "k", 16, 800);
      tally.push(out.filter((x) => x === "won").length);
      expect(out.every((x) => x === "won" || x === "held" || x === "refused")).toBe(true);
    }
    expect(tally).toEqual(Array(10).fill(1));
    // nothing left behind: no lock, no temp file, no takeover guard
    expect(readdirSync(dir)).toEqual([]);
  }, 180_000);

  test("a live holder: 16 runs started at the same millisecond are all refused, and the holder's lock stays its own", async () => {
    const dir = scratch("agate-recheck-r2-held-");
    const release = takeLock(dir, "k");
    try {
      const out = await race(dir, "k", 16, 100);
      expect(out).toEqual(Array(16).fill("held"));
      expect(existsSync(join(dir, "k.pid"))).toBe(true);
    } finally {
      release();
    }
    expect(readdirSync(dir)).toEqual([]);
  }, 60_000);
});
