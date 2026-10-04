// Adversarial checks of the testnet kit, offline: every Keychain, tmux and chain tool is a stub in a temp dir, so
// nothing here reads a real secret, opens a real window or sends anything. `bun test ops/testnet/test` (repo root).
//
// - signed(): a failed or malformed Keychain read stops before the signing command runs and never echoes the value;
//   a good one reaches that command's environment only (not its argv, not the output); a stray key in the caller's
//   shell never reaches a read-only forge run.
// - down.sh (real mode, stub tmux): closes only the windows the kit names, by window id, never by index, and never
//   "bun", "wall-log", a look-alike name or a window of another session.
// - the RPC list command up.sh and status.sh give the processes (AGATE_KIT_ALCHEMY off, light, all; Oct 4): with a stub
//   Keychain the wall's resolver accepts each, light gives Alchemy to the signing windows as a send endpoint only (and
//   its websocket to the attester and the keeper), the redacted forms hide the API key, a bad mode or a non-loopback
//   stand-in is refused.
// - indexer.sh run: the RPC URLs (one with a key) reach envio's environment only: not its argv, not config.yaml, not
//   the script's output; the first is the sync RPC, the others fallbacks; an Alchemy URL is left out.
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
  const PUBLIC = ["https://testnet-rpc.monad.xyz", "https://10143.rpc.thirdweb.com", "https://rpc.ankr.com/monad_testnet"];
  const listCmd = (name: string, extra: Record<string, string> = {}): string =>
    sh(["/bin/bash", "-c", `source '${join(KIT, "lib.sh")}'; rpc_list_cmd '${name}'`], { PATH: "/usr/bin:/bin", ...extra }).out;
  const resolve = (cmd: string, tag: string) => {
    const bin = stubDir(`rpc-${tag}`, { security });
    const probe = join(tmp, `probe-${tag}.ts`);
    writeFileSync(
      probe,
      `import { resolveRpcEndpoints, redactUrl } from '${ROOT}/wall/packages/report/src/env.ts';\n` +
        `const env: Record<string, string | undefined> = { AGATE_RPC_URLS_CMD: process.env.CMD };\n` +
        `const e = resolveRpcEndpoints(env);\n` +
        `console.log(JSON.stringify({ http: e.http.map(redactUrl), ws: e.ws.map(redactUrl), send: (e.send ?? []).map(redactUrl), raw: e.http, raw0: e.http[0], rawSend: e.send ?? [], rawWs: e.ws, left: Object.keys(env) }));\n`,
    );
    const r = sh([process.execPath, "run", probe], { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, CMD: cmd });
    expect(r.code).toBe(0);
    return JSON.parse(r.out.trim().split("\n").pop()!) as { http: string[]; ws: string[]; send: string[]; raw: string[]; raw0: string; rawSend: string[]; rawWs: string[]; left: string[] };
  };
  const WINDOWS = ["prod-primary", "prod-standby", "prod-attest", "prod-keep", "prod-health", "prod-log", "demo-primary", "demo-attest", "shared-maker", "shared-payer", "shared-indexer", "shared-repair", "status"];
  test("off: the three public RPCs, no key read, rotated by the window's name so the windows spread their load", () => {
    const firsts = new Set<string>();
    for (const n of WINDOWS) {
      const cmd = listCmd(n, { AGATE_KIT_ALCHEMY: "off" });
      expect(cmd).not.toContain("security");
      const j = resolve(cmd, `pub-${n}`);
      expect([...j.raw].sort()).toEqual([...PUBLIC].sort());
      expect(j.ws).toEqual([]);
      expect(j.send).toEqual([]);
      expect(j.left).toEqual([]);
      firsts.add(j.raw[0]!);
    }
    expect(firsts.size).toBeGreaterThanOrEqual(3);
  });
  test("light (the default): the signing windows send through Alchemy first (a send: entry, its key read at start), read only the public RPCs; the attester and the keeper also get its websocket; nobody else gets Alchemy", () => {
    for (const n of WINDOWS) {
      for (const extra of [{}, { AGATE_KIT_ALCHEMY: "light" }]) {
        const cmd = listCmd(n, extra);
        expect(cmd).not.toContain(FAKE_API);
        const signer = /-(primary|standby|attest|keep)$|^shared-(maker|payer)$/.test(n);
        const ws = /-(attest|keep)$/.test(n);
        expect({ n, reads: cmd.includes("security") }).toEqual({ n, reads: signer });
        const j = resolve(cmd, `light-${n}`);
        // reads: the public RPCs only, whatever the window
        expect([...j.raw].sort()).toEqual([...PUBLIC].sort());
        expect({ n, send: j.rawSend }).toEqual({ n, send: signer ? [`https://monad-testnet.g.alchemy.com/v2/${FAKE_API}`] : [] });
        expect({ n, sendRedacted: j.send }).toEqual({ n, sendRedacted: signer ? ["https://monad-testnet.g.alchemy.com/..."] : [] });
        expect({ n, ws: j.rawWs }).toEqual({ n, ws: ws ? [`wss://monad-testnet.g.alchemy.com/v2/${FAKE_API}`] : [] });
        expect(j.left).toEqual([]);
      }
    }
  });
  test("all: Alchemy first for every read and send (its key read by the command at start, redacted), the public RPCs after, its websocket; never the indexer", () => {
    for (const n of WINDOWS) {
      const cmd = listCmd(n, { AGATE_KIT_ALCHEMY: "all" });
      expect(cmd).not.toContain(FAKE_API);
      const j = resolve(cmd, `all-${n}`);
      if (n === "shared-indexer") {
        expect(cmd).not.toContain("security");
        expect([...j.raw].sort()).toEqual([...PUBLIC].sort());
        continue;
      }
      expect(j.raw0).toBe(`https://monad-testnet.g.alchemy.com/v2/${FAKE_API}`);
      expect(j.http[0]).toBe("https://monad-testnet.g.alchemy.com/...");
      expect([...j.raw.slice(1)].sort()).toEqual([...PUBLIC].sort());
      expect(j.ws).toEqual(["wss://monad-testnet.g.alchemy.com/..."]);
      expect(j.send).toEqual([]);
      expect(j.left).toEqual([]);
    }
  });
  test("AGATE_KIT_ALCHEMY_WS: prod gives the websocket to the production attester and keeper only, off to nobody (the sends keep Alchemy); another value prints no command", () => {
    for (const [w, want] of [["on", ["prod-attest", "prod-keep", "demo-attest", "demo-keep"]], ["prod", ["prod-attest", "prod-keep"]], ["off", []]] as const) {
      for (const n of ["prod-attest", "prod-keep", "demo-attest", "demo-keep", "prod-primary", "shared-maker"]) {
        const cmd = listCmd(n, { AGATE_KIT_ALCHEMY_WS: w });
        expect({ w, n, wss: cmd.includes("wss://") }).toEqual({ w, n, wss: (want as readonly string[]).includes(n) });
        expect({ w, n, send: cmd.includes("send:https://monad-testnet.g.alchemy.com/v2/%s") }).toEqual({ w, n, send: true });
      }
      const all = listCmd("prod-health", { AGATE_KIT_ALCHEMY: "all", AGATE_KIT_ALCHEMY_WS: w });
      expect({ w, allWss: all.includes("wss://") }).toEqual({ w, allWss: w !== "off" });
    }
    for (const v of ["yes", "PROD", "1"]) {
      const r = sh(["/bin/bash", "-c", `source '${join(KIT, "lib.sh")}'; rpc_list_cmd prod-attest`], { PATH: "/usr/bin:/bin", AGATE_KIT_ALCHEMY_WS: v });
      expect({ v, code: r.code === 0 }).toEqual({ v, code: false });
      expect(r.out).toContain("AGATE_KIT_ALCHEMY_WS must be on, prod or off");
      expect(r.out).not.toContain("printf");
    }
  });
  test("a mode other than off, light or all (the old 0/1 included) prints no command", () => {
    for (const v of ["1", "0", "yes", "LIGHT", "light "]) {
      const r = sh(["/bin/bash", "-c", `source '${join(KIT, "lib.sh")}'; rpc_list_cmd prod-primary`], { PATH: "/usr/bin:/bin", AGATE_KIT_ALCHEMY: v });
      expect({ v, code: r.code === 0 }).toEqual({ v, code: false });
      expect(r.out).toContain("AGATE_KIT_ALCHEMY must be one of: off light all");
      expect(r.out).not.toContain("printf");
    }
  });
  test("the stand-in (AGATE_KIT_ALCHEMY_TEST_URL) is loopback http only, takes Alchemy's place with no Keychain read, and a fork without it is off", () => {
    for (const u of ["https://127.0.0.1:9", "http://10.0.0.1:9", "http://127.0.0.1:9@evil.test", "http://127.0.0.1:9.evil.test", "http://localhost:9'x", "http://example.com:9"]) {
      const r = sh(["/bin/bash", "-c", `source '${join(KIT, "lib.sh")}'; rpc_list_cmd prod-primary`], { PATH: "/usr/bin:/bin", AGATE_KIT_ALCHEMY_TEST_URL: u });
      expect({ u, code: r.code === 0 }).toEqual({ u, code: false });
      expect(r.out).toContain("must be http://127.0.0.1:<port> or http://localhost:<port>");
    }
    const fork = "http://127.0.0.1:8549,http://localhost:8549";
    const at = (n: string, e: Record<string, string>) => sh(["/bin/bash", "-c", `source '${join(KIT, "lib.sh")}'; KIT_FORK=1; rpc_list_cmd ${n} '${fork}'`], { PATH: "/usr/bin:/bin", ...e }).out;
    const stand = { AGATE_KIT_ALCHEMY_TEST_URL: "http://127.0.0.1:9555" };
    expect(at("prod-primary", stand)).toBe(`printf '%s' 'send:http://127.0.0.1:9555,${fork}'`);
    expect(at("prod-attest", stand)).toBe(`printf '%s' 'send:http://127.0.0.1:9555,${fork},ws://127.0.0.1:9555'`);
    expect(at("prod-health", stand)).toBe(`printf '${fork}'`);
    expect(at("shared-indexer", { ...stand, AGATE_KIT_ALCHEMY: "all" })).toBe(`printf '${fork}'`);
    expect(at("prod-health", { ...stand, AGATE_KIT_ALCHEMY: "all" })).toBe(`printf '%s' 'http://127.0.0.1:9555,${fork},ws://127.0.0.1:9555'`);
    // a fork never reaches the real Alchemy: without the stand-in it is off whatever the mode
    for (const m of ["light", "all"]) for (const n of ["prod-primary", "prod-attest", "shared-maker"]) expect(at(n, { AGATE_KIT_ALCHEMY: m })).toBe(`printf '${fork}'`);
  });
});

