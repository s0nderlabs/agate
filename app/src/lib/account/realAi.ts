// The AI side of the real account (wallet spec 9 to 11), browser only: Agate's server over fetch with the Dynamic
// session as Bearer (server/API.md), the pockets read from the chain, money moved in from the main account and back
// out by the main wallet (each pocket's sudo owner), and the trading key: the Assistant wallet, delegated to Agate
// and the only signer of each pocket's onchain limits. Same shape as the pretend backend (fakeServer.ts).
import { type Address, encodeFunctionData, erc20Abi } from "viem";
import { getAgate } from "@/lib/data/agate";
import type { AiBackend } from "./ai";
import { serverApi, type Transport } from "./api";
import { AGATE_SERVER, dynNow, getDynamic, getWalletLib, type WalletLib } from "./dynamic";
import { StepUpNeeded, type PocketRead } from "./fakeServer";
import { sendCalls } from "./main";
import type { PlanCall } from "./types";

/** Agate's server (literal process.env read, inlined at build time). Unset: every server call reads as offline. */
export { AGATE_SERVER };

/** The link AI apps add: the resource in the server's protected-resource metadata, which is public, so it is read
 *  without signing in (and without loading the sign-in stack). */
export const publicMcpUrl = () => serverApi(publicTransport).mcpUrl();

const publicTransport: Transport = (method, path, body) => serverFetch(method, path, body, null);

const fetchTransport: Transport = async (method, path, body) => {
  if (!AGATE_SERVER) throw new Error("no server set for this build");
  const { lib, client } = await getDynamic();
  // read fresh on every call: the session is refreshed under the same client
  return serverFetch(method, path, body, lib.sessionToken(client));
};

