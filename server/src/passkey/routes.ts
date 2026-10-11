// Passkey accounts over HTTP: sign up and sign in with a passkey alone, and confirm a sensitive step with it.
// agate runs the WebAuthn ceremony and, once the passkey checks out, answers a JWT that lives 60 seconds; the app
// hands it to Dynamic (signInWithExternalJwt, or requestExternalAuthElevatedToken for a step-up) and never stores it.
//   GET  /.well-known/agate-jwks.json   the public key Dynamic checks those JWTs with
//   POST /api/passkey/options           a sign-in and a sign-up ceremony at once, so a tap needs no network wait
//   POST /api/passkey/register          a new passkey -> a new account -> 201 { externalJwt, sub }
//   POST /api/passkey/signin            a known passkey -> { externalJwt, sub }
//   POST /api/passkey/stepup/options    (Dynamic session) a ceremony for one scope, this account's passkeys only
//   POST /api/passkey/stepup            (Dynamic session) -> { externalJwt, scope, expiresAt }
// Every ceremony is single use and lives 5 minutes; its origin and rp id come from the allowlist row the request's
// Origin picked, never from the request body. Errors are { error: <sentence>, code }. Logs carry only the event, a
// code, the rp id and the first 8 characters of a credential id: never a JWT, a WebAuthn response or a challenge.
import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeClientDataJSON, isoBase64URL } from "@simplewebauthn/server/helpers";
import type { DynamicUser } from "../dynamic/jwt.ts";
import { envInt } from "../oauth/routes.ts";
import { RateLimiter, clientIp } from "../ratelimit.ts";
import type { ByoaKeys } from "./keys.ts";
import type { Ceremony, CeremonyKind, PasskeyStore } from "./store.ts";

const CEREMONY_MS = 5 * 60_000;
const PROMPT_MS = 120_000;
const DAY_MS = 86_400_000;
const ALGS = [-7, -257];
/** what a passkey step-up may unlock; never wallet:export or anything else */
export const STEP_UP_SCOPES = new Set(["wallet:delegate", "credential:link"]);

/** AGATE_PASSKEY_ORIGINS: "origin=rpId" pairs, comma separated. An rp id must be the origin's host or a parent of
 *  it, and a real domain (localhost, or a name with a dot): the browser refuses anything else, so a typo fails here
 *  at start, not at someone's first tap. */
export function passkeyOrigins(raw = process.env.AGATE_PASSKEY_ORIGINS ?? "https://agate.elpabl0.xyz=agate.elpabl0.xyz"): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [origin = "", rpId = ""] = pair.split("=");
    let url: URL | null = null;
    try {
      url = new URL(origin);
    } catch {
      // reported below
    }
    const host = url?.hostname ?? "";
    const domain = rpId === "localhost" || rpId.includes(".");
    if (!url || url.origin !== origin || !domain || (host !== rpId && !host.endsWith(`.${rpId}`))) throw new Error(`AGATE_PASSKEY_ORIGINS: "${pair}" is not origin=rpId`);
    m.set(origin, rpId);
  }
  return m;
}

export type PasskeyDeps = {
  store: PasskeyStore;
  keys: ByoaKeys;
  /** the app's Dynamic-session check: the user, or the 401 to answer */
  authed: (c: Context) => Promise<DynamicUser | Response>;
  /** the passkey account of a Dynamic user, from Dynamic: the app's session JWT is the minified one, which carries no
   *  verified credentials, so u.externalSub is often null */
  externalSubOf: (userId: string) => Promise<string | null>;
  log: (e: Record<string, unknown>) => void;
  origins: Map<string, string>;
  now?: () => number;
};

