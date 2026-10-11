import { beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { publicApp } from "../src/app.ts";
import { type DynamicUser, toUser } from "../src/dynamic/jwt.ts";
import { byoaKeys } from "../src/passkey/keys.ts";
import { passkeyOrigins } from "../src/passkey/routes.ts";
import { Store } from "../src/store.ts";
import { FakePasskey } from "./webauthn-fake.ts";

const ORIGIN = "https://agate.elpabl0.xyz";
const RP = "agate.elpabl0.xyz";
const ISS = "https://agate.elpabl0.xyz";
const AUD = "db2880bd-e52a-4f00-aa83-2c3ec77281cb";
const PEM = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

type Json = Record<string, any>;

function fixture() {
  let t = Date.parse("2026-10-11T03:00:00Z");
  let ip = 0;
  const logs: Record<string, unknown>[] = [];
  const store = new Store(":memory:");
  /** Dynamic sessions by bearer token: "s:<sub>" is the passkey account's session, "email" an email account */
  const users: Record<string, DynamicUser> = {};
  /** what Dynamic's management API answers: the passkey account of a Dynamic user id */
  const dynamicSubs: Record<string, string> = {};
  const app = publicApp({
    store,
    log: (e) => logs.push(e),
    byoaKeyPem: () => PEM,
    passkeyOrigins: new Map([[ORIGIN, RP], ["http://localhost:5174", "localhost"]]),
    passkeyNow: () => t,
    verifyUser: async (tok) => users[tok] ?? Promise.reject(new Error("bad token")),
    externalSubOf: async (userId) => {
      if (userId === "dyn-down") throw new Error("Dynamic user lookup failed (502)");
      return dynamicSubs[userId] ?? null;
    },
    agateClient: () => ({}) as never,
  });
  const post = async (path: string, body: unknown, h: Record<string, string> = {}) => {
    const r = await app.request(path, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": `10.0.0.${++ip}`, ...h }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Json, headers: r.headers };
  };
  const options = (h: Record<string, string> = {}) => post("/api/passkey/options", {}, h);
  const signUp = async (pk = new FakePasskey()) => {
    const o = (await options()).body;
    const r = await post("/api/passkey/register", { ceremonyId: o.register.ceremonyId, response: pk.create(o.register.options, { origin: ORIGIN }) });
    return { pk, r, sub: r.body.sub as string };
  };
  const session = (sub: string, userId = `dyn-${sub}`) => {
    users[`s:${sub}`] = { userId, email: null, wallets: new Map(), scopes: [], externalSub: sub };
    return { authorization: `Bearer s:${sub}` };
  };
  /** the app's real session: a minified JWT, so no externalSub; Dynamic knows the account */
  const minified = (sub: string, userId = `dyn-${sub}`) => {
    users[`m:${sub}`] = { userId, email: null, wallets: new Map(), scopes: [], externalSub: null };
    dynamicSubs[userId] = sub;
    return { authorization: `Bearer m:${sub}` };
  };
  const jwks = async () => createLocalJWKSet((await (await app.request("/.well-known/agate-jwks.json")).json()) as { keys: never[] });
  /** a JWT checked the way Dynamic checks it, 30 s after it was made */
  const verify = async (jwt: string) => jwtVerify(jwt, await jwks(), { issuer: ISS, audience: AUD, currentDate: new Date("2026-10-11T03:00:30Z") });
  return { app, store, logs, users, dynamicSubs, post, options, signUp, session, minified, jwks, verify, tick: (ms: number) => (t += ms), ip: () => `10.0.0.${++ip}` };
}

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});

describe("the public key", () => {
  test("one P-256 key with its thumbprint kid, cached 5 minutes, no private part", async () => {
    const r = await f.app.request("/.well-known/agate-jwks.json");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    const { keys } = (await r.json()) as { keys: Json[] };
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(typeof keys[0]!.kid).toBe("string");
    expect(keys[0]!.d).toBeUndefined();
  });

  test("made on first use at mode 600, then reused: the same key gives the same kid", async () => {
    const home = mkdtempSync(join(tmpdir(), "agate-byoa-"));
    const a = await byoaKeys({ home, aud: AUD }).jwks();
    expect(statSync(join(home, "byoa-es256.pem")).mode & 0o777).toBe(0o600);
    const pem = readFileSync(join(home, "byoa-es256.pem"), "utf8");
    const b = await byoaKeys({ home, aud: AUD }).jwks();
    const c = await byoaKeys({ pem: () => pem, aud: AUD }).jwks();
    expect(b.keys[0]!.kid).toBe(a.keys[0]!.kid!);
    expect(c.keys[0]!.kid).toBe(a.keys[0]!.kid!);
  });
});

