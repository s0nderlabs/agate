// BUILD-SPEC 13.6: RPC endpoints from a command, redaction, the scrubber. No test reads the Keychain: the "key" is a
// fake printed by printf, and every check asserts it never comes back out.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { childEnv, redactUrl, resolveRpcEndpoints, runRpcCommand, scrubSecrets, sendUrls, type RpcEndpoints } from "../src/env.ts";

const KEY = "FAKEALCHEMYKEY0123456789";
const SPEC_CMD = `printf "http://127.0.0.1:1/v2/${KEY},http://127.0.0.1:2"`;
const ALCHEMY = `https://monad-testnet.g.alchemy.com/v2/${KEY}`;
const PUBLIC = "https://testnet-rpc.monad.xyz";
const WSS = `wss://monad-testnet.g.alchemy.com/v2/${KEY}`;

const env = (o: Record<string, string>): Record<string, string | undefined> => ({ ...o });
const errOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not throw");
};

describe("resolveRpcEndpoints (13.6)", () => {
  test("the spec's command: two HTTP endpoints in order, no websocket", () => {
    const e = resolveRpcEndpoints(env({ AGATE_RPC_URLS_CMD: SPEC_CMD }));
    expect(e).toEqual({ http: [`http://127.0.0.1:1/v2/${KEY}`, "http://127.0.0.1:2"], ws: [] });
  });

  test("the operator's shape: Alchemy first, the public RPC second, Alchemy's wss for subscriptions", () => {
    const e = resolveRpcEndpoints(env({ AGATE_RPC_URLS_CMD: `printf '%s,%s,%s' '${ALCHEMY}' '${PUBLIC}' '${WSS}'` }));
    expect(e).toEqual({ http: [ALCHEMY, PUBLIC], ws: [WSS] });
  });

  test("precedence: the command, else AGATE_RPC_URLS, else AGATE_RPC_URL", () => {
    expect(resolveRpcEndpoints(env({ AGATE_RPC_URLS_CMD: "printf http://a.test", AGATE_RPC_URL: "http://c.test" })).http).toEqual(["http://a.test"]);
    expect(resolveRpcEndpoints(env({ AGATE_RPC_URLS: "http://b.test, http://b2.test", AGATE_RPC_URL: "http://c.test" })).http).toEqual(["http://b.test", "http://b2.test"]);
    expect(resolveRpcEndpoints(env({ AGATE_RPC_URL: "http://c.test" }))).toEqual({ http: ["http://c.test"], ws: [] });
    expect(errOf(() => resolveRpcEndpoints(env({})))).toContain("set AGATE_RPC_URLS_CMD or AGATE_RPC_URLS");
  });

  test("both AGATE_RPC_URLS_CMD and AGATE_RPC_URLS set: refused", () => {
    expect(errOf(() => resolveRpcEndpoints(env({ AGATE_RPC_URLS_CMD: SPEC_CMD, AGATE_RPC_URLS: "http://b.test" })))).toBe(
      "set one of AGATE_RPC_URLS_CMD and AGATE_RPC_URLS",
    );
  });

  test("newline-separated output and surrounding blanks", () => {
    const e = resolveRpcEndpoints(env({ AGATE_RPC_URLS_CMD: `printf '\\n %s\\n\\nwss://w.test/x\\nhttp://b.test\\n' '${ALCHEMY}'` }));
    expect(e).toEqual({ http: [ALCHEMY, "http://b.test"], ws: ["wss://w.test/x"] });
  });

  test("the four failures name the variable and never echo the output", () => {
    const cases: [string, string][] = [
      [`printf '${ALCHEMY}'; exit 1`, "AGATE_RPC_URLS_CMD failed (exit 1)"],
      [`printf '' `, "AGATE_RPC_URLS_CMD did not print a list of URLs"],
      [`printf 'not a url ${KEY}'`, "AGATE_RPC_URLS_CMD did not print a list of URLs"],
      [`printf 'ftp://x.test/${KEY}'`, "AGATE_RPC_URLS_CMD did not print a list of URLs"],
      [`printf '${WSS}'`, "AGATE_RPC_URLS_CMD did not print a list of URLs"], // no HTTP entry
      [`printf '${ALCHEMY},garbage${KEY}'`, "AGATE_RPC_URLS_CMD did not print a list of URLs"],
    ];
    for (const [cmd, msg] of cases) {
      const m = errOf(() => resolveRpcEndpoints(env({ AGATE_RPC_URLS_CMD: cmd })));
      expect(m).toBe(msg);
      expect(m).not.toContain(KEY);
    }
  });

  test("a command that hangs is stopped at the timeout", () => {
    const t0 = Date.now();
    const m = errOf(() => runRpcCommand(`sleep 5; printf '${ALCHEMY}'`, 300));
    expect(m).toBe("AGATE_RPC_URLS_CMD timed out after 1 s");
    expect(Date.now() - t0).toBeLessThan(4_000);
    // through resolveRpcEndpoints, a runner's own message passes only in the known safe shapes
    expect(errOf(() => resolveRpcEndpoints(env({ AGATE_RPC_URLS_CMD: "x" }), (c) => runRpcCommand(`sleep 5; ${c}`, 300)))).toBe(
      "AGATE_RPC_URLS_CMD timed out after 1 s",
    );
    expect(errOf(() => resolveRpcEndpoints(env({ AGATE_RPC_URLS_CMD: "x" }), () => {
      throw new Error(`boom ${ALCHEMY}`);
    }))).toBe("AGATE_RPC_URLS_CMD failed");
  });

  test("a bad AGATE_RPC_URLS entry is refused without echo; an empty command is refused", () => {
    const m = errOf(() => resolveRpcEndpoints(env({ AGATE_RPC_URLS: `${ALCHEMY},x${KEY}` })));
    expect(m).toBe("AGATE_RPC_URLS is not a list of http(s) or ws(s) URLs");
    expect(errOf(() => resolveRpcEndpoints(env({ AGATE_RPC_URLS_CMD: "  " })))).toBe("AGATE_RPC_URLS_CMD is empty");
  });

  test("the command runs with PATH and HOME only: a role key still in process.env never reaches it (M3)", () => {
    // every caller resolves its endpoints before it removes its role key from process.env (writers, watcher, guardian)
    const keys = { AGATE_STANDBY_KEY: `0x${"5a".repeat(32)}`, AGATE_ATTESTER_KEY: `0x${"a7".repeat(32)}`, AGATE_GUARDIAN_KEY: `0x${"9d".repeat(32)}` };
    Object.assign(process.env, keys);
    try {
      const seen = runRpcCommand("/usr/bin/env");
      for (const v of Object.values(keys)) expect(seen).not.toContain(v.slice(2));
      const names = seen.trim().split("\n").map((l) => l.split("=")[0]!).filter((n) => !["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"].includes(n));
      expect(names.sort()).toEqual(["HOME", "PATH"]);
      expect(childEnv()).toEqual({ PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/" });
      // the operator's command shape still works: PATH finds its tools, HOME its keychain
      const e = resolveRpcEndpoints(env({ AGATE_RPC_URLS_CMD: `k="$(printf ${KEY})" && printf 'http://127.0.0.1:1/v2/%s,http://127.0.0.1:2' "$k"` }));
      expect(e.http).toEqual([`http://127.0.0.1:1/v2/${KEY}`, "http://127.0.0.1:2"]);
      expect(runRpcCommand('printf "%s" "${AGATE_STANDBY_KEY:-unset}"')).toBe("unset");
    } finally {
      for (const k of Object.keys(keys)) delete process.env[k];
    }
  });

  test("after reading, AGATE_RPC_URLS_CMD and AGATE_RPC_URLS leave the environment (no child inherits them)", () => {
    const a = env({ AGATE_RPC_URLS_CMD: SPEC_CMD, OTHER: "1" });
    resolveRpcEndpoints(a);
    expect(a).toEqual({ OTHER: "1" });
    const b = env({ AGATE_RPC_URLS: "http://b.test", AGATE_RPC_URL: "http://c.test" });
    resolveRpcEndpoints(b);
    expect(b).toEqual({ AGATE_RPC_URL: "http://c.test" });
  });
});

describe("redactUrl", () => {
  test("shapes", () => {
    expect(redactUrl(ALCHEMY)).toBe("https://monad-testnet.g.alchemy.com/...");
    expect(redactUrl(WSS)).toBe("wss://monad-testnet.g.alchemy.com/...");
    expect(redactUrl(PUBLIC)).toBe(PUBLIC);
    expect(redactUrl(`${PUBLIC}/`)).toBe(PUBLIC);
    expect(redactUrl("http://127.0.0.1:8545")).toBe("http://127.0.0.1:8545");
    expect(redactUrl(`http://127.0.0.1:1/v2/${KEY}`)).toBe("http://127.0.0.1:1/...");
    expect(redactUrl(`https://rpc.test/?apikey=${KEY}`)).toBe("https://rpc.test/...");
    expect(redactUrl(`https://user:${KEY}@rpc.test`)).toBe("https://rpc.test/...");
    expect(redactUrl(`not a url ${KEY}`)).toBe("<url>");
  });
});

describe("scrubSecrets", () => {
  const e: RpcEndpoints = { http: [ALCHEMY, PUBLIC, `https://q.test/rpc?apikey=QUERYSECRET123456&x=1`], ws: [WSS] };
  test("every configured URL, and every long path segment or query value, is replaced", () => {
    const lines = [
      `start: rpc ${ALCHEMY} and ${PUBLIC}`,
      `ws ${WSS} failed`,
      `HTTP request failed. URL: ${ALCHEMY}/ Request body: {"method":"eth_chainId"}`,
      JSON.stringify({ error: `fetch ${ALCHEMY}` }),
      `the key alone: ${KEY}; percent-encoded path stays caught`,
      `https://q.test/rpc?apikey=QUERYSECRET123456&x=1 and QUERYSECRET123456`,
    ];
    for (const l of lines) {
      const s = scrubSecrets(l, e);
      expect(s).not.toContain(KEY);
      expect(s).not.toContain("QUERYSECRET123456");
    }
    expect(scrubSecrets(`rpc ${ALCHEMY} down`, e)).toBe("rpc https://monad-testnet.g.alchemy.com/... down");
    expect(scrubSecrets(`only ${KEY}`, e)).toBe("only <redacted>");
    expect(scrubSecrets("nothing secret here: v2, monad", e)).toBe("nothing secret here: v2, monad");
  });
});

describe("installScrubber (a child process: the scrubber wraps that process's console and streams)", () => {
  test("console, stdout and stderr writes, and an uncaught error never show the key", async () => {
    const mod = join(import.meta.dir, "../src/env.ts");
    const code = `
      import { resolveRpcEndpoints, installScrubber } from ${JSON.stringify(mod)};
      const e = resolveRpcEndpoints(process.env);
      installScrubber(e);
      const url = e.http[0];
      console.log("start", e.http, e.ws);
      console.info({ url });
      console.warn("warn %s", url);
      console.error(new Error("HTTP request failed. URL: " + url));
      process.stdout.write("raw " + url + "\\n");
      process.stderr.write(new TextEncoder().encode("bytes " + url + "\\n"));
      console.log("env after:", process.env.AGATE_RPC_URLS_CMD ?? "unset");
      setTimeout(() => { throw new Error("uncaught " + url); }, 0);
    `;
    const p = Bun.spawn(["bun", "-e", code], { env: { ...process.env, AGATE_RPC_URLS_CMD: SPEC_CMD, AGATE_RPC_URLS: undefined }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const all = out + err;
    expect(all).not.toContain(KEY);
    expect(all).toContain("http://127.0.0.1:1/...");
    expect(all).toContain("raw http://127.0.0.1:1/...");
    expect(all).toContain("bytes http://127.0.0.1:1/...");
    expect(all).toContain("env after: unset");
    expect(err).toContain("uncaught http://127.0.0.1:1/...");
    expect(exit).toBe(1);
  });
});

describe("send: entries (Oct 4): the senders' own transactions", () => {
  const SEND = `send:${ALCHEMY}`;
  test("parsed into RpcEndpoints.send in order, http(s) only; reads keep the http list; the old shape has no send", () => {
    const e = resolveRpcEndpoints(env({ AGATE_RPC_URLS_CMD: `printf '%s,%s,%s,%s' '${SEND}' '${PUBLIC}' 'send: http://127.0.0.1:9/v2/${KEY}' '${WSS}'` }));
    expect(e).toEqual({ http: [PUBLIC], ws: [WSS], send: [ALCHEMY, `http://127.0.0.1:9/v2/${KEY}`] });
    expect(sendUrls(e)).toEqual([ALCHEMY, `http://127.0.0.1:9/v2/${KEY}`]);
    // backward compatible: a list without send: entries resolves exactly as before Oct 4
    const old = resolveRpcEndpoints(env({ AGATE_RPC_URLS: `${ALCHEMY},${PUBLIC},${WSS}` }));
    expect(old).toEqual({ http: [ALCHEMY, PUBLIC], ws: [WSS] });
    expect("send" in old).toBe(false);
    expect(sendUrls(old)).toEqual([]);
    // newline-separated works too
    expect(resolveRpcEndpoints(env({ AGATE_RPC_URLS: `${SEND}\n${PUBLIC}` }))).toEqual({ http: [PUBLIC], ws: [], send: [ALCHEMY] });
  });

  test("refused without echo: a send: websocket, a send: that is no URL, a list with send: entries only (nothing to read from)", () => {
    const cases: [Record<string, string>, string][] = [
      [{ AGATE_RPC_URLS_CMD: `printf '%s,%s' 'send:${WSS}' '${PUBLIC}'` }, "AGATE_RPC_URLS_CMD did not print a list of URLs"],
      [{ AGATE_RPC_URLS_CMD: `printf '%s,%s' 'send:nope${KEY}' '${PUBLIC}'` }, "AGATE_RPC_URLS_CMD did not print a list of URLs"],
      [{ AGATE_RPC_URLS_CMD: `printf '%s' '${SEND}'` }, "AGATE_RPC_URLS_CMD did not print a list of URLs"],
      [{ AGATE_RPC_URLS_CMD: `printf '%s,%s' '${SEND}' '${WSS}'` }, "AGATE_RPC_URLS_CMD did not print a list of URLs"],
      [{ AGATE_RPC_URLS: `${SEND},sendx:${PUBLIC}` }, "AGATE_RPC_URLS is not a list of http(s) or ws(s) URLs"],
      [{ AGATE_RPC_URLS: `SEND:${ALCHEMY},${PUBLIC}` }, "AGATE_RPC_URLS is not a list of http(s) or ws(s) URLs"],
    ];
    for (const [e, msg] of cases) {
      const m = errOf(() => resolveRpcEndpoints(env(e)));
      expect(m).toBe(msg);
      expect(m).not.toContain(KEY);
    }
  });

  test("redaction and the scrubber cover the send endpoints", () => {
    const e = resolveRpcEndpoints(env({ AGATE_RPC_URLS: `${SEND},${PUBLIC},send:https://rpc.other.test/?apikey=SENDQUERYSECRET99` }));
    for (const l of [`sent via ${ALCHEMY}`, `key ${KEY}`, `HTTP request failed. URL: ${ALCHEMY}/`, "https://rpc.other.test/?apikey=SENDQUERYSECRET99", "SENDQUERYSECRET99"]) {
      const s = scrubSecrets(l, e);
      expect(s).not.toContain(KEY);
      expect(s).not.toContain("SENDQUERYSECRET99");
    }
    expect(scrubSecrets(`send ${ALCHEMY} down`, e)).toBe("send https://monad-testnet.g.alchemy.com/... down");
    expect(sendUrls(e).map(redactUrl)).toEqual(["https://monad-testnet.g.alchemy.com/...", "https://rpc.other.test/..."]);
  });

  test("installScrubber in a child: a send endpoint's key never shows (console, streams, an uncaught error)", async () => {
    const mod = join(import.meta.dir, "../src/env.ts");
    const code = `
      import { resolveRpcEndpoints, installScrubber, sendUrls } from ${JSON.stringify(mod)};
      const e = resolveRpcEndpoints(process.env);
      installScrubber(e);
      const url = sendUrls(e)[0];
      console.log("send", e.send, "http", e.http);
      process.stdout.write("raw " + url + "\\n");
      setTimeout(() => { throw new Error("uncaught " + url); }, 0);
    `;
    const p = Bun.spawn(["bun", "-e", code], { env: { ...process.env, AGATE_RPC_URLS_CMD: `printf 'send:http://127.0.0.1:7/v2/${KEY},http://127.0.0.1:2'`, AGATE_RPC_URLS: undefined }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(out + err).not.toContain(KEY);
    expect(out).toContain("raw http://127.0.0.1:7/...");
    expect(err).toContain("uncaught http://127.0.0.1:7/...");
    expect(exit).toBe(1);
  });
});