describe("indexer.sh run: the RPC URLs reach envio's environment only", () => {
  test("not argv, not config.yaml, not the output; the first syncs, the others are fallbacks; Alchemy is left out", () => {
    const state = join(tmp, "ix-state");
    const work = join(state, "indexer");
    mkdirSync(join(work, "node_modules/.bin"), { recursive: true });
    const envioOut = join(tmp, "envio-call.txt");
    writeFileSync(join(work, "node_modules/.bin/envio"), `#!/bin/sh\nprintf 'argv=%s\\nurl=%s\\nfb1=%s\\nfb2=%s\\n' "$*" "$ENVIO_RPC_URL" "\${ENVIO_RPC_URL_FALLBACK_1:-unset}" "\${ENVIO_RPC_URL_FALLBACK_2:-unset}" > '${envioOut}'\n`);
    chmodSync(join(work, "node_modules/.bin/envio"), 0o755);
    const bin = stubDir("ix-bin", { docker: "exit 0", podman: "exit 1" });
    writeFileSync(join(tmp, "ix-records.json"), JSON.stringify({ chainId: 10143, production: { status: "deployed", index: "0x1111111111111111111111111111111111111111", deployBlock: 100 } }));
    writeFileSync(
      join(tmp, "ix-deployments.json"),
      JSON.stringify({ chainId: 10143, dollar: "0x3333333333333333333333333333333333333333", kuru: { router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630", marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" }, factories: { real: { index: "0x1111111111111111111111111111111111111111", dollar: "0x3333333333333333333333333333333333333333", tag: "", factory: "0x4444444444444444444444444444444444444444", router: "0x5555555555555555555555555555555555555555", tPend: 21600, startBlock: 101 } } }),
    );
    // a keyed URL (secret, though not Alchemy), Alchemy (left out), a public one twice (once kept), a websocket, a send entry
    const url = `https://rpc.keyed.test/v2/${FAKE_API}`;
    const r = sh(["/bin/bash", join(KIT, "indexer.sh"), "run"], {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: tmp,
      AGATE_KIT_STATE: state,
      AGATE_DEPLOYMENTS: join(tmp, "ix-deployments.json"),
      AGATE_KIT_RECORDS: join(tmp, "ix-records.json"),
      AGATE_RPC_URLS_CMD: `printf '%s' '${url},https://monad-testnet.g.alchemy.com/v2/${FAKE_API},https://testnet-rpc.monad.xyz,https://testnet-rpc.monad.xyz,wss://monad-testnet.g.alchemy.com/v2/${FAKE_API},send:https://send.test/${FAKE_API}'`,
    });
    expect({ code: r.code, tail: r.code === 0 ? "" : r.out.slice(-600) }).toEqual({ code: 0, tail: "" });
    expect(r.out).not.toContain(FAKE_API);
    expect(r.out).toContain("left out 1 Alchemy URL(s): the indexer never uses Alchemy");
    expect(r.out).toContain("with 1 sync RPC and 1 fallback(s)");
    const got = readFileSync(envioOut, "utf8");
    expect(got).toBe(`argv=dev -r\nurl=${url}\nfb1=https://testnet-rpc.monad.xyz\nfb2=unset\n`);
    for (const f of readdirSync(work)) {
      const p = join(work, f);
      if (f.endsWith(".yaml") || f === ".config-sum") expect(readFileSync(p, "utf8")).not.toContain(FAKE_API);
    }
    // the chain's rpc list in Envio 3.12's shape: the sync entry, then one fallback entry per later URL
    const yaml = readFileSync(join(work, "config.yaml"), "utf8");
    const rpc = yaml.slice(yaml.indexOf("    rpc:\n"), yaml.indexOf("    contracts:\n"));
    expect(rpc).toBe(
      ["    rpc:", '      - url: "${ENVIO_RPC_URL}"', "        for: sync", "        interval_ceiling: 100", '      - url: "${ENVIO_RPC_URL_FALLBACK_1}"', "        for: fallback", "        interval_ceiling: 100", ""].join("\n"),
    );
  });

  test("three public RPCs (the kit's list): one sync and two fallbacks; nothing but Alchemy: refused before envio starts", () => {
    const state = join(tmp, "ix-state-3");
    const work = join(state, "indexer");
    mkdirSync(join(work, "node_modules/.bin"), { recursive: true });
    const envioOut = join(tmp, "envio-call-3.txt");
    writeFileSync(join(work, "node_modules/.bin/envio"), `#!/bin/sh\nprintf '%s|%s|%s|%s' "$ENVIO_RPC_URL" "\${ENVIO_RPC_URL_FALLBACK_1:-unset}" "\${ENVIO_RPC_URL_FALLBACK_2:-unset}" "\${ENVIO_RPC_URL_FALLBACK_3:-unset}" > '${envioOut}'\n`);
    chmodSync(join(work, "node_modules/.bin/envio"), 0o755);
    const bin = stubDir("ix-bin-3", { docker: "exit 0", podman: "exit 1" });
    const base = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, AGATE_KIT_STATE: state, AGATE_DEPLOYMENTS: join(tmp, "ix-deployments.json"), AGATE_KIT_RECORDS: join(tmp, "ix-records.json") };
    const list = sh(["/bin/bash", "-c", `source '${join(KIT, "lib.sh")}'; rpc_list_cmd shared-indexer`], { PATH: "/usr/bin:/bin", AGATE_KIT_ALCHEMY: "all" }).out;
    const r = sh(["/bin/bash", join(KIT, "indexer.sh"), "run"], { ...base, AGATE_RPC_URLS_CMD: list });
    expect({ code: r.code, tail: r.code === 0 ? "" : r.out.slice(-600) }).toEqual({ code: 0, tail: "" });
    const [sync, ...fb] = readFileSync(envioOut, "utf8").split("|");
    expect([sync, ...fb.slice(0, 2)].sort()).toEqual(["https://10143.rpc.thirdweb.com", "https://rpc.ankr.com/monad_testnet", "https://testnet-rpc.monad.xyz"]);
    expect(fb[2]).toBe("unset");
    expect(readFileSync(join(work, "config.yaml"), "utf8").match(/for: fallback/g)?.length).toBe(2);
    rmSync(envioOut);
    const only = sh(["/bin/bash", join(KIT, "indexer.sh"), "run"], { ...base, AGATE_RPC_URLS_CMD: `printf '%s' 'https://monad-testnet.g.alchemy.com/v2/${FAKE_API}'` });
    expect(only.code).not.toBe(0);
    expect(only.out).toContain("printed no http(s) URL but Alchemy, which the indexer never uses");
    expect(only.out).not.toContain(FAKE_API);
    expect(existsSync(envioOut)).toBe(false);
  });
});