type Answer = { status: 400 | 403 | 404 | 409 | 429 | 503; code: string; error: string };
const A = {
  origin: { status: 403, code: "origin_not_allowed", error: "passkeys work only from the Agate app" },
  limited: { status: 429, code: "rate_limited", error: "too many passkey requests: wait a minute and try again" },
  signupLimited: { status: 429, code: "rate_limited", error: "too many new accounts from this network: try again in an hour" },
  paused: { status: 403, code: "signups_paused", error: "new passkey accounts are paused for today: sign up with email or Google" },
  bad: { status: 400, code: "bad_request", error: "the request is not a passkey response" },
  expired: { status: 400, code: "expired", error: "this passkey request has ended: try again" },
  notVerified: { status: 400, code: "not_verified", error: "the passkey could not be verified: try again" },
  notDiscoverable: { status: 400, code: "not_discoverable", error: "this passkey cannot sign in by itself: use another passkey manager, or email" },
  exists: { status: 409, code: "exists", error: "this passkey already has an account: sign in instead" },
  unknown: { status: 404, code: "unknown_passkey", error: "agate does not know this passkey" },
  scope: { status: 400, code: "scope_not_allowed", error: "a passkey cannot confirm that" },
  notPasskey: { status: 403, code: "not_a_passkey_account", error: "this account was not made with a passkey" },
  mismatch: { status: 403, code: "dynamic_mismatch", error: "this passkey belongs to another account" },
  lookup: { status: 503, code: "lookup_failed", error: "the account could not be checked with Dynamic right now: try again shortly" },
} satisfies Record<string, Answer>;

