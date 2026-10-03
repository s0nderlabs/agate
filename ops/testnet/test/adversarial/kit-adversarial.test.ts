// Adversarial checks of the testnet kit, offline: every Keychain, tmux and chain tool is a stub in a temp dir, so
// nothing here reads a real secret, opens a real window or sends anything. `bun test ops/testnet/test` (repo root).
//
// - signed(): a failed or malformed Keychain read stops before the signing command runs and never echoes the value;
//   a good one reaches that command's environment only (not its argv, not the output); a stray key in the caller's
//   shell never reaches a read-only forge run.
// - down.sh (real mode, stub tmux): closes only the windows the kit names, by window id, never by index, and never
//   "bun", "wall-log", a look-alike name or a window of another session.
// - the RPC list command up.sh and status.sh give the processes: with a stub Keychain it prints Alchemy first and the
//   public RPC second, the wall's resolver accepts it, and the redacted form hides the API key.
// - indexer.sh run: the RPC URL (with its key) reaches envio's environment only: not its argv, not config.yaml, not
//   the script's output.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const KIT = resolve(import.meta.dir, "../..");
const ROOT = resolve(KIT, "../..");
const FAKE_KEY = `0x${"5a".repeat(32)}`; // shaped like a key, used by no account
const FAKE_API = "FAKEapiKEY0123456789abcdef";