describe("options", () => {
  test("only from an allowed origin", async () => {
    expect((await f.options({ origin: "https://evil.example" })).body.code).toBe("origin_not_allowed");
    const r = await f.app.request("/api/passkey/options", { method: "POST", body: "{}" });
    expect(r.status).toBe(403);
  });

  test("a sign-in and a sign-up ceremony, user verification required, discoverable, nothing personal", async () => {
    const { status, body, headers } = await f.options();
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(body.signupClosed).toBe(false);
    expect(body.signin.options).toMatchObject({ rpId: RP, userVerification: "required" });
    expect(body.signin.options.allowCredentials ?? []).toEqual([]);
    const reg = body.register.options;
    expect(reg.rp).toEqual({ name: "Agate", id: RP });
    expect(reg.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(reg.attestation).toBe("none");
    expect(reg.pubKeyCredParams.map((p: Json) => p.alg)).toEqual([-7, -257]);
    expect(reg.user.name).toMatch(/^Agate account [A-Z0-9_-]{4}$/);
    expect(reg.extensions.credProps).toBe(true);
    expect(body.signin.ceremonyId).not.toBe(body.register.ceremonyId);
  });

  test("the localhost row gives rp id localhost", async () => {
    const { body } = await f.options({ origin: "http://localhost:5174" });
    expect(body.register.options.rp.id).toBe("localhost");
  });
});

describe("sign-up", () => {
  test("a new passkey makes an account and a two-minute JWT Dynamic can check", async () => {
    const { r, sub } = await f.signUp();
    expect(r.status).toBe(201);
    expect(sub).toMatch(/^pk_[A-Za-z0-9_-]{22}$/);
    const { payload } = await jwtVerify(r.body.externalJwt, await f.jwks(), { issuer: ISS, audience: AUD, algorithms: ["ES256"], currentDate: new Date("2026-10-11T03:00:30Z") });
    expect(payload.sub).toBe(sub);
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(typeof payload.jti).toBe("string");
    expect(payload.email).toBeUndefined();
    expect(payload.scope).toBeUndefined();
    expect(decodeProtectedHeader(r.body.externalJwt)).toMatchObject({ alg: "ES256", typ: "JWT" });
    expect(f.store.db.query("SELECT COUNT(*) AS n FROM passkey_accounts").get()).toEqual({ n: 1 });
  });

  test("with AGATE_BYOA_EMAIL_DOMAIN a sign-in token carries a verified placeholder address, a step-up token none", async () => {
    process.env.AGATE_BYOA_EMAIL_DOMAIN = "passkey.agate.elpabl0.xyz";
    try {
      const g = fixture();
      const { r, sub, pk } = await g.signUp();
      const { payload } = await g.verify(r.body.externalJwt);
      expect(payload.email).toMatch(/^pk-[0-9a-f]{32}@passkey\.agate\.elpabl0\.xyz$/);
      expect(payload.emailVerified).toBe(true);
      const o = await g.post("/api/passkey/stepup/options", { scope: "wallet:delegate" }, g.session(sub));
      const up = await g.post("/api/passkey/stepup", { ceremonyId: o.body.ceremonyId, response: pk.get(o.body.options, { origin: ORIGIN }) }, g.session(sub));
      const step = await g.verify(up.body.externalJwt);
      expect(step.payload.email).toBeUndefined();
      expect(toUser({ sub: "dyn-1", email: payload.email, verified_credentials: [{ format: "externalUser", public_identifier: sub }] }, "env").email).toBeNull();
      expect(toUser({ sub: "dyn-2", email: "a@b.c" }, "env").email).toBe("a@b.c");
      // a real email linked later wins over the placeholder, wherever Dynamic lists it
      expect(toUser({ sub: "dyn-3", email: payload.email, verified_credentials: [{ format: "email", email: payload.email }, { format: "email", email: "real@x.com" }] }, "env").email).toBe("real@x.com");
    } finally {
      delete process.env.AGATE_BYOA_EMAIL_DOMAIN;
    }
  });

  test("a ceremony is used once", async () => {
    const pk = new FakePasskey();
    const o = (await f.options()).body;
    const body = { ceremonyId: o.register.ceremonyId, response: pk.create(o.register.options, { origin: ORIGIN }) };
    expect((await f.post("/api/passkey/register", body)).status).toBe(201);
    expect((await f.post("/api/passkey/register", body)).body.code).toBe("expired");
  });

  test("two answers to one ceremony at once: exactly one account", async () => {
    const o = (await f.options()).body;
    const [a, b] = [new FakePasskey(), new FakePasskey()];
    const rs = await Promise.all([a, b].map((pk) => f.post("/api/passkey/register", { ceremonyId: o.register.ceremonyId, response: pk.create(o.register.options, { origin: ORIGIN }) })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(f.store.db.query("SELECT COUNT(*) AS n FROM passkey_accounts").get()).toEqual({ n: 1 });
  });

  test("a ceremony ends after 5 minutes", async () => {
    const pk = new FakePasskey();
    const o = (await f.options()).body;
    f.tick(5 * 60_000 + 1);
    expect((await f.post("/api/passkey/register", { ceremonyId: o.register.ceremonyId, response: pk.create(o.register.options, { origin: ORIGIN }) })).body.code).toBe("expired");
  });

  test("a sign-in ceremony cannot register", async () => {
    const pk = new FakePasskey();
    const o = (await f.options()).body;
    const r = await f.post("/api/passkey/register", { ceremonyId: o.signin.ceremonyId, response: pk.create(o.register.options, { origin: ORIGIN }) });
    expect(r.body.code).toBe("expired");
  });

  const refused = async (cd: Json, more: Json = {}, mutate?: (pk: FakePasskey) => void) => {
    const pk = new FakePasskey();
    mutate?.(pk);
    const o = (await f.options()).body;
    const r = await f.post("/api/passkey/register", { ceremonyId: o.register.ceremonyId, response: pk.create(o.register.options, { origin: ORIGIN, ...cd }, more) });
    expect(f.store.db.query("SELECT COUNT(*) AS n FROM passkey_accounts").get()).toEqual({ n: 0 });
    return r.body.code;
  };
  test("another site's origin, an embedded page, a wrong challenge or rp id, or no user verification is refused", async () => {
    expect(await refused({ origin: "https://agate.elpabl0.xyz.evil.example" })).toBe("not_verified");
    expect(await refused({ crossOrigin: true })).toBe("not_verified");
    expect(await refused({ topOrigin: "https://evil.example" })).toBe("not_verified");
    expect(await refused({ challenge: "AAAA" })).toBe("not_verified");
    expect(await refused({ type: "webauthn.get" })).toBe("not_verified");
    expect(await refused({}, { rpId: "evil.example" })).toBe("not_verified");
    expect(await refused({}, {}, (pk) => (pk.flags = 0x01))).toBe("not_verified");
  });

  test("a passkey that cannot sign in by itself is refused", async () => {
    expect(await refused({}, { rk: false })).toBe("not_discoverable");
  });

  test("a passkey that already has an account is refused", async () => {
    const { pk } = await f.signUp();
    const o = (await f.options()).body;
    const r = await f.post("/api/passkey/register", { ceremonyId: o.register.ceremonyId, response: pk.create(o.register.options, { origin: ORIGIN }) });
    expect(r.body.code).toBe("exists");
  });

  test("5 sign-ups an hour per address (failed tries do not count), and a daily cap for everyone", async () => {
    const h = { "x-forwarded-for": "10.9.9.9" };
    const signUpFrom = async () => {
      const pk = new FakePasskey();
      const o = (await f.options()).body;
      return f.post("/api/passkey/register", { ceremonyId: o.register.ceremonyId, response: pk.create(o.register.options, { origin: ORIGIN }) }, h);
    };
    for (let i = 0; i < 6; i++) expect((await f.post("/api/passkey/register", {}, h)).body.code).toBe("bad_request");
    for (let i = 0; i < 5; i++) expect((await signUpFrom()).status).toBe(201);
    const sixth = await signUpFrom();
    expect(sixth.status).toBe(429);
    expect(f.store.db.query("SELECT COUNT(*) AS n FROM passkey_accounts").get()).toEqual({ n: 5 });
    f.tick(3_600_001);
    expect((await signUpFrom()).status).toBe(201);

    process.env.AGATE_PASSKEY_SIGNUPS_PER_DAY = "6";
    try {
      const g = fixture();
      for (let i = 0; i < 6; i++) expect((await g.signUp()).r.status).toBe(201);
      const o = (await g.options()).body;
      expect(o.register).toBeNull();
      expect(o.signupClosed).toBe(true);
      expect((await g.post("/api/passkey/register", {})).body.code).toBe("signups_paused");
      g.tick(86_400_001);
      expect((await g.options()).body.signupClosed).toBe(false);
    } finally {
      delete process.env.AGATE_PASSKEY_SIGNUPS_PER_DAY;
    }
  });

  test("a body that is not a passkey response, or too large, is refused", async () => {
    expect((await f.post("/api/passkey/register", { ceremonyId: "x" })).body.code).toBe("bad_request");
    expect((await f.post("/api/passkey/signin", { ceremonyId: "x", response: { id: "y", response: {} } })).body.code).toBe("bad_request");
    expect((await f.post("/api/passkey/signin", { pad: "x".repeat(17_000) })).status).toBe(413);
  });
});

describe("sign-in", () => {
  const signIn = async (pk: FakePasskey, cd: Json = {}, more: Json = {}) => {
    const o = (await f.options()).body;
    return f.post("/api/passkey/signin", { ceremonyId: o.signin.ceremonyId, response: pk.get(o.signin.options, { origin: ORIGIN, ...cd }, more) });
  };

  test("a known passkey signs in to its own account", async () => {
    const { pk, sub } = await f.signUp();
    const r = await signIn(pk);
    expect(r.status).toBe(200);
    const { payload } = await f.verify(r.body.externalJwt);
    expect(payload.sub).toBe(sub);
    expect(r.body.sub).toBe(sub);
  });

  test("an unknown passkey is a 404 (most likely an older Dynamic passkey)", async () => {
    const r = await signIn(new FakePasskey());
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("unknown_passkey");
  });

  test("a wrong origin, an embedded page, another rp id, another user handle or no user verification is refused", async () => {
    const { pk } = await f.signUp();
    expect((await signIn(pk, { origin: "https://evil.example" })).body.code).toBe("not_verified");
    expect((await signIn(pk, { crossOrigin: true })).body.code).toBe("not_verified");
    expect((await signIn(pk, {}, { rpId: "localhost" })).body.code).toBe("not_verified");
    expect((await signIn(pk, {}, { userHandle: "AAAAAAAA" })).body.code).toBe("not_verified");
    pk.flags = 0x01;
    expect((await signIn(pk)).body.code).toBe("not_verified");
  });

  test("a failed check burns the ceremony", async () => {
    const { pk } = await f.signUp();
    const o = (await f.options()).body;
    const bad = { ceremonyId: o.signin.ceremonyId, response: pk.get(o.signin.options, { origin: "https://evil.example" }) };
    expect((await f.post("/api/passkey/signin", bad)).body.code).toBe("not_verified");
    const good = { ceremonyId: o.signin.ceremonyId, response: pk.get(o.signin.options, { origin: ORIGIN }) };
    expect((await f.post("/api/passkey/signin", good)).body.code).toBe("expired");
  });

  test("a passkey made on localhost does not sign in on the real origin", async () => {
    const pk = new FakePasskey();
    const o = (await f.options({ origin: "http://localhost:5174" })).body;
    expect((await f.post("/api/passkey/register", { ceremonyId: o.register.ceremonyId, response: pk.create(o.register.options, { origin: "http://localhost:5174" }) }, { origin: "http://localhost:5174" })).status).toBe(201);
    expect((await signIn(pk, {}, { rpId: RP })).body.code).toBe("unknown_passkey");
  });

  test("synced passkeys keep counter 0; a counting passkey may never go back", async () => {
    const synced = (await f.signUp()).pk;
    expect((await signIn(synced)).status).toBe(200);
    expect((await signIn(synced)).status).toBe(200);
    const key = new FakePasskey();
    key.counter = 7;
    await f.signUp(key);
    expect((await signIn(key, {}, { counter: 9 })).status).toBe(200);
    expect((await signIn(key, {}, { counter: 9 })).body.code).toBe("not_verified");
    expect((await signIn(key, {}, { counter: 3 })).body.code).toBe("not_verified");
    expect((await signIn(key, {}, { counter: 10 })).status).toBe(200);
  });
});

describe("step-up", () => {
  const stepUp = async (pk: FakePasskey, auth: Record<string, string>, scope = "wallet:delegate", more: Json = {}) => {
    const o = await f.post("/api/passkey/stepup/options", { scope }, auth);
    if (o.status !== 200) return o;
    return f.post("/api/passkey/stepup", { ceremonyId: o.body.ceremonyId, response: pk.get(o.body.options, { origin: ORIGIN }, more) }, auth);
  };

  test("the account's passkey confirms one scope, as a JWT for that scope", async () => {
    const { pk, sub } = await f.signUp();
    const auth = f.session(sub);
    const o = await f.post("/api/passkey/stepup/options", { scope: "wallet:delegate" }, auth);
    expect(o.body.options.allowCredentials.map((k: Json) => k.id)).toEqual([pk.id]);
    const r = await f.post("/api/passkey/stepup", { ceremonyId: o.body.ceremonyId, response: pk.get(o.body.options, { origin: ORIGIN }) }, auth);
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("wallet:delegate");
    const { payload } = await f.verify(r.body.externalJwt);
    expect(payload).toMatchObject({ sub, scope: "wallet:delegate" });
    expect(Date.parse(r.body.expiresAt)).toBe(payload.exp! * 1000);
    expect(f.store.db.query("SELECT dynamic_user_id AS d FROM passkey_accounts").get()).toEqual({ d: `dyn-${sub}` });
  });

  test("a minified session (no verified credentials) finds its passkey account through Dynamic", async () => {
    const { pk, sub } = await f.signUp();
    const r = await stepUp(pk, f.minified(sub));
    expect(r.status).toBe(200);
    const { payload } = await f.verify(r.body.externalJwt);
    expect(payload).toMatchObject({ sub, scope: "wallet:delegate" });
  });

  test("once bound, a step-up needs no lookup at Dynamic", async () => {
    const { pk, sub } = await f.signUp();
    expect((await stepUp(pk, f.minified(sub, "dyn-bound"))).status).toBe(200);
    f.dynamicSubs["dyn-bound"] = "pk_someone_else";
    const again = await stepUp(pk, f.minified(sub, "dyn-bound"));
    expect(again.status).toBe(200);
    expect((await f.verify(again.body.externalJwt)).payload.sub).toBe(sub);
  });

  test("Dynamic not answering the lookup is a 503 to retry, not \"not a passkey account\"", async () => {
    const { pk, sub } = await f.signUp();
    const r = await stepUp(pk, f.minified(sub, "dyn-down"));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("lookup_failed");
  });

  test("needs a session, an allowed scope and a passkey account", async () => {
    const { pk, sub } = await f.signUp();
    expect((await f.post("/api/passkey/stepup/options", { scope: "wallet:delegate" })).status).toBe(401);
    expect((await stepUp(pk, f.session(sub), "wallet:export")).body.code).toBe("scope_not_allowed");
    f.users.email = { userId: "dyn-email", email: "a@b.c", wallets: new Map(), scopes: [], externalSub: null };
    expect((await stepUp(pk, { authorization: "Bearer email" })).body.code).toBe("not_a_passkey_account");
  });

  test("the account binds to its first Dynamic user; another Dynamic user claiming the same sub is refused", async () => {
    const { pk, sub } = await f.signUp();
    expect((await stepUp(pk, f.session(sub))).status).toBe(200);
    const r = await stepUp(pk, f.session(sub, "dyn-someone-else"));
    expect(r.body.code).toBe("dynamic_mismatch");
    expect(f.logs.filter((e) => e.code === "dynamic_mismatch")).toEqual([{ event: "passkey.refused", code: "dynamic_mismatch", why: "bind" }]);
  });

  test("another account's passkey, a sign-in ceremony, or another session cannot finish it", async () => {
    const a = await f.signUp();
    const b = await f.signUp();
    expect((await stepUp(b.pk, f.session(a.sub))).body.code).toBe("not_verified");

    const signin = (await f.options()).body.signin;
    const auth = f.session(a.sub);
    expect((await f.post("/api/passkey/stepup", { ceremonyId: signin.ceremonyId, response: a.pk.get(signin.options, { origin: ORIGIN }) }, auth)).body.code).toBe("expired");

    const o = await f.post("/api/passkey/stepup/options", { scope: "wallet:delegate" }, auth);
    expect((await f.post("/api/passkey/stepup", { ceremonyId: o.body.ceremonyId, response: a.pk.get(o.body.options, { origin: ORIGIN }) }, f.session(b.sub))).body.code).toBe("dynamic_mismatch");
  });

  test("a step-up JWT for one scope is a sign-in JWT for nobody else", async () => {
    const { pk, sub } = await f.signUp();
    const r = await stepUp(pk, f.session(sub), "credential:link");
    expect(r.body.scope).toBe("credential:link");
    const { payload } = await f.verify(r.body.externalJwt);
    expect(payload.sub).toBe(sub);
  });
});

describe("the daily backup", () => {
  test("a full copy at mode 600 that keeps its passkey accounts, the newest 7 kept", async () => {
    await f.signUp();
    const dir = join(mkdtempSync(join(tmpdir(), "agate-backup-")), "backups");
    const day = Date.parse("2026-10-01T12:00:00Z");
    let last = "";
    for (let i = 0; i < 9; i++) last = f.store.backup(dir, 7, day + i * 86_400_000);
    expect(readdirSync(dir).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `agate-server-2026-10-${String(i + 3).padStart(2, "0")}.db`));
    expect(statSync(last).mode & 0o777).toBe(0o600);
    f.store.backup(dir, 7, day + 8 * 86_400_000);
    const copy = new Database(last, { readonly: true });
    expect(copy.query("SELECT COUNT(*) AS n FROM passkey_accounts").get()).toEqual({ n: 1 });
    expect(copy.query("SELECT COUNT(*) AS n FROM passkey_credentials").get()).toEqual({ n: 1 });
    copy.close();
  });
});

describe("logs and parsing", () => {
  test("the app's origins get CORS on the passkey routes, others do not", async () => {
    const pre = (origin: string) => f.app.request("/api/passkey/options", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect((await pre("http://localhost:3317")).headers.get("access-control-allow-origin")).toBe("http://localhost:3317");
    expect((await pre("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
  });

  test("no JWT, challenge, client data or signature reaches a log line", async () => {
    const { pk, r } = await f.signUp();
    const o = (await f.options()).body;
    const resp = pk.get(o.signin.options, { origin: ORIGIN });
    const s = await f.post("/api/passkey/signin", { ceremonyId: o.signin.ceremonyId, response: resp });
    const text = JSON.stringify(f.logs);
    for (const secretish of [r.body.externalJwt, s.body.externalJwt, o.signin.options.challenge, o.register.options.challenge, resp.response.clientDataJSON, resp.response.signature, o.signin.ceremonyId]) expect(text.includes(secretish)).toBe(false);
    expect(f.logs.filter((e) => String(e.event).startsWith("passkey.")).every((e) => Object.keys(e).every((k) => ["event", "code", "rpId", "cred8", "why"].includes(k)))).toBe(true);
  });

  test("AGATE_PASSKEY_ORIGINS pairs an origin with its own host or a parent of it", () => {
    expect([...passkeyOrigins("https://agate.elpabl0.xyz=agate.elpabl0.xyz,http://localhost:5174=localhost")]).toEqual([
      ["https://agate.elpabl0.xyz", "agate.elpabl0.xyz"],
      ["http://localhost:5174", "localhost"],
    ]);
    expect(passkeyOrigins("https://app.agate.elpabl0.xyz=agate.elpabl0.xyz").size).toBe(1);
    expect(() => passkeyOrigins("https://agate.elpabl0.xyz=evil.example")).toThrow();
    expect(() => passkeyOrigins("https://agate.elpabl0.xyz/=agate.elpabl0.xyz")).toThrow();
    expect(() => passkeyOrigins("https://agate.elpabl0.xyz")).toThrow();
    expect(() => passkeyOrigins("agate.elpabl0.xyz=agate.elpabl0.xyz")).toThrow("AGATE_PASSKEY_ORIGINS");
    expect(() => passkeyOrigins("https://agate.elpabl0.xyz=xyz")).toThrow("AGATE_PASSKEY_ORIGINS");
  });

  test("a Dynamic session made from a passkey carries its sub", () => {
    const u = toUser({ sub: "dyn-1", verified_credentials: [{ format: "externalUser", public_identifier: "pk_abc" }, { format: "blockchain", address: "0xAbC", chain: "eip155" }] }, "env");
    expect(u.externalSub).toBe("pk_abc");
    expect(toUser({ sub: "dyn-2", verified_credentials: [{ format: "email", email: "a@b.c" }] }, "env").externalSub).toBeNull();
  });
});