export function passkeyRoutes(deps: PasskeyDeps): Hono {
  const { store, keys, log, origins } = deps;
  const clock = deps.now ?? Date.now;
  const app = new Hono();
  const optionsLimit = new RateLimiter(envInt("AGATE_PASSKEY_OPTIONS_PER_MIN", 30), 60_000);
  const signupLimit = new RateLimiter(envInt("AGATE_PASSKEY_SIGNUPS_PER_HOUR", 5), 3_600_000);
  const signinLimit = new RateLimiter(envInt("AGATE_PASSKEY_SIGNINS_PER_MIN", 20), 60_000);
  const stepUpLimit = new RateLimiter(envInt("AGATE_PASSKEY_STEPUPS_PER_MIN", 10), 60_000);
  const signupsPerDay = envInt("AGATE_PASSKEY_SIGNUPS_PER_DAY", 150);

  const fail = (c: Context, a: Answer, extra: Record<string, unknown> = {}) => {
    log({ event: "passkey.refused", code: a.code, ...extra });
    return c.json({ error: a.error, code: a.code }, a.status, { "cache-control": "no-store" });
  };
  const ok = (c: Context, body: unknown, status: 200 | 201 = 200) => c.json(body, status, { "cache-control": "no-store" });
  const originRow = (c: Context) => {
    const origin = c.req.header("origin");
    const rpId = origin ? origins.get(origin) : undefined;
    return origin && rpId ? { origin, rpId } : null;
  };
  const newCeremony = (kind: CeremonyKind, challenge: string, at: { origin: string; rpId: string }, now: number, more: Partial<Ceremony> = {}) => {
    const c: Ceremony = { id: randomBytes(16).toString("base64url"), kind, challenge, ...at, sub: null, userHandle: null, label: null, scope: null, dynamicUserId: null, expiresAt: now + CEREMONY_MS, ...more };
    store.putCeremony(c, now);
    return c.id;
  };
  /** { ceremonyId, response } with the response's own fields typed enough to read */
  const readBody = async <R>(c: Context): Promise<{ ceremonyId: string; response: R } | null> => {
    const b = (await c.req.json().catch(() => null)) as { ceremonyId?: unknown; response?: { id?: unknown; response?: { clientDataJSON?: unknown } } } | null;
    if (typeof b?.ceremonyId !== "string" || typeof b.response?.id !== "string" || typeof b.response.response?.clientDataJSON !== "string") return null;
    return b as { ceremonyId: string; response: R };
  };
  /** the passkey was used inside a page of another site (an iframe): refuse it on both ceremonies; the library
   *  checks this only when the browser reports a top origin, which Safari does not */
  const embedded = (clientDataJSON: string) => {
    try {
      const d = decodeClientDataJSON(clientDataJSON) as { crossOrigin?: boolean; topOrigin?: string };
      return d.crossOrigin === true || d.topOrigin !== undefined;
    } catch {
      return true;
    }
  };
  /** what sign-in and step-up both check of an assertion: not embedded, an active passkey of this rp id (of `sub`
   *  for a step-up), its account's user handle, then the signature and counter. On success the counter is stored and
   *  the passkey's account returned; otherwise the answer to refuse with. */
  const checkAssertion = async (response: AuthenticationResponseJSON, cer: Ceremony, sub: string | null, now: number): Promise<{ sub: string; cred8: string } | { refuse: Answer; extra: Record<string, unknown> }> => {
    const at = { rpId: cer.rpId, cred8: response.id.slice(0, 8) };
    if (embedded(response.response.clientDataJSON)) return { refuse: A.notVerified, extra: { ...at, why: "embedded" } };
    const cred = store.credential(response.id);
    const acct = cred ? store.account(cred.sub) : null;
    // not agate's at sign-in (most likely a Dynamic passkey); at a step-up only this account's passkeys were offered
    if (!cred || !acct || cred.status !== "active" || acct.status !== "active" || cred.rpId !== cer.rpId) return { refuse: sub ? A.notVerified : A.unknown, extra: { ...at, why: "unknown" } };
    if (sub && cred.sub !== sub) return { refuse: A.notVerified, extra: { ...at, why: "not_this_account" } };
    if (response.response.userHandle && response.response.userHandle !== acct.userHandle) return { refuse: A.notVerified, extra: { ...at, why: "user_handle" } };
    let counter: number | null = null;
    try {
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: cer.challenge,
        expectedOrigin: cer.origin,
        expectedRPID: cer.rpId,
        credential: { id: cred.id, publicKey: isoBase64URL.toBuffer(cred.publicKey), counter: cred.counter, transports: cred.transports },
        requireUserVerification: true,
      });
      if (v.verified) counter = v.authenticationInfo.newCounter;
    } catch {
      // refused below
    }
    if (counter === null) return { refuse: A.notVerified, extra: at };
    store.touchCredential(cred.id, acct.sub, counter, now);
    return { sub: acct.sub, cred8: at.cred8 };
  };

  app.use("/api/passkey/*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "request body too large", code: "too_large" }, 413, { Connection: "close" }) }));

  app.get("/.well-known/agate-jwks.json", async (c) => c.json(await keys.jwks(), 200, { "cache-control": "public, max-age=300" }));

  app.post("/api/passkey/options", async (c) => {
    const now = clock();
    if (!optionsLimit.allow(clientIp(c), now)) return fail(c, A.limited);
    const at = originRow(c);
    if (!at) return fail(c, A.origin);
    const signin = await generateAuthenticationOptions({ rpID: at.rpId, userVerification: "required", timeout: PROMPT_MS });
    const signinId = newCeremony("signin", signin.challenge, at, now);
    const signupClosed = store.signupsSince(now - DAY_MS) >= signupsPerDay;
    let register: { ceremonyId: string; options: unknown } | null = null;
    if (!signupClosed) {
      const sub = `pk_${randomBytes(16).toString("base64url")}`;
      const label = `Agate account ${sub.slice(3, 7).toUpperCase()}`;
      const options = await generateRegistrationOptions({
        rpName: "Agate",
        rpID: at.rpId,
        userName: label,
        userDisplayName: label,
        userID: new Uint8Array(randomBytes(32)),
        attestationType: "none",
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        supportedAlgorithmIDs: ALGS,
        timeout: PROMPT_MS,
      });
      register = { ceremonyId: newCeremony("register", options.challenge, at, now, { sub, userHandle: options.user.id, label }), options };
    }
    return ok(c, { signin: { ceremonyId: signinId, options: signin }, register, signupClosed });
  });

  app.post("/api/passkey/register", async (c) => {
    const now = clock();
    if (store.signupsSince(now - DAY_MS) >= signupsPerDay) return fail(c, A.paused);
    const body = await readBody<RegistrationResponseJSON>(c);
    if (!body) return fail(c, A.bad);
    const cer = store.claimCeremony(body.ceremonyId, "register", now);
    if (!cer || !cer.sub || !cer.userHandle || !cer.label) return fail(c, A.expired);
    const { response } = body;
    if (embedded(response.response.clientDataJSON)) return fail(c, A.notVerified, { rpId: cer.rpId, why: "embedded" });
    let info;
    try {
      const v = await verifyRegistrationResponse({ response, expectedChallenge: cer.challenge, expectedOrigin: cer.origin, expectedRPID: cer.rpId, requireUserVerification: true, supportedAlgorithmIDs: ALGS });
      info = v.verified ? v.registrationInfo : null;
    } catch {
      info = null;
    }
    if (!info) return fail(c, A.notVerified, { rpId: cer.rpId });
    if (response.clientExtensionResults?.credProps?.rk === false) return fail(c, A.notDiscoverable, { rpId: cer.rpId });
    const cred = info.credential;
    if (store.credential(cred.id)) return fail(c, A.exists, { rpId: cer.rpId, cred8: cred.id.slice(0, 8) });
    // only a verified new passkey counts against the address's sign-ups (a failed try costs nothing)
    if (!signupLimit.allow(clientIp(c), now)) return fail(c, A.signupLimited, { rpId: cer.rpId });
    store.createAccount(
      { sub: cer.sub, userHandle: cer.userHandle, label: cer.label },
      {
        id: cred.id,
        sub: cer.sub,
        publicKey: isoBase64URL.fromBuffer(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports ?? response.response.transports ?? [],
        rpId: cer.rpId,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        aaguid: info.aaguid,
      },
      now,
    );
    log({ event: "passkey.signup", rpId: cer.rpId, cred8: cred.id.slice(0, 8) });
    const { jwt } = await keys.sign(cer.sub);
    return ok(c, { externalJwt: jwt, sub: cer.sub }, 201);
  });

  app.post("/api/passkey/signin", async (c) => {
    const now = clock();
    if (!signinLimit.allow(clientIp(c), now)) return fail(c, A.limited);
    const body = await readBody<AuthenticationResponseJSON>(c);
    if (!body) return fail(c, A.bad);
    const cer = store.claimCeremony(body.ceremonyId, "signin", now);
    if (!cer) return fail(c, A.expired);
    const r = await checkAssertion(body.response, cer, null, now);
    if ("refuse" in r) return fail(c, r.refuse, r.extra);
    log({ event: "passkey.signin", rpId: cer.rpId, cred8: r.cred8 });
    const { jwt } = await keys.sign(r.sub);
    return ok(c, { externalJwt: jwt, sub: r.sub });
  });

  app.post("/api/passkey/stepup/options", async (c) => {
    const u = await deps.authed(c);
    if (u instanceof Response) return u;
    const now = clock();
    if (!stepUpLimit.allow(u.userId, now)) return fail(c, A.limited);
    const at = originRow(c);
    if (!at) return fail(c, A.origin);
    const scope = ((await c.req.json().catch(() => null)) as { scope?: unknown } | null)?.scope;
    if (typeof scope !== "string" || !STEP_UP_SCOPES.has(scope)) return fail(c, A.scope);
    // the session's own claim, else the account bound at an earlier step-up, else Dynamic (a first step-up)
    let sub = u.externalSub ?? store.subOfDynamicUser(u.userId);
    if (!sub) {
      try {
        sub = await deps.externalSubOf(u.userId);
      } catch (e) {
        return fail(c, A.lookup, { why: (e as Error).message.slice(0, 80) });
      }
    }
    const acct = sub ? store.account(sub) : null;
    if (!sub || !acct || acct.status !== "active") return fail(c, A.notPasskey);
    if (!store.bindDynamicUser(sub, u.userId)) return fail(c, A.mismatch, { why: "bind" });
    const creds = store.credentialsOf(sub).filter((k) => k.rpId === at.rpId);
    const options = await generateAuthenticationOptions({ rpID: at.rpId, allowCredentials: creds.map((k) => ({ id: k.id, transports: k.transports })), userVerification: "required", timeout: PROMPT_MS });
    return ok(c, { ceremonyId: newCeremony("stepup", options.challenge, at, now, { sub, scope, dynamicUserId: u.userId }), options });
  });

  app.post("/api/passkey/stepup", async (c) => {
    const u = await deps.authed(c);
    if (u instanceof Response) return u;
    // limited at /stepup/options: a finish needs a fresh ceremony from there
    const now = clock();
    const body = await readBody<AuthenticationResponseJSON>(c);
    if (!body) return fail(c, A.bad);
    const cer = store.claimCeremony(body.ceremonyId, "stepup", now);
    if (!cer || !cer.sub || !cer.scope) return fail(c, A.expired);
    // the ceremony was made for this Dynamic user's own passkey account (checked, and bound, at /stepup/options)
    if (cer.dynamicUserId !== u.userId) return fail(c, A.mismatch, { rpId: cer.rpId });
    const r = await checkAssertion(body.response, cer, cer.sub, now);
    if ("refuse" in r) return fail(c, r.refuse, r.extra);
    log({ event: "passkey.stepup", code: cer.scope, rpId: cer.rpId, cred8: r.cred8 });
    const { jwt, expiresAt } = await keys.sign(r.sub, cer.scope);
    return ok(c, { externalJwt: jwt, scope: cer.scope, expiresAt: new Date(expiresAt).toISOString() });
  });

  return app;
}
