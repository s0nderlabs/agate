// The app's passkey layer (app/src/passkey.ts) against a fake WebAuthn authenticator, so the parts a human
// cannot be replaced for are still checked: prompt counting, same account on return, the stateless rebuild,
// Mera's fallback second prompt, and the PRF note vault. The fake returns HMAC-SHA256(credentialSecret, salt),
// which is how CTAP hmac-secret behaves; no real passkey or key is involved.
import { beforeAll, describe, expect, test } from "bun:test";

type Cred = { id: Uint8Array<ArrayBuffer>; secret: Uint8Array<ArrayBuffer> };
const creds: Cred[] = [];
let prfAtCreate = true;
let prfSupported = true;

async function prf(secret: Uint8Array<ArrayBuffer>, salt: BufferSource) {
  const k = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, salt));
}
const same = (a: Uint8Array, b: BufferSource) => {
  const bb = b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer);
  return a.length === bb.length && a.every((x, i) => x === bb[i]);
};
const credential = (c: Cred, results?: { first: Uint8Array }, enabled?: boolean) => ({
  type: "public-key",
  rawId: c.id.buffer,
  response: { getTransports: () => ["internal"] },
  getClientExtensionResults: () => ({ prf: { ...(enabled !== undefined ? { enabled } : {}), ...(results ? { results } : {}) } }),
});

const fakeCredentials = {
  async create(o: CredentialCreationOptions) {
    const c = { id: crypto.getRandomValues(new Uint8Array(16)), secret: crypto.getRandomValues(new Uint8Array(32)) };
    creds.push(c);
    const salt = (o.publicKey?.extensions as { prf: { eval: { first: BufferSource } } }).prf.eval.first;
    if (!prfSupported) return credential(c, undefined, false);
    return prfAtCreate ? credential(c, { first: await prf(c.secret, salt) }, true) : credential(c, undefined, true);
  },
  async get(o: CredentialRequestOptions) {
    const allow = o.publicKey?.allowCredentials?.[0]?.id;
    const c = allow ? creds.find((x) => same(x.id, allow)) : creds.at(-1);
    if (!c) throw new Error("NotAllowedError");
    const salt = (o.publicKey?.extensions as { prf: { eval: { first: BufferSource } } }).prf.eval.first;
    return credential(c, prfSupported ? { first: await prf(c.secret, salt) } : undefined);
  },
};

const mem = new Map<string, string>();
let prompts: string[] = [];
let pk: typeof import("../app/src/passkey");

beforeAll(async () => {
  Object.defineProperty(globalThis, "location", { value: { hostname: "localhost" }, configurable: true });
  Object.defineProperty(globalThis.navigator, "credentials", { value: fakeCredentials, configurable: true });
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    },
    configurable: true,
  });
  pk = await import("../app/src/passkey");
  pk.installPromptCounter((kind) => prompts.push(kind));
});

describe("passkey layer with a fake authenticator", () => {
  let first: `0x${string}`;

  test("create = 1 prompt; return visit with the pinned passkey = 1 prompt, same address", async () => {
    prompts = [];
    const a = await pk.createAccount();
    first = a.address;
    expect(prompts).toEqual(["create"]);
    a.session.end();
    prompts = [];
    const pinned = pk.savedCredential();
    expect(pinned?.credentialId).toBe(a.credential.credentialId);
    const b = await pk.signIn(pinned);
    expect(prompts).toEqual(["get"]);
    expect(b.address).toBe(first);
    b.session.end();
  });

  test("stateless test: storage cleared, discoverable sign-in rebuilds the same address", async () => {
    mem.clear();
    expect(pk.savedCredential()).toBeUndefined();
    prompts = [];
    const c = await pk.signIn();
    expect(prompts).toEqual(["get"]);
    expect(c.address).toBe(first);
    c.session.end();
  });

  test("bonus note: sealed in its own PRF namespace, only ciphertext stored, opens again", async () => {
    prompts = [];
    const pinned = pk.savedCredential();
    if (!pinned) throw new Error("no credential");
    const vault = await pk.sealNote(pinned, "long H100 into the Nov roll");
    const stored = JSON.stringify(pk.savedNoteVault());
    expect(stored).not.toContain("H100");
    expect(vault.prfSalt.length).toBeGreaterThan(0);
    expect(await pk.openNote()).toBe("long H100 into the Nov roll");
    expect(prompts).toEqual(["get", "get"]);
  });

  test("authenticator without create-time PRF: Mera shows a second prompt (counted)", async () => {
    prfAtCreate = false;
    prompts = [];
    const d = await pk.createAccount();
    expect(prompts).toEqual(["create", "get"]);
    expect(d.address).not.toBe(first); // every create is a new account
    d.session.end();
    prfAtCreate = true;
  });

  test("no PRF support: a clear message instead of an account", async () => {
    prfSupported = false;
    const err = await pk.createAccount().catch((e) => e);
    expect(pk.describeError(err)).toContain("does not support PRF");
    prfSupported = true;
  });
});
