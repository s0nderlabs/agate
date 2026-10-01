import {
  type DynamicClient,
  type OTPVerification,
  isSignedIn,
  logout,
  registerPasskey,
  sendEmailOTP,
  signInWithPasskey,
  verifyOTP,
} from "@dynamic-labs-sdk/client";
import { useUser } from "@dynamic-labs-sdk/react-hooks";
import { useEffect, useMemo, useState } from "react";
import { type Address, formatUnits, isAddress } from "viem";
import { chain, contracts, flow } from "../../../shared/config";
import {
  type AgentGrant,
  type Call,
  type Ids,
  buyCalls,
  createAgentGrant,
  faucetCalls,
  gasPayer,
  grantSetupCalls,
  testUsdAbi,
} from "../../lib/aa";
import { type AaPath, ensureEmbeddedWallet, findWallets, makeSender, ownerSigner, publicClient } from "./dynamic";
import { type TxRecord, metrics, useMetrics } from "./metrics";

type Sender = Awaited<ReturnType<typeof makeSender>>;
type Owner = Awaited<ReturnType<typeof ownerSigner>>;

const storage = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

const short = (a?: string) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "");
const usd = (v?: bigint) => (v === undefined ? "-" : Number(formatUnits(v, 6)).toLocaleString());
const since = (t?: number, base?: number) => (t && base ? `+${((t - base) / 1000).toFixed(1)} s` : "-");

