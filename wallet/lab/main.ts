// The wallet lab's script: each button is one step of the app's real flow, logged with timings.
import { getElevatedAccessToken, getWalletAccounts } from "@dynamic-labs-sdk/client";
import { createKernelClientForWalletAccount } from "@dynamic-labs-sdk/zerodev";
import { type Address, createPublicClient, encodeFunctionData, http, parseAbi, type PublicClient } from "viem";
import { abi } from "@agate/client";
import { AGATE, accountClient, createPocketPermission, describeReceipt, fundPocketCalls, kernelAccount, monadTestnet, shortTokensCapFor, sendCalls, zerodev, type Call } from "../src/index.ts";
import { canDelegate, confirmWithAgatePasskey, createAccountWithPasskey, isAgatePasskeyAccount, signInWithAgatePasskey, createAgateDynamic, delegateAssistant, ensureAssistantWallet, ensureMainWallet, finishEmailSignIn, confirmStepUp, finishGoogleSignIn, googleAccounts, startGoogleSignIn, unlinkGoogle, onSessionEvent, refreshSession, revokeAssistant, sessionExpiresAt, sessionToken, signOut, startEmailSignIn, walletSigner, wallets, type EmailOtp } from "../src/dynamic.ts";

declare const __ZERODEV_RPC__: string;
declare const __AGATE_SERVER__: string;
declare const __EXTRA_ROUTERS__: string[];

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const logEl = $("log");
const stateEl = $("state");
function log(step: string, data: unknown, t0?: number) {
  const line = `${new Date().toISOString().slice(11, 19)} ${step}${t0 ? ` (${Math.round(performance.now() - t0)} ms)` : ""} ${typeof data === "string" ? data : JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`;
  logEl.textContent = `${line}\n${logEl.textContent}`;
  console.log(line);
}
const pc = createPublicClient({ chain: monadTestnet, transport: http() }) as PublicClient;
const client = await createAgateDynamic(undefined, "agate lab");
let otp: EmailOtp | null = null;
let grantId: string | null = null;
let pocketIndex = 1;
const routers: Address[] = [AGATE.router, ...(__EXTRA_ROUTERS__ as Address[])];

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(`${__AGATE_SERVER__}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken(client) ?? ""}`, ...(init.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j;
}

async function refresh() {
  const w = wallets(client);
  const lines = [`signed in: ${Boolean(sessionToken(client))}${client.user ? `, passkey account: ${isAgatePasskeyAccount(client)}, missing fields: ${client.user.missingFields?.length ?? 0}` : ""}`, `wallet accounts: ${getWalletAccounts(client).map((a) => `${a.chain}:${a.address.slice(0, 10)}(${a.walletProviderKey})`).join(", ") || "-"}`];
  if (w) {
    lines.push(`main: ${w.main.address}`, `main account: ${(await kernelAccount(pc, await walletSigner(client, w.main))).address}`);
    lines.push(`assistant: ${w.assistant?.address ?? "-"}`);
  }
  if (sessionToken(client)) {
    try {
      const me = await api("/api/me");
      lines.push(`server: delegations ${JSON.stringify(me.delegations)}`, `grants: ${me.grants.map((g: { id: string; status: string; pocket: string }) => `${g.id.slice(0, 8)} ${g.status} pocket ${g.pocket}`).join("; ") || "-"}`);
      const live = me.grants.find((g: { status: string }) => g.status === "active");
      grantId = live?.id ?? grantId;
      pocketIndex = live?.pocketIndex ?? pocketIndex;
    } catch (e) {
      lines.push(`server: ${(e as Error).message}`);
    }
  }
  stateEl.textContent = lines.join("\n");
}

function step(id: string, f: () => Promise<unknown>) {
  $(id).onclick = async () => {
    const t0 = performance.now();
    try {
      log(id, (await f()) ?? "ok", t0);
    } catch (e) {
      log(`${id} FAILED`, (e as Error).message, t0);
    }
    await refresh().catch(() => {});
  };
}

async function mainClient() {
  const w = wallets(client);
  if (!w) throw new Error("no main wallet");
  const account = await kernelAccount(pc, await walletSigner(client, w.main));
  return accountClient(account, pc, zerodev(__ZERODEV_RPC__));
}

step("send", async () => {
  otp = await startEmailSignIn(client, $("email").value.trim());
  return "code sent";
});
step("verify", async () => {
  if (!otp) throw new Error("send a code first");
  await finishEmailSignIn(client, otp, $("code").value.trim());
  return "signed in";
});
step("logout", () => signOut(client));
// unlinking needs a fresh code with the credential:unlink scope: "Send code" first, then this with the code typed
step("unlink-google", async () => {
  if (!otp) throw new Error("send a code first");
  await confirmStepUp(client, otp, $("code").value.trim(), ["credential:unlink"]);
  return { unlinked: await unlinkGoogle(client), left: googleAccounts(client).length };
});
step("google", async () => {
  await startGoogleSignIn(client, `${location.origin}${location.pathname}?google=1`);
  return "leaving for Google";
});
// session facts for the app: when the session ends, whether the delegate scope is held and for how long (numbers
// only; no token leaves the page)
const jwtClaims = (t: string) => JSON.parse(atob(t.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number; singleUse?: boolean; scope?: string };
const sessionFacts = () => {
  const exp = sessionExpiresAt(client);
  const el = getElevatedAccessToken({ scope: "wallet:delegate", consume: false }, client);
  const c = el ? jwtClaims(el) : null;
  return {
    sessionMinutesLeft: exp ? Math.round((exp.getTime() - Date.now()) / 60_000) : null,
    delegateScope: c ? { minutesLeft: c.exp ? Math.round((c.exp * 1000 - Date.now()) / 60_000) : null, singleUse: c.singleUse ?? false } : null,
    canDelegate: canDelegate(client),
  };
};
step("session", async () => sessionFacts());
step("refresh-session", async () => {
  const before = sessionFacts().sessionMinutesLeft;
  await refreshSession(client);
  return { before, after: sessionFacts().sessionMinutesLeft };
});
onSessionEvent(client, (e) => log("session-event", e));
step("pk-create", async () => createAccountWithPasskey(client, __AGATE_SERVER__));
step("pk-signin", async () => signInWithAgatePasskey(client, __AGATE_SERVER__));
step("pk-confirm", async () => {
  await confirmWithAgatePasskey(client, __AGATE_SERVER__, "wallet:delegate");
  return `canDelegate ${canDelegate(client)}`;
});
step("main", async () => (await ensureMainWallet(client)).address);
step("drip", async () => {
  const kc = await mainClient();
  const drip: Call = { to: AGATE.dollar, value: 0n, data: encodeFunctionData({ abi: abi.agateDollarAbi, functionName: "drip", args: [] }) };
  return describeReceipt(await sendCalls(kc, [drip]));
});
step("zd", async () => {
  const smart = getWalletAccounts(client).find((a) => a.walletProviderKey.toLowerCase().startsWith("zerodev"));
  if (!smart) return "no ZeroDev smart wallet from Dynamic for this user (ZeroDev provider not enabled in the dashboard?)";
  const kc = await createKernelClientForWalletAccount({ smartWalletAccount: smart as never, networkId: String(monadTestnet.id), bundlerRpc: __ZERODEV_RPC__, paymasterRpc: __ZERODEV_RPC__ }, client);
  const direct = (await mainClient()).account.address;
  return { dynamicSmartAccount: kc.account.address, directKernelV31: direct, same: kc.account.address.toLowerCase() === direct.toLowerCase() };
});
step("assistant", async () => (await ensureAssistantWallet(client)).address);
step("delegate", async () => {
  const w = wallets(client);
  if (!w?.assistant) throw new Error("create the Assistant first");
  await delegateAssistant(client, w.assistant);
  return `delegated ${w.assistant.address}`;
});
step("revoke", async () => {
  const w = wallets(client);
  if (!w?.assistant) throw new Error("no Assistant");
  await revokeAssistant(client, w.assistant);
  if (grantId) await api(`/api/grants/${grantId}/disconnect`, { method: "POST" });
  return "revoked";
});
step("connect", async () => {
  const w = wallets(client);
  if (!w?.assistant) throw new Error("create and delegate the Assistant first");
  const u = (v: string) => BigInt(Math.round(Number(v) * 1e6));
  const budget = u($("budget").value);
  const perTradeCap = u($("cap").value);
  const tradesPerDay = Number($("tpd").value);
  const validUntil = Math.floor(Date.now() / 1000) + Number($("days").value) * 86_400;
  const main = await walletSigner(client, w.main);
  const mainAccount = (await kernelAccount(pc, main)).address;
  const t0 = performance.now();
  // each AI gets its own pocket: the next index the server hands out (never reused)
  const index = Number((await api("/api/me")).nextPocketIndex ?? 1);
  const { pocket, approval } = await createPocketPermission(pc, main, {
    index: BigInt(index),
    assistant: w.assistant.address as Address,
    limits: { routers, dollar: AGATE.dollar, mainAccount, perTradeCap, shortTokensCap: shortTokensCapFor(perTradeCap) },
    validUntil,
    tradesPerDay,
  });
  log("connect: permission signed", { pocket, bytes: approval.length }, t0);
  const t1 = performance.now();
  const fund = await sendCalls(await mainClient(), fundPocketCalls(AGATE.dollar, pocket, budget));
  log("connect: pocket funded", describeReceipt(fund), t1);
  const g = await api("/api/grants", {
    method: "POST",
    body: JSON.stringify({ label: "Lab AI", mainOwner: w.main.address, assistantAddress: w.assistant.address, budget: budget.toString(), perTradeCap: perTradeCap.toString(), tradesPerDay, validUntil, pocketIndex: index, approval }),
  });
  grantId = g.id;
  pocketIndex = index;
  return g;
});

const labTrade = (calls: Call[]) =>
  api(`/api/grants/${grantId}/lab-trade${new URLSearchParams(location.search).get("raw") === "1" ? "?raw=1" : ""}`, { method: "POST", body: JSON.stringify({ calls: calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data })) }) });
