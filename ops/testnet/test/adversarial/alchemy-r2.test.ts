// Recheck r2 (Oct 4): who gets Alchemy, for every window up.sh can open (read from up.sh itself, so a window added later
// is covered), in each mode, resolved by the wall's own parser with a stub Keychain. Plus two spellings of Alchemy's
// host that indexer.sh's filter still lets through (INFO: the kit never hands the indexer Alchemy). Offline: every
// tool is a stub in a temp dir.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveRpcEndpoints } from "../../../../wall/packages/report/src/env.ts";

const KIT = resolve(import.meta.dir, "../..");
const ROOT = resolve(KIT, "../..");
const FAKE_API = "R2fakeKEYfakeKEYfakeKEYfakeKEY01"; // made up
let tmp = "";
let bin = "";
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "agate-kit-r2-"));
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

/** Every window name up.sh can open: the labels of its win_cmd case, with * as prod and demo. */
function upWindows(): string[] {
  const src = readFileSync(join(KIT, "up.sh"), "utf8");
  const body = src.slice(src.indexOf("win_cmd() {"), src.indexOf("\n}\n", src.indexOf("win_cmd() {")));
  const names = new Set<string>();
  for (const m of body.matchAll(/^\s+([a-z*|\s-]+)\)\s/gm)) {
    for (const label of m[1]!.split("|").map((s) => s.trim())) {
      if (label.startsWith("*-")) for (const p of ["prod", "demo"]) names.add(`${p}${label.slice(1)}`);
      else if (label) names.add(label);
    }
  }
  return [...names].sort();
}

const isAlchemy = (u: string) => u.includes("alchemy.com") || u.includes(FAKE_API);

function endpointsOf(name: string, env: Record<string, string>) {
  const r = bash(`c="$(rpc_list_cmd '${name}')" || exit 9\nprintf '%s\\n' "$c"\nprintf 'WS_KIND=%s\\n' "$(alchemy_ws_kind '${name}')"`, env);
  expect({ name, code: r.code, err: r.err }).toEqual({ name, code: 0, err: "" });
  const [cmd, kind] = r.out.trimEnd().split("\n");
  const e = resolveRpcEndpoints({ AGATE_RPC_URLS_CMD: cmd! }, (c) => Bun.spawnSync(["/bin/sh", "-c", c], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp }, stdout: "pipe" }).stdout.toString());
  return { cmd: cmd!, kind: kind!.replace("WS_KIND=", ""), e };
}

describe("every window up.sh can open (recheck r2)", () => {
  const windows = upWindows();
  test("up.sh's windows are the ones recheck r1 listed (plus status.sh): none was added since", () => {
    expect(windows).toEqual(["demo-attest", "demo-health", "demo-keep", "demo-log", "demo-pagecheck", "demo-primary", "demo-replay", "demo-standby", "prod-attest", "prod-health", "prod-keep", "prod-log", "prod-pagecheck", "prod-primary", "prod-replay", "prod-standby", "shared-akash", "shared-awake", "shared-indexer", "shared-maker", "shared-payer", "shared-repair"].filter((w) => w !== "prod-replay"));
  });

  const SIGN = /^(prod|demo)-(primary|standby|attest|keep)$|^shared-(maker|payer)$/;
  const WS = /^(prod|demo)-(attest|keep)$/;
  for (const ws of ["on", "prod", "off"]) {
    test(`light, AGATE_KIT_ALCHEMY_WS=${ws}: Alchemy is never a read endpoint; a send: entry exactly for the signers; a websocket only for attest and keep`, () => {
      for (const name of [...windows, "status"]) {
        const { cmd, kind, e } = endpointsOf(name, { AGATE_KIT_ALCHEMY_WS: ws });
        const wantWs = ws === "off" ? false : ws === "prod" ? /^prod-(attest|keep)$/.test(name) : WS.test(name);
        expect({ name, read: e.http.filter(isAlchemy).length, send: (e.send ?? []).filter(isAlchemy).length, ws: e.ws.filter(isAlchemy).length, kind }).toEqual({ name, read: 0, send: SIGN.test(name) ? 1 : 0, ws: wantWs ? 1 : 0, kind: wantWs ? "logs" : "" });
        expect(cmd).not.toContain(FAKE_API);
      }
    });
  }

  test("the indexer, health, the loggers, pagecheck, repair, akash and status: no Alchemy in light or off; the indexer none in all", () => {
    for (const mode of ["light", "off", "all"]) {
      for (const name of [...windows, "status"]) {
        if (mode === "all" && name !== "shared-indexer") continue;
        if (SIGN.test(name)) continue;
        const { e } = endpointsOf(name, { AGATE_KIT_ALCHEMY: mode });
        expect({ mode, name, alchemy: [...e.http, ...e.ws, ...(e.send ?? [])].filter(isAlchemy).length }).toEqual({ mode, name, alchemy: 0 });
      }
    }
  });
});

describe("indexer.sh's own Alchemy filter: spellings it still lets through (recheck r2, INFO)", () => {
  let runs = 0;
  const run = (alchemy: string) => {
    const state = join(tmp, `ix-${runs++}`);
    const work = join(state, "indexer");
    mkdirSync(join(work, "node_modules/.bin"), { recursive: true });
    const envioOut = join(state, "envio-call.txt");
    writeFileSync(join(work, "node_modules/.bin/envio"), `#!/bin/sh\nprintf 'url=%s fb1=%s\\n' "$ENVIO_RPC_URL" "\${ENVIO_RPC_URL_FALLBACK_1:-unset}" > '${envioOut}'\n`);
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
      envio = readFileSync(envioOut, "utf8");
    } catch {
      envio = "";
    }
    return { code: r.exitCode, out: `${r.stdout}${r.stderr}`, envio };
  };
  // A URL parser reads %61 as "a" and maps fullwidth letters to ASCII, so these name Alchemy's host to fetch; the
  // filter compares the text. Only an operator who spells the host this way on purpose gets there: the kit never gives
  // the indexer an Alchemy URL in any mode. Flip to plain tests if the filter learns to decode them.
  for (const spelled of [`https://monad-testnet.g.%61lchemy.com/v2/${FAKE_API}`, `https://monad-testnet.g.\u{FF41}lchemy.com/v2/${FAKE_API}`]) {
    test.failing(`${spelled.replace(FAKE_API, "<key>")}: left out (it is not today)`, () => {
      expect(new URL(spelled).hostname).toBe("monad-testnet.g.alchemy.com");
      const r = run(spelled);
      expect(r.code).toBe(0);
      expect(r.envio).not.toContain(FAKE_API);
    });
  }
  test("today such a URL reaches envio's environment as the sync RPC; the script's own output never shows the key", () => {
    for (const spelled of [`https://monad-testnet.g.%61lchemy.com/v2/${FAKE_API}`, `https://monad-testnet.g.\u{FF41}lchemy.com/v2/${FAKE_API}`]) {
      const r = run(spelled);
      expect(r.code).toBe(0);
      expect(r.envio).toContain(FAKE_API);
      expect(r.out).not.toContain(FAKE_API);
    }
  });
});