/** One request to Agate's server, signed in when a session token is given; the answer's body read as JSON if it is. */
async function serverFetch(method: "GET" | "POST", path: string, body: unknown, token: string | null | undefined) {
  if (!AGATE_SERVER) throw new Error("no server set for this build");
  const r = await fetch(`${AGATE_SERVER}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, body: json };
}

/** Dynamic's key steps fail now and then and work on a second go (measured: 3 of 19 delegated signs), so each runs
 *  once more, quietly, before the screen says it stopped. A lapsed code is not retried: it needs the person. */
async function twice<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if ((e as Error)?.name === "StepUpNeeded") throw e;
    await new Promise((r) => setTimeout(r, 1_500));
    return f();
  }
}

/** Dynamic's key steps take about 6 seconds. One that never answers (seen in a private window, where no request even
 *  goes out) fails after this, so the step says it stopped and offers Try again instead of waiting forever. */
const KEY_STEP_MS = 45_000;

function inTime<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(Object.assign(new Error(`${what} took longer than ${KEY_STEP_MS / 1000} s`), { name: "TimedOut" })), KEY_STEP_MS);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const reverted = () => Object.assign(new Error("the operation landed and reverted"), { name: "WriteError", reason: "reverted", stage: "receipt" });
const units = (dollars: number) => BigInt(Math.round(dollars * 1e6));

export function realAiBackend(o: { owner: string; address: string; onMoved: () => void }): AiBackend {
  const api = serverApi(fetchTransport);
  let otp: unknown = null;

  const readPocket = async (pocket: string): Promise<PocketRead> => {
    const w = await (await getAgate()).getWallet(pocket);
    return { balance: w.balance, positions: w.positions };
  };

  /** Which of the main wallet's accounts a pocket is: its grant says so; a pocket funded by a connect that stopped
   *  before registering has none, so the indexes handed out so far are checked. */
  const pocketIndexOf = async (pocket: string, pc: Parameters<WalletLib["pocketAddress"]>[0], w: WalletLib): Promise<number | null> => {
    const me = await api.me();
    const grant = me.grants.find((g) => g.pocket.toLowerCase() === pocket.toLowerCase());
    if (grant) return grant.pocketIndex;
    for (let i = 1; i <= me.nextPocketIndex + 1; i++) {
      if ((await w.pocketAddress(pc, o.owner as Address, BigInt(i))).toLowerCase() === pocket.toLowerCase()) return i;
    }
    return null;
  };

  const assistantOf = async () => {
    const { lib, client } = await getDynamic();
    const ws = lib.wallets(client);
    if (!ws) throw new Error("UserNotAuthenticatedError: sign in again");
    return { lib, client, ws };
  };

  return {
    key: `live|${o.address.toLowerCase()}`,
    api,
    pocket: readPocket,
    fund: async (pocket, dollars) => {
      const w = await getWalletLib();
      const calls: PlanCall[] = w.fundPocketCalls(w.AGATE.dollar, pocket as Address, units(dollars)).map((c) => ({ ...c, label: "move test dollars into the pocket" }));
      const r = await sendCalls(o.owner, 0, o.address, calls);
      o.onMoved();
      if (!r.success) throw reverted();
    },
    takeBack: async (pocket) => {
      // the main wallet signs as the pocket's owner: whatever the AI's key allows, its dollars come home
      const [agate, w] = await Promise.all([getAgate(), getWalletLib()]);
      const index = await pocketIndexOf(pocket, agate.pub, w);
      if (index === null) throw new Error("this pocket is not one of your AIs'");
      const have = (await agate.pub.readContract({ address: w.AGATE.dollar, abi: erc20Abi, functionName: "balanceOf", args: [pocket as Address] })) as bigint;
      if (have === 0n) return 0;
      const call: PlanCall = { to: w.AGATE.dollar, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [o.address as Address, have] }), label: "take the pocket's test dollars back" };
      const r = await sendCalls(o.owner, index, pocket, [call]);
      o.onMoved();
      if (!r.success) throw reverted();
      return Number(have) / 1e6;
    },
    tradingKey: {
      state: () => {
        // the client is up whenever someone is signed in; /api/me says which keys are delegated
        const d = dynNow();
        const a = d ? d.lib.wallets(d.client)?.assistant : null;
        return { hasAssistant: !!a, address: a?.address ?? null, delegated: false, canDelegate: d ? d.lib.canDelegate(d.client) : false };
      },
      ensureAssistant: () =>
        inTime(
          twice(async () => {
            const { lib, client } = await assistantOf();
            return (await lib.ensureAssistantWallet(client)).address;
          }),
          "making the trading key",
        ),
      delegate: () =>
        inTime(
          twice(async () => {
            const { lib, client, ws } = await assistantOf();
            if (!ws.assistant) throw new Error("make the trading key first");
            // delegating needs a fresh code's scope; without it Dynamic answers 403, so ask for the code first
            if (!lib.canDelegate(client)) throw new StepUpNeeded();
            // this step runs only when Agate's server holds no share of the key. Dynamic may still count it delegated
            // (its message to Agate never arrived, say while the server was unreachable), and delegating again would then
            // do nothing: switch it off first, so Dynamic sends the share once more. No AI can be trading on a key Agate
            // never got, so nothing stops. A failed switch-off stops here (the key would still count as delegated), and
            // Dynamic asks for a fresh code after one: the step then comes back and only delegates.
            if (lib.isDelegated(client, ws.assistant)) {
              await lib.revokeAssistant(client, ws.assistant);
              if (!lib.canDelegate(client)) throw new StepUpNeeded();
            }
            await lib.delegateAssistant(client, ws.assistant);
          }),
          "letting Agate use the trading key",
        ),
      stepUpSend: async () => {
        const { lib, client } = await assistantOf();
        // an account made with a passkey has no email and no Dynamic passkey (its count reads 0): it confirms with its
        // own passkey, so this comes first; an account with a Dynamic passkey confirms with it too (Dynamic then
        // refuses an email code for any step-up)
        if (lib.isAgatePasskeyAccount(client)) return "passkey";
        if ((await lib.passkeyCount(client).catch(() => 0)) > 0) return "passkey";
        const email = client.user?.email;
        if (!email) throw new Error("no email on this account");
        otp = await lib.requestStepUp(client, email);
        return "code";
      },
      stepUpPasskey: async () => {
        const { lib, client } = await assistantOf();
        if (lib.isAgatePasskeyAccount(client)) await lib.confirmWithAgatePasskey(client, AGATE_SERVER, "wallet:delegate");
        else await lib.confirmWithPasskey(client, ["wallet:delegate"]);
      },
      stepUpVerify: async (code) => {
        const { lib, client } = await assistantOf();
        if (!otp) throw new Error("expired_email_verification_token");
        await lib.confirmStepUp(client, otp as Parameters<typeof lib.confirmStepUp>[1], code);
      },
      signPermission: (index, ask) => twice(async () => {
        const { lib, client, ws } = await assistantOf();
        if (!ws.assistant) throw new Error("make the trading key first");
        const [agate, w] = await Promise.all([getAgate(), getWalletLib()]);
        const main = await lib.walletSigner(client, ws.main);
        const cap = units(ask.perTradeCap);
        const { pocket, approval } = await w.createPocketPermission(agate.pub, main, {
          index: BigInt(index),
          assistant: ws.assistant.address as Address,
          limits: { routers: ask.routers as Address[], dollar: w.AGATE.dollar, mainAccount: o.address as Address, perTradeCap: cap, shortTokensCap: w.shortTokensCapFor(cap) },
          validUntil: ask.validUntil,
          tradesPerDay: ask.tradesPerDay,
        });
        return { pocket, approval, pocketBalance: (await readPocket(pocket)).balance };
      }),
      revoke: async () => {
        const { lib, client, ws } = await assistantOf();
        if (ws.assistant) await lib.revokeAssistant(client, ws.assistant);
      },
    },
    expireRequest: () => {},
    touch: () => {},
    example: false,
    fake: false,
  };
}
