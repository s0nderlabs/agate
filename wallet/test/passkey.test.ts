// agate's passkey accounts in the browser (dynamic.ts): which dialog opens, what reaches Dynamic and in what order,
// and how each failure is named, with WebAuthn, agate's server and Dynamic's sign-in mocked.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const real = await import("@dynamic-labs-sdk/client");
const realCore = await import("@dynamic-labs-sdk/client/core");
const calls: string[] = [];
let dynamicSignIn: (a: { externalJwt?: string; sessionPublicKey?: string }) => Promise<unknown> = async () => ({});
let elevate: (a: { externalJwt: string }) => Promise<unknown> = async () => ({});
let browserCreate: (o: unknown) => Promise<unknown> = async () => ({ id: "cred-new", response: { clientDataJSON: "cd" } });
let browserGet: (o: unknown) => Promise<unknown> = async () => ({ id: "cred-old", response: { clientDataJSON: "cd" } });

mock.module("@dynamic-labs-sdk/client", () => ({
  ...real,
  signInWithExternalJwt: (a: { externalJwt?: string; sessionPublicKey?: string }) => (calls.push("dynamic.signin"), dynamicSignIn(a)),
  requestExternalAuthElevatedToken: (a: { externalJwt: string }) => (calls.push("dynamic.elevate"), elevate(a)),
  logout: async (c: { user: unknown }) => (calls.push("dynamic.logout"), (c.user = null)),
}));
mock.module("@dynamic-labs-sdk/client/core", () => ({ ...realCore, getSessionKeys: () => ({ publicKey: "session-pk" }) }));
mock.module("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: async () => false,
  startRegistration: (o: unknown) => (calls.push("browser.create"), browserCreate(o)),
  startAuthentication: (o: unknown) => (calls.push("browser.get"), browserGet(o)),
}));

const lib = await import("../src/dynamic.ts");
const SERVER = "https://agate-1.example/";
const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJwa194In0.c2ln";

class MemoryStorage {
  private m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, String(v));
  removeItem = (k: string) => void this.m.delete(k);
  values = () => [...this.m.values()];
}

type Reply = { status?: number; body: unknown } | Error;
let routes: Record<string, Reply | ((body: any, headers: Headers) => Reply)>;
let requests: { path: string; body: any; headers: Headers }[];
const optionsReply = (register = true) => ({ body: { signin: { ceremonyId: "c-in", options: { challenge: "in" } }, register: register ? { ceremonyId: "c-reg", options: { challenge: "reg" } } : null, signupClosed: !register } });
const client = (user: unknown = null) => ({ user, token: user ? "dyn-session" : null }) as never as Parameters<typeof lib.continueWithPasskey>[0];