let tmp = "";
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "agate-kit-adv-"));
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function stubDir(name: string, stubs: Record<string, string>): string {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  for (const [tool, body] of Object.entries(stubs)) {
    writeFileSync(join(d, tool), `#!/bin/sh\n${body}\n`);
    chmodSync(join(d, tool), 0o755);
  }
  return d;
}
function sh(cmd: string[], env: Record<string, string>, cwd = ROOT) {
  const r = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

describe("signed(): the Keychain read guards the one signing command", () => {
  // security stub: the attribute query (no -w) succeeds when HAS=1; with -w it prints $VALUE and exits $RC
  const harness = () => {
    const h = join(tmp, "signed-harness.sh");
    writeFileSync(h, `#!/bin/bash\nsource '${KIT}/lib.sh'\nkit_parse\nsigned owner AGATE_OWNER_KEY "$RECORDER" --arg-check\n`);
    const rec = join(tmp, "recorder.sh");
    writeFileSync(rec, `#!/bin/sh\nprintf 'ran argv=%s env=%s\\n' "$*" "\${AGATE_OWNER_KEY:-unset}" > "$REC_OUT"\n`);
    chmodSync(rec, 0o755);
    return { h, rec };
  };
  const security = `case " $* " in *" -w "*) [ "$RC" = 0 ] && printf '%s' "$VALUE"; exit "$RC" ;; *) [ "$HAS" = 1 ] && exit 0; exit 44 ;; esac`;

  const cases: [string, Record<string, string>, boolean][] = [
    ["no 0x prefix", { HAS: "1", RC: "0", VALUE: FAKE_KEY.slice(2) }, false],
    ["63 hex digits", { HAS: "1", RC: "0", VALUE: FAKE_KEY.slice(0, 65) }, false],
    ["the read fails", { HAS: "1", RC: "51", VALUE: "" }, false],
    ["no Keychain item", { HAS: "0", RC: "0", VALUE: FAKE_KEY }, false],
    ["a good key", { HAS: "1", RC: "0", VALUE: FAKE_KEY }, true],
  ];
  for (const [name, v, runs] of cases) {
    test(name, () => {
      const bin = stubDir(`sec-${name.replace(/\W/g, "")}`, { security });
      const { h, rec } = harness();
      const out = join(tmp, `rec-${name.replace(/\W/g, "")}.txt`);
      const r = sh(["/bin/bash", h], { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, RECORDER: rec, REC_OUT: out, ...v });
      expect(r.out).not.toContain(FAKE_KEY.slice(2, 40));
      if (!runs) {
        expect(r.code).not.toBe(0);
        expect(r.out).toContain("nothing sent");
        expect(existsSync(out)).toBe(false);
      } else {
        expect(r.code).toBe(0);
        const got = readFileSync(out, "utf8");
        expect(got).toBe(`ran argv=--arg-check env=${FAKE_KEY}\n`); // in the environment, never in argv
      }
    });
  }

  test("a key left in the caller's shell never reaches a read-only forge run", () => {
    const out = join(tmp, "forge-env.txt");
    const bin = stubDir("forge-env", { forge: `printf '%s' "\${AGATE_OWNER_KEY:-unset}|\${AGATE_DEPLOYER_KEY:-unset}" > '${out}'` });
    const h = join(tmp, "read-harness.sh");
    writeFileSync(h, `#!/bin/bash\nsource '${KIT}/lib.sh'\nkit_parse\nforge_read script/DeployIndex.s.sol --sender 0x016575774F23c2c43Ea1217a080FFC7db61EE681\n`);
    const r = sh(["/bin/bash", h], { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, AGATE_OWNER_KEY: FAKE_KEY, AGATE_DEPLOYER_KEY: FAKE_KEY });
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("unset|unset");
  });
});

describe("down.sh closes only the kit's windows, by id", () => {
  // stub tmux: a session with the operator's windows and the kit's, ids that do not follow indexes, and kills that
  // take a window out of later listings. Records every call.
  const setup = (name: string) => {
    const state = join(tmp, `tmux-${name}`);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "windows"), ["@3 bun", "@4 wall-log", "@17 prod-primary", "@9 prod-primary-old", "@21 shared-maker", "@6 main", "@30 prod log"].join("\n") + "\n");
    writeFileSync(join(state, "other"), "@40 prod-standby\n");
    const tmux = `echo "$*" >> '${state}/calls'
case "$1" in
  list-windows)
    case "$3" in "=agate-dev") cat '${state}/windows' ;; *) cat '${state}/other' ;; esac ;;
  display-message) echo 1 ;;
  kill-window) grep -v "^$3 " '${state}/windows' > '${state}/w2'; mv '${state}/w2' '${state}/windows' ;;
  send-keys) : ;;
  *) echo "unexpected tmux $*" >&2; exit 9 ;;
esac`;
    return { state, bin: stubDir(`bin-${name}`, { tmux, sleep: "exit 0" }) };
  };

  test("production --shared: prod-primary and shared-maker only", () => {
    const { state, bin } = setup("prod");
    const r = sh(["/bin/bash", join(KIT, "down.sh"), "production", "--shared"], { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, AGATE_KIT_STATE: join(tmp, "st") });
    expect(r.code).toBe(0);
    const calls = readFileSync(join(state, "calls"), "utf8").split("\n").filter(Boolean);
    const kills = calls.filter((c) => c.startsWith("kill-window")).map((c) => c.split(" ")[2]);
    expect(kills.sort()).toEqual(["@17", "@21"]);
    for (const c of calls) {
      if (/^(kill-window|send-keys)/.test(c)) expect(c.split(" ")[2]).toMatch(/^@\d+$/);
      expect(c).not.toMatch(/-t =?agate-dev:\d/);
      expect(c).not.toMatch(/kill-(session|server)/);
    }
    const left = readFileSync(join(state, "windows"), "utf8");
    for (const w of ["@3 bun", "@4 wall-log", "@9 prod-primary-old", "@6 main", "@30 prod log"]) expect(left).toContain(w);
  });

  test("--only-named refuses names the kit does not create", () => {
    for (const w of ["bun", "wall-log", "prod-primary-old", "main", "prod log"]) {
      const { state, bin } = setup(`only-${w.replace(/\W/g, "")}`);
      const r = sh(["/bin/bash", join(KIT, "down.sh"), "demo", "--only-named"], { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, AGATE_KIT_ONLY: w });
      expect(r.code).not.toBe(0);
      expect(existsSync(join(state, "calls")) ? readFileSync(join(state, "calls"), "utf8") : "").not.toContain("kill-window");
    }
  });
});

