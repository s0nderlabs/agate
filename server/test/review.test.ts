import { describe, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { type Address, encodeFunctionData, hashMessage, type Hex, keccak256, parseAbi, toHex } from "viem";
import { abi } from "@agate/client";
import { internalApp, publicApp } from "../src/app.ts";
import { config } from "../src/config.ts";
import { checkPocketCalls, decodeKernelCalls, encodeKernelBatch, type PocketLimits } from "@agate/wallet/allowed";
import { decide, messageMatches, type ReviewRequest } from "../src/dynamic/review.ts";
import { handleWebhook } from "../src/dynamic/webhook.ts";
import { Store, type GrantRow } from "../src/store.ts";

const ROUTER = config.router;
const DOLLAR = config.dollar;
const MAIN = "0x1111111111111111111111111111111111111111" as Address;
const POCKET = "0x2222222222222222222222222222222222222222" as Address;
const SERIES = "0x3333333333333333333333333333333333333333" as Address;
const EVIL = "0x6666666666666666666666666666666666666666" as Address;
const ASSISTANT = "0x4444444444444444444444444444444444444444" as Address;
const NOPERMIT = { value: 0n, deadline: 0n, v: 0, r: `0x${"00".repeat(32)}` as Hex, s: `0x${"00".repeat(32)}` as Hex };
const L: PocketLimits = { routers: [ROUTER], dollar: DOLLAR, mainAccount: MAIN, perTradeCap: 50_000_000n, shortTokensCap: 10_000_000n };

const approve = (spender: Address, amt: bigint, token: Address = DOLLAR) => ({ to: token, value: 0n, data: encodeFunctionData({ abi: abi.agateDollarAbi, functionName: "approve", args: [spender, amt] }) });
const openLong = (dollars: bigint) => ({ to: ROUTER, value: 0n, data: encodeFunctionData({ abi: abi.agateRouterAbi, functionName: "openLong", args: [SERIES, dollars, 1n, NOPERMIT] }) });
const openLongDaily = (dollars: bigint, payee: Address) => ({ to: ROUTER, value: 0n, data: encodeFunctionData({ abi: abi.agateRouterAbi, functionName: "openLongDaily", args: [SERIES, dollars, 1n, 3n, payee, NOPERMIT] }) });
const openShort = (tokens: bigint, payee: Address) => ({ to: ROUTER, value: 0n, data: encodeFunctionData({ abi: abi.agateRouterAbi, functionName: "openShort", args: [SERIES, tokens, 1n, 1n, payee, false, NOPERMIT] }) });
const transfer = { to: DOLLAR, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount)"]), functionName: "transfer", args: [EVIL, 1n] }) };

describe("allowed calls", () => {
  test("approve router + open under the cap passes", () => {
    expect(checkPocketCalls([approve(ROUTER, 40_000_000n), openLong(40_000_000n)], L)).toEqual({ ok: true });
  });
  test("over the per-trade cap is refused", () => {
    const r = checkPocketCalls([approve(ROUTER, 60_000_000n), openLong(60_000_000n)], L);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.rule).toBe("over_per_trade_cap");
  });
  test("a daily long or short paying anyone but the main account is refused", () => {
    expect(checkPocketCalls([openLongDaily(1_000_000n, EVIL)], L)).toMatchObject({ ok: false, rule: "payee_must_be_you" });
    expect(checkPocketCalls([openShort(1_000_000n, EVIL)], L)).toMatchObject({ ok: false, rule: "payee_must_be_you" });
    expect(checkPocketCalls([openLongDaily(1_000_000n, MAIN), openShort(1_000_000n, MAIN)], L)).toEqual({ ok: true });
  });
  test("approving anyone but the router is refused", () => {
    expect(checkPocketCalls([approve(EVIL, 1n)], L)).toMatchObject({ ok: false, rule: "approve_router_only" });
  });
  test("transfers, other contracts and native value are refused", () => {
    expect(checkPocketCalls([transfer], L).ok).toBe(false);
    expect(checkPocketCalls([{ to: EVIL, value: 0n, data: "0x" }], L)).toMatchObject({ ok: false, rule: "not_allowed_contract" });
    expect(checkPocketCalls([{ ...openLong(1n), value: 1n }], L)).toMatchObject({ ok: false, rule: "no_native_value" });
  });
  test("Kernel batch callData round-trips", () => {
    const calls = [approve(ROUTER, 5n), openLong(5n)];
    expect(decodeKernelCalls(encodeKernelBatch(calls))).toEqual(calls);
  });
});