const realFetch = globalThis.fetch;
beforeEach(() => {
  calls.length = 0;
  requests = [];
  dynamicSignIn = async () => ({});
  elevate = async () => ({});
  browserCreate = async () => ({ id: "cred-new", response: { clientDataJSON: "cd" } });
  browserGet = async () => ({ id: "cred-old", response: { clientDataJSON: "cd" } });
  routes = {
    "/api/passkey/options": optionsReply(),
    "/api/passkey/register": { status: 201, body: { externalJwt: JWT, sub: "pk_new" } },
    "/api/passkey/signin": { body: { externalJwt: JWT, sub: "pk_old" } },
    "/api/passkey/stepup/options": { body: { ceremonyId: "c-up", options: { challenge: "up" } } },
    "/api/passkey/stepup": { body: { externalJwt: JWT, scope: "wallet:delegate", expiresAt: "2026-10-11T03:02:00.000Z" } },
  };
  (globalThis as any).localStorage = new MemoryStorage();
  (globalThis as any).sessionStorage = new MemoryStorage();
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    requests.push({ path, body, headers });
    calls.push(`agate${path}`);
    expect(init.credentials).toBe("omit");
    let r = routes[path] ?? { status: 404, body: { error: "not found" } };
    if (typeof r === "function") r = r(body, headers);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const failure = (p: Promise<unknown>) => p.then(() => null, (e: InstanceType<typeof lib.AgatePasskeyError>) => ({ code: e.code, name: e.name, status: e.status }));

describe("continue with a passkey", () => {
  test("a browser that never used one makes a new account: one dialog, the hint before Dynamic, the session key passed", async () => {
    let hintAtSignIn = false;
    let seen: { externalJwt?: string; sessionPublicKey?: string } = {};
    dynamicSignIn = async (a) => ((hintAtSignIn = lib.hasPasskeyHint()), (seen = a), {});
    expect(lib.hasPasskeyHint()).toBe(false);
    const r = await lib.continueWithPasskey(client(), SERVER);
    expect(r).toEqual({ sub: "pk_new", created: true });
    expect(calls).toEqual(["agate/api/passkey/options", "browser.create", "agate/api/passkey/register", "dynamic.signin"]);
    expect(requests[1]!.body).toEqual({ ceremonyId: "c-reg", response: { id: "cred-new", response: { clientDataJSON: "cd" } } });
    expect(hintAtSignIn).toBe(true);
    expect(seen).toEqual({ externalJwt: JWT, sessionPublicKey: "session-pk" });
  });

  test("a browser that used one signs in; 'I already have a passkey' forces sign-in, 'create' forces a new account", async () => {
    (globalThis as any).localStorage.setItem("agate-passkey-v1", "{}");
    expect(await lib.continueWithPasskey(client(), SERVER)).toEqual({ sub: "pk_old", created: false });
    expect(calls).toContain("browser.get");
    (globalThis as any).localStorage = new MemoryStorage();
    calls.length = 0;
    expect((await lib.continueWithPasskey(client(), SERVER, { mode: "signin" })).created).toBe(false);
    expect(calls).not.toContain("browser.create");
    (globalThis as any).localStorage.setItem("agate-passkey-v1", "{}");
    expect((await lib.continueWithPasskey(client(), SERVER, { mode: "create" })).created).toBe(true);
  });

  test("prepared ceremonies open the dialog with no fetch first, are used once, and not after 4 minutes", async () => {
    const prepared = await lib.preparePasskey(SERVER);
    calls.length = 0;
    await lib.createAccountWithPasskey(client(), SERVER, prepared);
    expect(calls[0]).toBe("browser.create");
    calls.length = 0;
    await lib.createAccountWithPasskey(client(), SERVER, prepared);
    expect(calls[0]).toBe("agate/api/passkey/options");
    const stale = { ...(await lib.preparePasskey(SERVER)), at: Date.now() - 4 * 60_000 - 1 };
    calls.length = 0;
    await lib.signInWithAgatePasskey(client(), SERVER, stale);
    expect(calls[0]).toBe("agate/api/passkey/options");
  });

  test("someone signed in is signed out only after the dialog, so closing it changes nothing", async () => {
    const c = client({ id: "someone" });
    await lib.createAccountWithPasskey(c, SERVER);
    expect(calls).toEqual(["agate/api/passkey/options", "browser.create", "agate/api/passkey/register", "dynamic.logout", "dynamic.signin"]);
    calls.length = 0;
    browserCreate = async () => Promise.reject(Object.assign(new Error("closed"), { name: "NotAllowedError" }));
    const c2 = client({ id: "someone" });
    expect((await failure(lib.createAccountWithPasskey(c2, SERVER)))?.code).toBe("cancelled");
    expect(calls).not.toContain("dynamic.logout");
  });

  test("the JWT is never stored", async () => {
    await lib.continueWithPasskey(client(), SERVER);
    await lib.continueWithPasskey(client(), SERVER, { mode: "signin" });
    for (const s of [(globalThis as any).localStorage, (globalThis as any).sessionStorage]) expect(s.values().some((v: string) => v.includes("eyJ"))).toBe(false);
  });
});

describe("every failure has a code", () => {
  test("the browser's dialog", async () => {
    browserCreate = async () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError", code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" }));
    expect(await failure(lib.createAccountWithPasskey(client(), SERVER))).toMatchObject({ code: "cancelled", name: "AgatePasskeyError" });
    browserCreate = async () => Promise.reject(Object.assign(new Error("x"), { name: "InvalidStateError", code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" }));
    expect((await failure(lib.createAccountWithPasskey(client(), SERVER)))?.code).toBe("exists");
    browserGet = async () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError", code: "ERROR_CEREMONY_ABORTED" }));
    expect((await failure(lib.signInWithAgatePasskey(client(), SERVER)))?.code).toBe("cancelled");
    expect(calls.filter((c) => c === "dynamic.signin")).toHaveLength(0);
  });

  test("agate's answers", async () => {
    routes["/api/passkey/signin"] = { status: 404, body: { error: "agate does not know this passkey", code: "unknown_passkey" } };
    expect(await failure(lib.signInWithAgatePasskey(client(), SERVER))).toMatchObject({ code: "unknown_passkey", status: 404 });
    routes["/api/passkey/signin"] = { status: 400, body: { error: "ended", code: "expired" } };
    expect((await failure(lib.signInWithAgatePasskey(client(), SERVER)))?.code).toBe("expired");
    routes["/api/passkey/signin"] = { status: 400, body: { error: "no", code: "not_verified" } };
    expect((await failure(lib.signInWithAgatePasskey(client(), SERVER)))?.code).toBe("rejected");
    routes["/api/passkey/register"] = { status: 429, body: { error: "slow", code: "rate_limited" } };
    expect((await failure(lib.createAccountWithPasskey(client(), SERVER)))?.code).toBe("rate_limited");
    routes["/api/passkey/register"] = { status: 403, body: { error: "paused", code: "signups_paused" } };
    expect((await failure(lib.createAccountWithPasskey(client(), SERVER)))?.code).toBe("signups_paused");
    routes["/api/passkey/register"] = { status: 409, body: { error: "has one", code: "exists" } };
    expect((await failure(lib.createAccountWithPasskey(client(), SERVER)))?.code).toBe("exists");
    routes["/api/passkey/options"] = optionsReply(false);
    calls.length = 0;
    expect((await failure(lib.createAccountWithPasskey(client(), SERVER)))?.code).toBe("signups_paused");
    expect(calls).not.toContain("browser.create");
  });

  test("the server unreachable or failing", async () => {
    routes["/api/passkey/options"] = new TypeError("fetch failed");
    expect((await failure(lib.signInWithAgatePasskey(client(), SERVER)))?.code).toBe("service");
    routes["/api/passkey/options"] = { status: 502, body: null };
    expect((await failure(lib.signInWithAgatePasskey(client(), SERVER)))?.code).toBe("service");
  });

  test("Dynamic refusing the JWT is never retried", async () => {
    dynamicSignIn = async () => Promise.reject(new real.InvalidExternalAuthError({ cause: new Error("jwt") }));
    expect((await failure(lib.createAccountWithPasskey(client(), SERVER)))?.code).toBe("dynamic");
    expect(calls.filter((c) => c === "dynamic.signin")).toHaveLength(1);
    expect(lib.hasPasskeyHint()).toBe(true);
    dynamicSignIn = async () => Promise.reject(new real.SandboxMaximumThresholdReachedError({ cause: new Error("cap") }));
    expect((await failure(lib.signInWithAgatePasskey(client(), SERVER)))?.code).toBe("signups_paused");
  });
});

describe("confirm it's you with an agate passkey", () => {
  test("the session goes along, and Dynamic gets the step-up JWT for the scope", async () => {
    let elevated = "";
    elevate = async (a) => ((elevated = a.externalJwt), {});
    await lib.confirmWithAgatePasskey(client({ id: "u", verifiedCredentials: [] }), SERVER, "wallet:delegate");
    expect(calls).toEqual(["agate/api/passkey/stepup/options", "browser.get", "agate/api/passkey/stepup", "dynamic.elevate"]);
    expect(requests[0]!.body).toEqual({ scope: "wallet:delegate" });
    expect(requests.every((r) => r.headers.get("authorization") === "Bearer dyn-session")).toBe(true);
    expect(requests[1]!.body.ceremonyId).toBe("c-up");
    expect(elevated).toBe(JWT);
  });

  test("signed out, it asks to sign in first", async () => {
    expect((await failure(lib.confirmWithAgatePasskey(client(), SERVER, "wallet:delegate")))?.code).toBe("rejected");
    expect(calls).toEqual([]);
  });

  test("a passkey account is the one with an externalUser credential", () => {
    expect(lib.isAgatePasskeyAccount(client({ verifiedCredentials: [{ format: "externalUser", publicIdentifier: "pk_x" }] }))).toBe(true);
    expect(lib.isAgatePasskeyAccount(client({ verifiedCredentials: [{ format: "email" }, { format: "passkey" }] }))).toBe(false);
    expect(lib.isAgatePasskeyAccount(client())).toBe(false);
  });
});

describe("the email to show", () => {
  test("a passkey account's placeholder address is never shown", () => {
    const placeholder = "pk-0123456789abcdef0123456789abcdef@passkey.agate.elpabl0.xyz";
    expect(lib.shownEmail(client({ email: placeholder }))).toBeNull();
    expect(lib.shownEmail(client({ email: "a@b.c" }))).toBe("a@b.c");
    expect(lib.shownEmail(client())).toBeNull();
    expect(lib.shownEmail(client({ email: placeholder, verifiedCredentials: [{ format: "email", email: placeholder }, { format: "email", email: "real@x.com" }] }))).toBe("real@x.com");
  });
});