export function App({ client, ids }: { client: DynamicClient; ids: Ids }) {
  const m = useMetrics();
  const { data: user } = useUser();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [otp, setOtp] = useState<OTPVerification>();
  const [owner, setOwner] = useState<Owner>();
  const [sender, setSender] = useState<Sender>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [bal, setBal] = useState<{ usd: bigint; up: bigint }>();
  const [prefer, setPrefer] = useState<"auto" | AaPath>(() => (storage.get("dyn-aa-path") as AaPath) ?? "auto");
  const [agent, setAgent] = useState<string>(() => storage.get("dyn-agent") ?? import.meta.env.VITE_AGENT_ADDRESS ?? "");
  const [grant, setGrant] = useState<AgentGrant | undefined>(() => {
    const g = storage.get("dyn-grant");
    return g ? JSON.parse(g) : undefined;
  });

  const guard = async (step: string, fn: () => Promise<void>) => {
    setBusy(step);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      setError(`${step}: ${msg}`);
      metrics.note(`${step} failed: ${msg.slice(0, 300)}`);
    } finally {
      setBusy(undefined);
    }
  };

  const refresh = async (addr = sender?.address) => {
    if (!addr) return;
    const read = (token: Address) =>
      publicClient.readContract({ address: token, abi: testUsdAbi, functionName: "balanceOf", args: [addr] });
    const [u, up] = await Promise.all([read(contracts.testUsd), read(contracts.spUp)]);
    setBal({ usd: u, up });
  };

  const afterSignIn = async () => {
    await ensureEmbeddedWallet(client);
    const wallets = findWallets(client);
    if (!wallets) throw new Error("no EVM embedded wallet on this user (enable embedded wallets for EVM in the Dynamic dashboard)");
    const o = await ownerSigner(client, wallets.eoa);
    const s = await makeSender({ client, ids, wallets, owner: o, prefer });
    setOwner(o);
    setSender(s);
    metrics.mark("signedIn");
    await refresh(s.address);
  };

  useEffect(() => {
    if (isSignedIn(client)) void guard("restore session", afterSignIn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async (step: string, calls: Call[]) => {
    if (!sender) throw new Error("sign in first");
    const sig0 = metrics.get().silentSignatures;
    const t0 = performance.now();
    const r = await sender.send(calls);
    const g = gasPayer(r);
    const rec: TxRecord = {
      step,
      at: Date.now(),
      userOpHash: r.userOpHash,
      txHash: r.receipt.transactionHash,
      payer: g.payer,
      bundler: g.bundler,
      sponsored: g.sponsored,
      path: sender.path,
      signatures: sender.path === "direct" ? metrics.get().silentSignatures - sig0 : "n/a",
      ms: Math.round(performance.now() - t0),
    };
    metrics.tx(rec);
    if (!r.success) throw new Error(`user operation reverted (tx ${r.receipt.transactionHash})`);
    await refresh();
  };

  const doFaucet = () =>
    guard("Get 10,000 testUSD", async () => {
      await send("faucet", faucetCalls(sender!.address));
      metrics.mark("funded");
    });

  const doLong = () =>
    guard("Go Long", async () => {
      await send("buy 100 (approve + buyUp, one user operation)", buyCalls(flow.buyAmount));
      metrics.mark("firstTrade");
    });

  const doGrant = () =>
    guard("Let an agent buy for me", async () => {
      if (!owner || !sender) throw new Error("sign in first");
      if (!isAddress(agent)) throw new Error("enter the agent's address (VITE_AGENT_ADDRESS)");
      if (sender.address.toLowerCase() !== sender.directAddress.toLowerCase())
        throw new Error("the Dynamic smart account is not the Kernel v3.1 account the grant targets; switch the AA path to direct");
      const block = await publicClient.getBlock();
      const g = await createAgentGrant({ publicClient, owner, agent: agent as Address, nowSeconds: Number(block.timestamp) });
      await send("agent grant setup (approve market 200)", grantSetupCalls(g.mode));
      storage.set("dyn-grant", JSON.stringify(g));
      setGrant(g);
      metrics.mark("agentGranted");
    });

  const grantUrl = useMemo(
    () => (grant ? URL.createObjectURL(new Blob([JSON.stringify(grant, null, 2)], { type: "application/json" })) : undefined),
    [grant],
  );

  const signedIn = Boolean(sender);
  const lbl = (s: string, label: string) => (busy === s ? "Working..." : label);

  return (
    <main>
      <header>
        <h1>agate login spike: Dynamic + ZeroDev</h1>
        <p className="sub">
          Monad testnet {chain.id}. Headless Dynamic JS SDK for login and the embedded wallet, a ZeroDev Kernel account for
          sponsored, batched user operations, ZeroDev permissions for the agent.
        </p>
      </header>

      {error && <div className="error">{error}</div>}

      <section className="card">
        <h2>
          <span className="n">1</span> Sign in
        </h2>
        {signedIn ? (
          <div className="stack">
            <p>
              Signed in{user?.email ? ` as ${user.email}` : ""}. Account <code>{sender!.address}</code> via{" "}
              <b>{sender!.path}</b>.
            </p>
            <div className="row">
              <button
                className="ghost"
                disabled={!!busy}
                onClick={() =>
                  guard("Add passkey", async () => {
                    metrics.prompt("passkey create");
                    await registerPasskey({}, client);
                  })
                }
              >
                {lbl("Add passkey", "Add a passkey for next time")}
              </button>
              <button
                className="ghost"
                disabled={!!busy}
                onClick={() =>
                  guard("Sign out", async () => {
                    await logout(client);
                    setSender(undefined);
                    setOwner(undefined);
                    setBal(undefined);
                  })
                }
              >
                Sign out
              </button>
            </div>
          </div>
        ) : (
          <div className="stack">
            {!otp ? (
              <div className="row">
                <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <button
                  disabled={!!busy || !email}
                  onClick={() => guard("Send code", async () => setOtp(await sendEmailOTP({ email }, client)))}
                >
                  {lbl("Send code", "Continue with email")}
                </button>
              </div>
            ) : (
              <div className="row">
                <input inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
                <button
                  disabled={!!busy || code.length < 6}
                  onClick={() =>
                    guard("Verify code", async () => {
                      metrics.update((x) => x.emailCodes++);
                      await verifyOTP({ otpVerification: otp, verificationToken: code }, client);
                      await afterSignIn();
                    })
                  }
                >
                  {lbl("Verify code", "Verify")}
                </button>
              </div>
            )}
            <div className="row">
              <button
                className="ghost"
                disabled={!!busy}
                onClick={() =>
                  guard("Passkey sign-in", async () => {
                    metrics.prompt("passkey sign-in");
                    await signInWithPasskey({}, client);
                    await afterSignIn();
                  })
                }
              >
                {lbl("Passkey sign-in", "Sign in with a passkey (returning user)")}
              </button>
              <label className="muted">
                AA path{" "}
                <select
                  value={prefer}
                  onChange={(e) => {
                    setPrefer(e.target.value as "auto" | AaPath);
                    storage.set("dyn-aa-path", e.target.value);
                  }}
                >
                  <option value="auto">auto</option>
                  <option value="dynamic-extension">Dynamic zerodev extension</option>
                  <option value="direct">ZeroDev SDK direct</option>
                </select>
              </label>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>
          <span className="n">2</span> Get 10,000 testUSD
        </h2>
        <div className="row">
          <button disabled={!signedIn || !!busy} onClick={doFaucet}>
            {lbl("Get 10,000 testUSD", "Get 10,000 testUSD")}
          </button>
          <span className="muted">
            testUSD {usd(bal?.usd)} / spUP {usd(bal?.up)}
          </span>
        </div>
      </section>

      <section className="card">
        <h2>
          <span className="n">3</span> Go Long
        </h2>
        <div className="row">
          <button disabled={!signedIn || !!busy} onClick={doLong}>
            {lbl("Go Long", "Go Long: buy 100 testUSD of spUP")}
          </button>
          <span className="muted">approve + buyUp in one sponsored user operation</span>
        </div>
      </section>

      <section className="card">
        <h2>
          <span className="n">4</span> Let an agent buy for me
        </h2>
        <div className="stack">
          <div className="row">
            <input
              placeholder="agent address 0x..."
              value={agent}
              onChange={(e) => {
                setAgent(e.target.value);
                storage.set("dyn-agent", e.target.value);
              }}
            />
            <button disabled={!signedIn || !!busy} onClick={doGrant}>
              {lbl("Let an agent buy for me", "Allow 200 testUSD for 1 day")}
            </button>
          </div>
          {grant && (
            <div className="stack">
              <p className="muted">
                Granted to <code>{short(grant.agent)}</code> on <code>{short(grant.userAccount)}</code>, {grant.mode} mode, until{" "}
                {new Date(grant.validUntil * 1000).toLocaleString()}. Save the grant as <code>agent/grant.json</code>, then run{" "}
                <code>bun agent/run.ts</code>.
              </p>
              <div className="row">
                <a className="button ghost" href={grantUrl} download="grant.json">
                  Download grant.json
                </a>
                <button className="ghost" disabled={!!busy} onClick={() => guard("refresh", () => refresh())}>
                  Refresh balances
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="card metrics">
        <div className="row spread">
          <h2>Metrics</h2>
          <button className="ghost" onClick={() => metrics.reset()}>
            Reset metrics
          </button>
        </div>
        <div className="grid">
          <div>
            <b>{m.clicks}</b>
            <span>clicks</span>
          </div>
          <div>
            <b>{m.visiblePrompts}</b>
            <span>visible prompts (passkey sheets)</span>
          </div>
          <div>
            <b>{m.silentSignatures}</b>
            <span>silent wallet signatures</span>
          </div>
          <div>
            <b>{m.emailCodes}</b>
            <span>email codes typed</span>
          </div>
        </div>
        <table>
          <tbody>
            <tr>
              <td>landing</td>
              <td>{m.t.landing ? new Date(m.t.landing).toLocaleTimeString() : "-"}</td>
            </tr>
            <tr>
              <td>signed in</td>
              <td>{since(m.t.signedIn, m.t.landing)}</td>
            </tr>
            <tr>
              <td>funded</td>
              <td>{since(m.t.funded, m.t.landing)}</td>
            </tr>
            <tr>
              <td>first trade confirmed</td>
              <td>{since(m.t.firstTrade, m.t.landing)}</td>
            </tr>
            <tr>
              <td>agent granted</td>
              <td>{since(m.t.agentGranted, m.t.landing)}</td>
            </tr>
          </tbody>
        </table>
        <h3>Transactions</h3>
        {m.txs.length === 0 ? (
          <p className="muted">none yet</p>
        ) : (
          <table className="txs">
            <thead>
              <tr>
                <th>step</th>
                <th>tx</th>
                <th>gas paid by</th>
                <th>bundler</th>
                <th>sigs</th>
                <th>ms</th>
              </tr>
            </thead>
            <tbody>
              {m.txs.map((t) => (
                <tr key={t.txHash + t.at}>
                  <td>
                    {t.step}
                    <div className="muted">{t.path}</div>
                  </td>
                  <td>
                    <a href={`${chain.explorer}/tx/${t.txHash}`} target="_blank" rel="noreferrer">
                      {short(t.txHash)}
                    </a>
                  </td>
                  <td>{t.sponsored ? `sponsor (${short(t.payer.split(" ").pop())})` : `user (${short(t.payer.split(" ").pop())})`}</td>
                  <td>{short(t.bundler)}</td>
                  <td>{t.signatures}</td>
                  <td>{t.ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {m.notes.length > 0 && (
          <details>
            <summary>notes ({m.notes.length})</summary>
            <ul>
              {m.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </main>
  );
}