function fixture() {
  const store = new Store(":memory:");
  store.putDelegation({ walletId: "w-assist", userId: "u1", address: ASSISTANT, chain: "EVM", shareSetId: "s1" }, { walletApiKey: "k", keyShare: { a: 1 } });
  const grant: GrantRow = {
    id: "g1",
    userId: "u1",
    label: "Claude",
    mainAccount: MAIN,
    pocket: POCKET,
    assistantWalletId: "w-assist",
    assistantAddress: ASSISTANT,
    budget: 200_000_000n,
    perTradeCap: 50_000_000n,
    shortTokensCap: 10_000_000n,
    routers: [ROUTER],
    pocketIndex: 1,
    tradesPerDay: 3,
    expiresAt: Date.now() + 86_400_000,
    permission: null,
    status: "active",
    createdAt: Date.now(),
  };
  store.putGrant(grant);
  const callData = encodeKernelBatch([approve(ROUTER, 40_000_000n), openLong(40_000_000n)]);
  const hash = keccak256(callData);
  store.putIntent({ id: "i1", kind: "pocket-trade", walletId: "w-assist", account: POCKET, hash, callData, grantId: "g1", createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
  const deps = { store, environmentId: config.environmentId, chainId: 10143, limitsOf: () => L, serverWallets: () => new Set<string>() };
  return { store, grant, callData, hash, deps };
}

describe("transaction review", () => {
  test("message forms of a userOp hash match", () => {
    const h = keccak256("0x01");
    expect(messageMatches(h, h)).toBe(true);
    expect(messageMatches(hashMessage({ raw: h }), h)).toBe(true);
    expect(messageMatches(toHex(h), h)).toBe(true);
    expect(messageMatches(keccak256("0x02"), h)).toBe(false);
  });
  test("a person's own signature passes", () => {
    const { deps } = fixture();
    expect(decide({ shareSetType: "rootUser", walletId: "x", message: "0xab" }, deps).proceed).toBe(true);
  });
  test("a delegated signature matching an intent passes, with or without userOp context", () => {
    const { deps, hash, callData } = fixture();
    expect(decide({ shareSetType: "delegated", walletId: "w-assist", message: hash }, deps)).toMatchObject({ proceed: true, intentId: "i1" });
    const ctx: ReviewRequest = { shareSetType: "delegated", walletId: "w-assist", message: hash, context: { evmUserOperation: { chainId: 10143, sender: POCKET, callData } } };
    expect(decide(ctx, deps).proceed).toBe(true);
  });
  test("a delegated plain message, a swapped callData or a wrong sender is denied", () => {
    const { deps, hash, callData } = fixture();
    expect(decide({ shareSetType: "delegated", walletId: "w-assist", message: keccak256("0xdead") }, deps).proceed).toBe(false);
    const other = encodeKernelBatch([approve(EVIL, 1n)]);
    expect(decide({ shareSetType: "delegated", walletId: "w-assist", message: hash, context: { evmUserOperation: { sender: POCKET, callData: other } } }, deps).proceed).toBe(false);
    expect(decide({ shareSetType: "delegated", walletId: "w-assist", message: hash, context: { evmUserOperation: { sender: EVIL, callData } } }, deps).proceed).toBe(false);
  });
  test("a revoked or expired grant and a revoked delegation are denied", () => {
    const f1 = fixture();
    f1.store.setGrantStatus("g1", "revoked");
    expect(decide({ shareSetType: "delegated", walletId: "w-assist", message: f1.hash }, f1.deps).reason).toContain("no longer active");
    const f2 = fixture();
    f2.store.revokeDelegation("w-assist");
    expect(decide({ shareSetType: "delegated", walletId: "w-assist", message: f2.hash }, f2.deps).reason).toContain("no active delegation");
    const f3 = fixture();
    expect(decide({ shareSetType: "delegated", walletId: "w-assist", message: f3.hash }, { ...f3.deps, now: () => Date.now() + 120_000 }).proceed).toBe(false);
  });
  test("an intent outside the pocket's limits is denied even if registered", () => {
    const { store, deps } = fixture();
    const bad = encodeKernelBatch([approve(ROUTER, 90_000_000n), openLong(90_000_000n)]);
    store.putIntent({ id: "i2", kind: "pocket-trade", walletId: "w-assist", account: POCKET, hash: keccak256(bad), callData: bad, grantId: "g1", createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
    expect(decide({ shareSetType: "delegated", walletId: "w-assist", message: keccak256(bad) }, deps).reason).toContain("over_per_trade_cap");
  });
  test("server and unknown signer types need an agate wallet and an intent", () => {
    const { deps } = fixture();
    expect(decide({ shareSetType: "server", walletId: "w-x", message: "0x" }, deps).proceed).toBe(false);
    expect(decide({ shareSetType: "businessAccountUser", walletId: "w-x", message: "0x" }, deps).proceed).toBe(false);
  });
  test("delegated signing on another chain is denied", () => {
    const { deps, hash, callData } = fixture();
    expect(decide({ shareSetType: "delegated", walletId: "w-assist", message: hash, context: { evmUserOperation: { chainId: 1, sender: POCKET, callData } } }, deps).proceed).toBe(false);
  });
});

describe("review endpoint", () => {
  const keys = generateKeyPairSync("ed25519");
  const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const mk = () => {
    const { store } = fixture();
    return publicApp({ store, log: () => {}, reviewSecret: () => "s3cret", reviewSigningKeyPem: () => pem, webhookSecret: () => "whsec" });
  };
  const post = (app: ReturnType<typeof mk>, body: string, sig?: string) =>
    app.request("/dynamic/review", { method: "POST", body, headers: { "content-type": "application/json", ...(sig ? { "x-dynamic-signature": sig } : {}) } });

  test("unsigned requests are refused, signed ones decided, responses Ed25519-signed", async () => {
    const app = mk();
    const body = JSON.stringify({ environmentId: config.environmentId, shareSetType: "rootUser", walletId: "w", message: "0x01" });
    const r1 = await post(app, body);
    expect(await r1.json()).toMatchObject({ proceed: false });
    const sig = createHmac("sha256", "s3cret").update(body).digest("hex");
    const r2 = await post(app, body, sig);
    const raw = await r2.text();
    expect(JSON.parse(raw)).toEqual({ proceed: true });
    const rs = r2.headers.get("x-dynamic-response-signature")!;
    expect(verify(null, Buffer.from(raw), keys.publicKey, Buffer.from(rs, "base64"))).toBe(true);
  });

  test("with no secret configured nothing is decided", async () => {
    const { store } = fixture();
    const app = publicApp({ store, log: () => {}, reviewSecret: () => undefined, reviewSigningKeyPem: () => pem, webhookSecret: () => "whsec" });
    const body = JSON.stringify({ environmentId: config.environmentId, shareSetType: "rootUser", walletId: "w", message: "0x01" });
    expect(await (await post(app, body)).json()).toMatchObject({ proceed: false });
  });

  test("a webhook delivery that failed is handled again on Dynamic's retry; a handled one is a duplicate", () => {
    const store = new Store(":memory:");
    const d = { store, secret: () => "whsec", rsaPrivateKeyPem: () => undefined, log: () => {} };
    const send = (body: object) => {
      const raw = JSON.stringify(body);
      return handleWebhook(raw, createHmac("sha256", "whsec").update(raw).digest("hex"), d);
    };
    const created = { messageId: "m-1", eventName: "wallet.delegation.created", data: { walletId: "w-1" } };
    expect(send(created).status).toBe(500);
    expect(send(created).status).toBe(500);
    const other = { messageId: "m-2", eventName: "user.created", data: {} };
    expect(send(other).body).toEqual({ ok: true });
    expect(send(other).body).toMatchObject({ duplicate: true });
  });

  test("webhooks without a valid HMAC are rejected", async () => {
    const app = mk();
    const r = await app.request("/dynamic/webhook", { method: "POST", body: "{}", headers: { "x-dynamic-signature-256": "sha256=00" } });
    expect(r.status).toBe(401);
  });
});

describe("agate's kill switch (internal port)", () => {
  test("destroys our share and ends the connections; review then denies", async () => {
    const { store, deps, hash } = fixture();
    const r = await internalApp({ store }).request("/kill/w-assist", { method: "POST" });
    expect(await r.json()).toEqual({ walletId: "w-assist", hadMaterials: true, grantsEnded: 1 });
    expect(store.materials("w-assist")).toBeNull();
    expect(store.grant("g1")?.status).toBe("revoked");
    expect(decide({ shareSetType: "delegated", walletId: "w-assist", message: hash }, deps).proceed).toBe(false);
  });
});
