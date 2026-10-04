// Recheck r1 (Oct 4): who gets Alchemy from the kit's RPC list command (lib.sh rpc_list_cmd, alchemy_ws_kind), every
// window name the kit knows plus status.sh and a few look-alikes, in each AGATE_KIT_ALCHEMY mode, resolved by the wall's
// own parser with a stub Keychain: in light, Alchemy is a send: entry of the signing windows only and a websocket of
// the attester and the keeper only, never a read endpoint; the indexer never gets it in any mode. Also: the stand-in
// URL's check, and the indexer's own Alchemy filter against other spellings of Alchemy's host. Offline: every tool is a
// stub in a temp dir.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveRpcEndpoints } from "../../../../wall/packages/report/src/env.ts";

const KIT = resolve(import.meta.dir, "../..");
const ROOT = resolve(KIT, "../..");
const FAKE_API = "R1fakeKEY0123456789abcdefGHIJKL";
let tmp = "";
let bin = "";
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "agate-kit-r1-"));
  bin = join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "security"), `#!/bin/sh\ncase " $* " in *" -w "*) printf '%s' '${FAKE_API}' ;; esac\nexit 0\n`);
  chmodSync(join(bin, "security"), 0o755);
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function bash(script: string, env: Record<string, string>) {
  const r = Bun.spawnSync(["/bin/bash", "-c", `source '${KIT}/lib.sh'\n${script}`], { cwd: ROOT, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

const WINDOWS = [
  "prod-log", "prod-primary", "prod-standby", "prod-attest", "prod-keep", "prod-pagecheck", "prod-health",
  "demo-replay", "demo-log", "demo-primary", "demo-standby", "demo-attest", "demo-keep", "demo-pagecheck", "demo-health",
  "shared-maker", "shared-payer", "shared-indexer", "shared-repair", "shared-akash", "shared-awake", "status",
  // look-alikes: none of these is a signing window
  "shared-maker-old", "prod-attester-x", "x-indexer", "prod-keeper", "demo-primary2", "shared-payers", "akash", "health",
];
const SIGNERS = new Set(["prod-primary", "prod-standby", "prod-attest", "prod-keep", "demo-primary", "demo-standby", "demo-attest", "demo-keep", "shared-maker", "shared-payer"]);
const WS = new Set(["prod-attest", "prod-keep", "demo-attest", "demo-keep"]);
const isAlchemy = (u: string) => u.includes("alchemy.com") || u.includes(FAKE_API);

/** The endpoints a window's process would resolve, run through the wall's parser (the stub Keychain answers). */
function endpointsOf(name: string, env: Record<string, string>, fork = false) {
  const r = bash(`${fork ? "KIT_FORK=1\n" : ""}c="$(rpc_list_cmd '${name}')" || exit 9\nprintf '%s\\n' "$c"\nprintf 'WS_KIND=%s\\n' "$(alchemy_ws_kind '${name}')"`, env);
  expect({ name, code: r.code, err: r.err }).toEqual({ name, code: 0, err: "" });
  const [cmd, kind] = r.out.trimEnd().split("\n");
  const e = resolveRpcEndpoints({ AGATE_RPC_URLS_CMD: cmd! }, (c) => {
    const x = Bun.spawnSync(["/bin/sh", "-c", c], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp }, stdout: "pipe" });
    return x.stdout.toString();
  });
  return { cmd: cmd!, kind: kind!.replace("WS_KIND=", ""), e };
}

describe("light (the default): Alchemy only for the signing windows' own transactions, its ws only for attest and keep", () => {
  for (const ws of ["on", "prod", "off"]) {
    test(`AGATE_KIT_ALCHEMY_WS=${ws}: window by window`, () => {
      for (const name of WINDOWS) {
        const { cmd, kind, e } = endpointsOf(name, { AGATE_KIT_ALCHEMY_WS: ws });
        const send = (e.send ?? []).filter(isAlchemy);
        const wss = e.ws.filter(isAlchemy);
        const wantWs = ws === "off" ? false : ws === "prod" ? name === "prod-attest" || name === "prod-keep" : WS.has(name);
        expect({ name, readAlchemy: e.http.some(isAlchemy) }).toEqual({ name, readAlchemy: false });
        expect({ name, send: send.length }).toEqual({ name, send: SIGNERS.has(name) ? 1 : 0 });
        expect({ name, ws: wss.length }).toEqual({ name, ws: wantWs ? 1 : 0 });
        expect({ name, kind }).toEqual({ name, kind: wantWs ? "logs" : "" });
        // the command text holds no key: only the Keychain read
        expect(cmd).not.toContain(FAKE_API);
        // three public read endpoints every time
        expect({ name, reads: e.http.length }).toEqual({ name, reads: 3 });
      }
    });
  }
});

describe("off and all", () => {
  test("off: nobody gets Alchemy", () => {
    for (const name of WINDOWS) {
      const { e, cmd } = endpointsOf(name, { AGATE_KIT_ALCHEMY: "off" });
      expect({ name, any: [...e.http, ...e.ws, ...(e.send ?? [])].some(isAlchemy) || cmd.includes("security") }).toEqual({ name, any: false });
    }
  });
  test("all: Alchemy first for every window but the indexer (a read endpoint there, which the meter does not count)", () => {
    for (const name of WINDOWS) {
      const { e } = endpointsOf(name, { AGATE_KIT_ALCHEMY: "all" });
      const ix = name.endsWith("-indexer");
      expect({ name, first: isAlchemy(e.http[0]!) }).toEqual({ name, first: !ix });
      // in all, no window has a send: entry: the sends ride the read list, so the meter (send endpoints and ws only)
      // counts nothing but the websocket
      expect({ name, send: (e.send ?? []).length }).toEqual({ name, send: 0 });
    }
  });
  // INFO (recheck r1), fixed: in all, kit_alchemy_line said the budget covered "the sends and the websocket", though
  // the meter (send endpoints and websocket only) counts no read and no send there
  test("all: kit_alchemy_line says the meter counts only the websocket; light says the sends and the websocket", () => {
    const all = bash(`kit_alchemy_line`, { AGATE_KIT_ALCHEMY: "all" });
    expect(all.code).toBe(0);
    expect(all.out).toContain("the meter counts only the websocket here");
    expect(all.out).not.toContain("for the sends and the websocket only");
    const light = bash(`kit_alchemy_line`, {});
    expect(light.out).toContain("takes the signing processes' own transactions");
    expect(light.out).toContain("budget 400000 CU a UTC day");
  });
});

describe("the stand-in URL (AGATE_KIT_ALCHEMY_TEST_URL): http on loopback only", () => {
  const bad = [
    "http://127.0.0.1.evil.example:9555",
    "http://localhost:9555@evil.example",
    "https://127.0.0.1:9555",
    "http://[::1]:9555",
    "http://127.0.0.1:9555?x=1",
    "http://127.0.0.1:9555/a'b",
    "http://127.0.0.1:9555/$(id)",
    "http://127.0.0.1:9555\nhttps://evil.example",
    "http://127.0.0.1:9555/%2e%2e",
    " http://127.0.0.1:9555",
    "http://127.0.0.1",
  ];
  for (const u of bad) {
    test(`${JSON.stringify(u)} is refused`, () => {
      const r = bash(`rpc_list_cmd prod-attest`, { AGATE_KIT_ALCHEMY_TEST_URL: u });
      expect({ code: r.code, out: r.out }).toEqual({ code: 1, out: "" });
      expect(r.err).toContain("AGATE_KIT_ALCHEMY_TEST_URL must be");
    });
  }
  test("a loopback stand-in on a fork: its URL as the send entry and its ws:// twin, no Keychain read", () => {
    const { e, cmd } = endpointsOf("demo-attest", { AGATE_KIT_ALCHEMY_TEST_URL: "http://127.0.0.1:9555" }, true);
    expect(cmd).not.toContain("security");
    expect(e.send).toEqual(["http://127.0.0.1:9555"]);
    expect(e.ws).toEqual(["ws://127.0.0.1:9555"]);
  });
  // FINDING (recheck r1, LOW), fixed: the stand-in was taken on a real (not --fork) run too: a variable left exported
  // after a rehearsal made the testnet processes send their real transactions to a loopback URL first. While a fork
  // and its counting proxy still ran there, that URL answered chain 10143, took the transactions and mined them on the
  // fork; the senders read the fork's receipts and never failed over. A real run now refuses the stand-in.
  test("a real run (not --fork) refuses the stand-in", () => {
    const r = bash(`rpc_list_cmd prod-primary`, { AGATE_KIT_ALCHEMY_TEST_URL: "http://127.0.0.1:9555" });
    expect(r.code).not.toBe(0);
  });
  test("a real run: no RPC command for any window, and kit_alchemy_line stops with the reason", () => {
    for (const name of WINDOWS) {
      const r = bash(`rpc_list_cmd '${name}'`, { AGATE_KIT_ALCHEMY_TEST_URL: "http://127.0.0.1:9555" });
      expect({ name, code: r.code, out: r.out }).toEqual({ name, code: 1, out: "" });
      expect(r.err).toContain("AGATE_KIT_ALCHEMY_TEST_URL is for --fork runs only");
    }
    const l = bash(`kit_alchemy_line`, { AGATE_KIT_ALCHEMY_TEST_URL: "http://127.0.0.1:9555" });
    expect(l.code).not.toBe(0);
    expect(`${l.out}${l.err}`).toContain("AGATE_KIT_ALCHEMY_TEST_URL is for --fork runs only");
    expect(l.out).not.toContain("the Alchemy stand-in");
    // in every mode, off included: the variable alone is the mistake
    for (const mode of ["off", "light", "all"]) expect(bash(`rpc_list_cmd prod-primary`, { AGATE_KIT_ALCHEMY: mode, AGATE_KIT_ALCHEMY_TEST_URL: "http://127.0.0.1:9555" }).code).toBe(1);
    // a fork still takes it
    expect(bash(`KIT_FORK=1\nkit_alchemy_line`, { AGATE_KIT_ALCHEMY_TEST_URL: "http://127.0.0.1:9555" }).out).toContain("the Alchemy stand-in http://127.0.0.1:9555");
  });
  test("a fork without the stand-in is off (never the real Alchemy)", () => {
    for (const mode of ["light", "all"]) {
      // KIT_FORK is set by kit_parse (--fork) after lib.sh is sourced
      const r = bash(`KIT_FORK=1\nrpc_list_cmd demo-attest 'http://127.0.0.1:8549,http://localhost:8549'`, { AGATE_KIT_ALCHEMY: mode });
      expect(r.out).toBe("printf 'http://127.0.0.1:8549,http://localhost:8549'");
    }
  });
});

describe("indexer.sh's own Alchemy filter (defense behind the kit, which never gives the indexer Alchemy)", () => {
  const run = (alchemy: string) => {
    const state = join(tmp, `ix-${Bun.hash(alchemy)}`);
    const work = join(state, "indexer");
    mkdirSync(join(work, "node_modules/.bin"), { recursive: true });
    const envioOut = join(state, "envio-call.txt");
    writeFileSync(join(work, "node_modules/.bin/envio"), `#!/bin/sh\nprintf 'url=%s fb1=%s fb2=%s\\n' "$ENVIO_RPC_URL" "\${ENVIO_RPC_URL_FALLBACK_1:-unset}" "\${ENVIO_RPC_URL_FALLBACK_2:-unset}" > '${envioOut}'\n`);
    chmodSync(join(work, "node_modules/.bin/envio"), 0o755);
    const sb = join(state, "bin");
    mkdirSync(sb);
    writeFileSync(join(sb, "docker"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(sb, "podman"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(sb, "docker"), 0o755);
    chmodSync(join(sb, "podman"), 0o755);
    writeFileSync(join(state, "records.json"), JSON.stringify({ chainId: 10143, production: { status: "deployed", index: "0x1111111111111111111111111111111111111111", deployBlock: 100 } }));
    writeFileSync(join(state, "deployments.json"), JSON.stringify({ chainId: 10143, dollar: "0x3333333333333333333333333333333333333333", kuru: { router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630", marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" }, factories: { real: { index: "0x1111111111111111111111111111111111111111", dollar: "0x3333333333333333333333333333333333333333", tag: "", factory: "0x4444444444444444444444444444444444444444", router: "0x5555555555555555555555555555555555555555", tPend: 21600, startBlock: 101 } } }));
    const r = Bun.spawnSync(["/bin/bash", join(KIT, "indexer.sh"), "run"], {
      cwd: ROOT,
      env: { PATH: `${sb}:${process.env.PATH}`, HOME: tmp, AGATE_KIT_STATE: state, AGATE_DEPLOYMENTS: join(state, "deployments.json"), AGATE_KIT_RECORDS: join(state, "records.json"), AGATE_RPC_URLS_CMD: `printf '%s' '${alchemy},https://testnet-rpc.monad.xyz'` },
      stdout: "pipe",
      stderr: "pipe",
    });
    let envio = "";
    try {
      envio = require("node:fs").readFileSync(envioOut, "utf8");
    } catch {
      envio = "";
    }
    return { code: r.exitCode, out: `${r.stdout}${r.stderr}`, envio };
  };
  test("the host as the kit would write it: left out", () => {
    const r = run(`https://monad-testnet.g.alchemy.com/v2/${FAKE_API}`);
    expect(r.code).toBe(0);
    expect(r.envio).not.toContain(FAKE_API);
  });
  // INFO (recheck r1), fixed: the filter compared the host as written (case-sensitive, no trailing dot), so other
  // spellings of the same host passed it. It now reads the host as a resolver does.
  for (const spelled of [
    `https://MONAD-TESTNET.G.ALCHEMY.COM/v2/${FAKE_API}`,
    `https://monad-testnet.g.alchemy.com./v2/${FAKE_API}`,
    `https://monad-testnet.g.alchemy.com:443/v2/${FAKE_API}`,
    `https://user@monad-testnet.g.alchemy.com/v2/${FAKE_API}`,
    `https://monad-testnet.g.alchemy%2Ecom/v2/${FAKE_API}`,
    `https://monad-testnet.g.alchemy.com?k=${FAKE_API}`,
    `https://Monad-Testnet.G.Alchemy.Com../v2/${FAKE_API}`,
  ]) {
    test(`${spelled.replace(FAKE_API, "<key>")}: left out (never in envio's environment)`, () => {
      const r = run(spelled);
      expect(r.code).toBe(0);
      expect(r.envio).not.toContain(FAKE_API);
      expect(r.envio).toContain("url=https://testnet-rpc.monad.xyz");
      expect(r.out).toContain("left out 1 Alchemy URL(s)");
      expect(r.out).not.toContain(FAKE_API);
    });
  }
});