const approveRouter = (amt: bigint): Call => ({ to: AGATE.dollar, value: 0n, data: encodeFunctionData({ abi: abi.agateDollarAbi, functionName: "approve", args: [AGATE.router, amt] }) });
step("t-approve0", () => labTrade([approveRouter(0n)]));
step("t-drip", () => labTrade([{ to: AGATE.dollar, value: 0n, data: encodeFunctionData({ abi: abi.agateDollarAbi, functionName: "drip", args: [] }) }]));
step("t-over", () =>
  labTrade([approveRouter(10_000_000_000n), { to: AGATE.router, value: 0n, data: encodeFunctionData({ abi: abi.agateRouterAbi, functionName: "openLong", args: [AGATE.factory, 10_000_000_000n, 1n, { value: 0n, deadline: 0n, v: 0, r: `0x${"00".repeat(32)}`, s: `0x${"00".repeat(32)}` }] }) }]),
);
// "Take back": the main wallet (the pocket's sudo owner) moves dollars out of the pocket, whatever the AI's key allows
step("t-takeback", async () => {
  const w = wallets(client);
  if (!w) throw new Error("sign in first");
  const main = await walletSigner(client, w.main);
  const mainAccount = (await kernelAccount(pc, main)).address;
  const pocket = await kernelAccount(pc, main, BigInt(pocketIndex));
  const amount = BigInt(Math.round(Number($("takeback").value) * 1e6));
  const transfer: Call = { to: AGATE.dollar, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount)"]), functionName: "transfer", args: [mainAccount, amount] }) };
  const r = await sendCalls(accountClient(pocket, pc, zerodev(__ZERODEV_RPC__)), [transfer]);
  return { pocket: pocket.address, to: mainAccount, dollars: Number(amount) / 1e6, ...describeReceipt(r) };
});
step("t-transfer", () => labTrade([{ to: AGATE.dollar, value: 0n, data: "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead0000000000000000000000000000000000000000000000000000000000000001" }]));

{
  // back from Google: finish the sign-in
  const t0 = performance.now();
  try {
    if (await finishGoogleSignIn(client, location.href)) log("google", "signed in with Google", t0);
  } catch (e) {
    log("google FAILED", (e as Error).message, t0);
  }
}
await refresh();
log("ready", { server: __AGATE_SERVER__, zerodev: Boolean(__ZERODEV_RPC__) });