describe("the RPC list command of the processes", () => {
  const security = `case " $* " in *" -s agate.alchemy-api-key -a api-key -w "*) printf '%s' '${FAKE_API}' ;; *) exit 44 ;; esac`;
  const rpcCmd = (file: string): string => {
    const line = readFileSync(join(KIT, file), "utf8").split("\n").find((l) => /^\s*RPC_CMD='k=/.test(l));
    if (!line) throw new Error(`no RPC_CMD in ${file}`);
    const r = sh(["/bin/bash", "-c", `${line.trim()}\nprintf '%s' "$RPC_CMD"`], { PATH: "/usr/bin:/bin" });
    return r.out;
  };
  for (const file of ["up.sh", "status.sh"]) {
    test(`${file}: Alchemy first, the public RPC second; the wall's resolver takes it and redacts the key`, () => {
      const cmd = rpcCmd(file);
      expect(cmd).not.toContain(FAKE_API);
      const bin = stubDir(`rpc-${file}`, { security });
      const probe = join(tmp, `probe-${file}.ts`);
      writeFileSync(
        probe,
        `import { resolveRpcEndpoints, redactUrl } from '${ROOT}/wall/packages/report/src/env.ts';\n` +
          `const env: Record<string, string | undefined> = { AGATE_RPC_URLS_CMD: process.env.CMD };\n` +
          `const e = resolveRpcEndpoints(env);\n` +
          `console.log(JSON.stringify({ http: e.http.map(redactUrl), ws: e.ws.map(redactUrl), raw0: e.http[0], left: Object.keys(env) }));\n`,
      );
      const r = sh([process.execPath, "run", probe], { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, CMD: cmd });
      expect(r.code).toBe(0);
      const j = JSON.parse(r.out.trim().split("\n").pop()!) as { http: string[]; ws: string[]; raw0: string; left: string[] };
      expect(j.raw0).toBe(`https://monad-testnet.g.alchemy.com/v2/${FAKE_API}`);
      expect(j.http).toEqual(["https://monad-testnet.g.alchemy.com/...", "https://testnet-rpc.monad.xyz"]);
      expect(j.ws).toEqual(file === "up.sh" ? ["wss://monad-testnet.g.alchemy.com/..."] : []);
      expect(j.left).toEqual([]);
    });
  }
});

describe("indexer.sh run: the RPC URL reaches envio's environment only", () => {
  test("not argv, not config.yaml, not the output", () => {
    const state = join(tmp, "ix-state");
    const work = join(state, "indexer");
    mkdirSync(join(work, "node_modules/.bin"), { recursive: true });
    const envioOut = join(tmp, "envio-call.txt");
    writeFileSync(join(work, "node_modules/.bin/envio"), `#!/bin/sh\nprintf 'argv=%s\\nurl=%s\\n' "$*" "$ENVIO_RPC_URL" > '${envioOut}'\n`);
    chmodSync(join(work, "node_modules/.bin/envio"), 0o755);
    const bin = stubDir("ix-bin", { docker: "exit 0", podman: "exit 1" });
    writeFileSync(join(tmp, "ix-records.json"), JSON.stringify({ chainId: 10143, production: { status: "deployed", index: "0x1111111111111111111111111111111111111111", deployBlock: 100 } }));
    writeFileSync(
      join(tmp, "ix-deployments.json"),
      JSON.stringify({ chainId: 10143, dollar: "0x3333333333333333333333333333333333333333", kuru: { router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630", marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" }, factories: { real: { index: "0x1111111111111111111111111111111111111111", dollar: "0x3333333333333333333333333333333333333333", tag: "", factory: "0x4444444444444444444444444444444444444444", router: "0x5555555555555555555555555555555555555555", tPend: 21600, startBlock: 101 } } }),
    );
    const url = `https://monad-testnet.g.alchemy.com/v2/${FAKE_API}`;
    const r = sh(["/bin/bash", join(KIT, "indexer.sh"), "run"], {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: tmp,
      AGATE_KIT_STATE: state,
      AGATE_DEPLOYMENTS: join(tmp, "ix-deployments.json"),
      AGATE_KIT_RECORDS: join(tmp, "ix-records.json"),
      AGATE_RPC_URLS_CMD: `printf '%s' '${url},https://testnet-rpc.monad.xyz,wss://monad-testnet.g.alchemy.com/v2/${FAKE_API}'`,
    });
    expect({ code: r.code, tail: r.code === 0 ? "" : r.out.slice(-600) }).toEqual({ code: 0, tail: "" });
    expect(r.out).not.toContain(FAKE_API);
    const got = readFileSync(envioOut, "utf8");
    expect(got).toBe(`argv=dev -r\nurl=${url}\n`);
    for (const f of readdirSync(work)) {
      const p = join(work, f);
      if (f.endsWith(".yaml") || f === ".config-sum") expect(readFileSync(p, "utf8")).not.toContain(FAKE_API);
    }
    expect(readFileSync(join(work, "config.yaml"), "utf8")).toContain("${ENVIO_RPC_URL}");
  });
});
