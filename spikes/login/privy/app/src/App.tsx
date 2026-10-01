import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useLogin,
  useLogout,
  useModalStatus,
  usePrivy,
  useSendTransaction,
  useSignTypedData,
  useSigners,
  useWallets,
} from "@privy-io/react-auth";
import { formatUnits, type Address, type Hex } from "viem";
import { chain, contracts, flow } from "../../../shared/config";
import {
  agentBudgetCall,
  buyUpWithPermitCall,
  explorerAddress,
  explorerTx,
  faucetCall,
  marketAbi,
  permitTypedData,
  spUpAbi,
  testUsdAbi,
  type Call,
} from "./calls";
import { publicClient } from "./chain";
import {
  clearMetrics,
  emptyMetrics,
  loadMetrics,
  saveMetrics,
  secondsBetween,
  type Metrics,
  type TxRecord,
} from "./metrics";

const ids = __SPIKE_IDS__;

type Balances = { usd: bigint; up: bigint; allowance: bigint; mon: bigint };

export function SetupError() {
  return (
    <main className="wrap">
      <h1>agate login spike: Privy</h1>
      <div className="card error">
        <h2>Setup needed</h2>
        <p>
          No Privy app id. Add <code>privyAppId</code> to <code>spikes/login/shared/ids.json</code> or set{" "}
          <code>VITE_PRIVY_APP_ID</code> in <code>privy/app/.env.local</code>, then restart <code>bun run dev</code>.
        </p>
      </div>
    </main>
  );
}

export function App() {
  const [m, setM] = useState<Metrics>(() => {
    const loaded = loadMetrics();
    return loaded.landingAt ? loaded : { ...loaded, landingAt: Date.now() };
  });
  const update = useCallback((fn: (prev: Metrics) => Metrics) => {
    setM((prev) => {
      const next = fn(prev);
      saveMetrics(next);
      return next;
    });
  }, []);
  useEffect(() => saveMetrics(m), []); // persist the landing timestamp once

  // Global click counter. Buttons marked data-noclick (metrics tools) are excluded.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("[data-noclick]")) return;
      update((p) => ({ ...p, clicks: p.clicks + 1 }));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [update]);

  // Every time a Privy modal opens (login, or a wallet confirmation if one ever shows), count it.
  const { isOpen } = useModalStatus();
  const wasOpen = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpen.current) update((p) => ({ ...p, privyModalOpens: p.privyModalOpens + 1 }));
    wasOpen.current = isOpen;
  }, [isOpen, update]);

  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const { login } = useLogin({
    onComplete: ({ isNewUser, loginMethod }) =>
      update((p) => ({
        ...p,
        loginMethod: loginMethod ?? p.loginMethod,
        returningVisit: !isNewUser,
      })),
  });
  const { logout } = useLogout();
  const { sendTransaction } = useSendTransaction();
  const { signTypedData } = useSignTypedData();
  const { addSigners, removeSigners } = useSigners();

  const wallet = useMemo(() => wallets.find((w) => w.walletClientType === "privy"), [wallets]);
  const address = wallet?.address as Address | undefined;
  const walletId = useMemo(() => {
    const acct = user?.linkedAccounts.find(
      (a) => a.type === "wallet" && a.walletClientType === "privy" && a.chainType === "ethereum",
    );
    return acct && "id" in acct ? (acct.id ?? null) : null;
  }, [user]);

  // Signed in = authenticated with the embedded wallet ready.
  useEffect(() => {
    if (authenticated && address) update((p) => (p.signedInAt ? p : { ...p, signedInAt: Date.now() }));
  }, [authenticated, address, update]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bal, setBal] = useState<Balances | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    const [usd, up, allowance, mon] = await Promise.all([
      publicClient.readContract({ address: contracts.testUsd, abi: testUsdAbi, functionName: "balanceOf", args: [address] }),
      publicClient.readContract({ address: contracts.spUp, abi: spUpAbi, functionName: "balanceOf", args: [address] }),
      publicClient.readContract({
        address: contracts.testUsd,
        abi: testUsdAbi,
        functionName: "allowance",
        args: [address, contracts.market],
      }),
      publicClient.getBalance({ address }),
    ]);
    setBal({ usd: usd as bigint, up: up as bigint, allowance: allowance as bigint, mon });
    return { usd: usd as bigint, up: up as bigint, allowance: allowance as bigint, mon };
  }, [address]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  // After the grant, watch for the agent's buy: the agent budget (market allowance) drops below 200.
  useEffect(() => {
    if (!m.agentGrantedAt || m.agentTradeSeenAt || !address) return;
    const t = setInterval(async () => {
      const b = await refresh().catch(() => undefined);
      if (b && b.allowance < flow.agentCap) {
        update((p) => ({ ...p, agentTradeSeenAt: p.agentTradeSeenAt ?? Date.now() }));
      }
    }, 4000);
    return () => clearInterval(t);
  }, [m.agentGrantedAt, m.agentTradeSeenAt, address, refresh, update]);

  const recordTx = useCallback(
    (rec: TxRecord) => update((p) => ({ ...p, txs: [...p.txs.filter((t) => t.hash !== rec.hash || !rec.hash), rec] })),
    [update],
  );

  // One sponsored transaction from the embedded wallet, popups off. Waits for the receipt and records who paid gas.
  const sendSponsored = useCallback(
    async (call: Call, step: string): Promise<boolean> => {
      if (!address) throw new Error("no embedded wallet yet");
      update((p) => ({ ...p, signatureRequests: p.signatureRequests + 1 }));
      const { hash } = await sendTransaction(
        { to: call.to, data: call.data, chainId: chain.id },
        { sponsor: true, address },
      );
      const base: TxRecord = { step, label: call.label, hash, payer: "unknown", status: "pending", at: Date.now() };
      if (!hash) {
        recordTx({ ...base, status: "unknown", note: "Privy returned an empty hash (async sponsored send)" });
        return false;
      }
      recordTx(base);
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as Hex, timeout: 90_000 });
        const from = receipt.from;
        const payer = from.toLowerCase() === address.toLowerCase() ? "user" : "sponsor";
        const ok = receipt.status === "success";
        recordTx({ ...base, from, payer, status: ok ? "success" : "reverted" });
        return ok;
      } catch (e) {
        recordTx({ ...base, status: "unknown", note: `no receipt for this hash: ${(e as Error).message.slice(0, 120)}` });
        return false;
      }
    },
    [address, sendTransaction, recordTx, update],
  );

  const run = useCallback(
    async (name: string, fn: () => Promise<void>) => {
      setBusy(name);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(`${name}: ${(e as Error).message}`);
      } finally {
        setBusy(null);
        void refresh().catch(() => undefined);
      }
    },
    [refresh],
  );

  const stepFaucet = () =>
    run("Get 10,000 testUSD", async () => {
      const ok = await sendSponsored(faucetCall(address!), "2 faucet");
      if (ok) update((p) => ({ ...p, fundedAt: p.fundedAt ?? Date.now() }));
    });

  const stepLong = () =>
    run("Go Long", async () => {
      const owner = address!;
      const [nonce, domain] = await Promise.all([
        publicClient.readContract({ address: contracts.testUsd, abi: testUsdAbi, functionName: "nonces", args: [owner] }),
        publicClient.readContract({ address: contracts.testUsd, abi: testUsdAbi, functionName: "eip712Domain" }),
      ]);
      const [, name, version] = domain as readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const typed = permitTypedData({
        domain: { name, version, chainId: chain.id, verifyingContract: contracts.testUsd },
        owner,
        spender: contracts.market,
        value: flow.buyAmount,
        nonce: nonce as bigint,
        deadline,
      });
      update((p) => ({ ...p, signatureRequests: p.signatureRequests + 1 }));
      const { signature } = await signTypedData(typed, { address: owner });
      const ok = await sendSponsored(buyUpWithPermitCall(flow.buyAmount, deadline, signature as Hex), "3 long");
      if (ok) update((p) => ({ ...p, firstTradeAt: p.firstTradeAt ?? Date.now() }));
    });

  const stepAgent = () =>
    run("Let an agent buy for me", async () => {
      if (!ids.signerId || !ids.policyId) throw new Error("agent signer or policy id missing: run `bun run policy` in agent/");
      if (ids.policyExpiry && ids.policyExpiry * 1000 < Date.now())
        throw new Error("the agent policy window has expired: run `bun run policy` again for a fresh one-day window");
      // 1) Add our server's authorization key as a signer on the user's wallet, scoped by the policy.
      update((p) => ({ ...p, signatureRequests: p.signatureRequests + 1 }));
      await addSigners({ address: address!, signers: [{ signerId: ids.signerId, policyIds: [ids.policyId] }] });
      // 2) The onchain budget: allow the market to pull at most 200 testUSD (the signer cannot call approve).
      const ok = await sendSponsored(agentBudgetCall(), "4 grant");
      if (ok) update((p) => ({ ...p, agentGrantedAt: Date.now(), agentTradeSeenAt: null }));
    });

  const revokeAgent = () =>
    run("Revoke agent", async () => {
      await removeSigners({ address: address! });
    });

  const agentCmd = address
    ? `cd spikes/login/privy/agent && bun run agent --user ${address}${walletId ? ` --wallet-id ${walletId}` : ""}`
    : "";

  const step2Done = !!m.fundedAt;
  const step3Done = !!m.firstTradeAt;
  const step4Granted = !!m.agentGrantedAt;
  const signedIn = authenticated && !!address;

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>agate login spike</h1>
          <p className="muted">Privy: email, Google or passkey. Embedded wallet, sponsored gas, popups off. Monad testnet.</p>
        </div>
        {signedIn && (
          <button className="ghost" onClick={() => void logout()}>
            Sign out
          </button>
        )}
      </header>

      {error && <div className="card error">{error}</div>}

      <section className="steps">
        <div className={`card step ${signedIn ? "done" : ""}`}>
          <span className="num">1</span>
          <div className="body">
            <h2>Sign in</h2>
            <p className="muted">First visit creates your account and wallet. Next time, same account.</p>
            {signedIn ? (
              <p className="ok">
                Signed in{m.loginMethod ? ` with ${m.loginMethod}` : ""}. Wallet{" "}
                <a href={explorerAddress(address!)} target="_blank" rel="noreferrer">
                  {short(address!)}
                </a>
              </p>
            ) : (
              <button disabled={!ready || authenticated} onClick={() => login()}>
                {ready ? (authenticated ? "Creating wallet..." : "Sign in") : "Loading..."}
              </button>
            )}
          </div>
        </div>

        <div className={`card step ${step2Done ? "done" : ""}`}>
          <span className="num">2</span>
          <div className="body">
            <h2>Get 10,000 testUSD</h2>
            <p className="muted">Free test dollars. We pay the network fee.</p>
            <button disabled={!signedIn || !!busy} onClick={stepFaucet}>
              {busy === "Get 10,000 testUSD" ? "Sending..." : "Get 10,000 testUSD"}
            </button>
          </div>
        </div>

        <div className={`card step ${step3Done ? "done" : ""}`}>
          <span className="num">3</span>
          <div className="body">
            <h2>Go Long</h2>
            <p className="muted">Buy 100 testUSD of spUP in one tap.</p>
            <button disabled={!signedIn || !!busy} onClick={stepLong}>
              {busy === "Go Long" ? "Buying..." : "Go Long: 100 testUSD"}
            </button>
          </div>
        </div>

        <div className={`card step ${step4Granted ? "done" : ""}`}>
          <span className="num">4</span>
          <div className="body">
            <h2>Let an agent buy for me</h2>
            <p className="muted">The agent may spend up to 200 testUSD, only on spUP, for one day.</p>
            {!ids.signerId || !ids.policyId ? (
              <p className="warn">Agent not configured: run <code>bun run policy</code> in privy/agent, then restart the dev server.</p>
            ) : null}
            <div className="row">
              <button disabled={!signedIn || !!busy || !ids.signerId || !ids.policyId} onClick={stepAgent}>
                {busy === "Let an agent buy for me" ? "Granting..." : "Allow agent: 200 testUSD, 1 day"}
              </button>
              {step4Granted && (
                <button className="ghost" disabled={!!busy} onClick={revokeAgent}>
                  Revoke
                </button>
              )}
            </div>
            {step4Granted && (
              <>
                <p className="muted">Now run the agent (you can close this tab):</p>
                <pre className="cmd">{agentCmd}</pre>
                <p className={m.agentTradeSeenAt ? "ok" : "muted"}>
                  {m.agentTradeSeenAt ? "Agent buy seen onchain." : "Watching for the agent's buy..."}
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Wallet</h2>
        {bal ? (
          <table className="kv">
            <tbody>
              <tr><td>testUSD</td><td>{fmt(bal.usd)}</td></tr>
              <tr><td>spUP</td><td>{fmt(bal.up)}</td></tr>
              <tr><td>Agent budget left (market allowance)</td><td>{fmt(bal.allowance)}</td></tr>
              <tr><td>MON (gas token)</td><td>{formatUnits(bal.mon, 18)}</td></tr>
              <tr><td>Privy wallet id</td><td><code>{walletId ?? "-"}</code></td></tr>
            </tbody>
          </table>
        ) : (
          <p className="muted">Sign in to see balances.</p>
        )}
        <button className="ghost" data-noclick onClick={() => void refresh()}>
          Refresh
        </button>
      </section>

      <MetricsPanel
        m={m}
        onManualPrompt={() => update((p) => ({ ...p, manualPrompts: p.manualPrompts + 1 }))}
        onReset={() => {
          clearMetrics();
          const fresh = { ...emptyMetrics(), landingAt: Date.now() };
          saveMetrics(fresh);
          setM(fresh);
        }}
      />
    </main>
  );
}

function MetricsPanel({ m, onManualPrompt, onReset }: { m: Metrics; onManualPrompt: () => void; onReset: () => void }) {
  const copy = () => {
    try {
      void navigator.clipboard.writeText(JSON.stringify(m, null, 2));
    } catch {
      // clipboard blocked
    }
  };
  return (
    <section className="card">
      <h2>Metrics</h2>
      <table className="kv">
        <tbody>
          <tr><td>Clicks</td><td>{m.clicks}</td></tr>
          <tr><td>Signature or consent requests sent to the wallet</td><td>{m.signatureRequests}</td></tr>
          <tr><td>Privy modals opened</td><td>{m.privyModalOpens}</td></tr>
          <tr><td>Native prompts logged by hand (passkey sheet, Google window, email code)</td><td>{m.manualPrompts}</td></tr>
          <tr><td>Login method</td><td>{m.loginMethod ?? "-"}{m.returningVisit ? " (returning)" : ""}</td></tr>
          <tr><td>Landing</td><td>{ts(m.landingAt)}</td></tr>
          <tr><td>Signed in</td><td>{ts(m.signedInAt)} ({secondsBetween(m.landingAt, m.signedInAt)})</td></tr>
          <tr><td>Funded</td><td>{ts(m.fundedAt)} ({secondsBetween(m.landingAt, m.fundedAt)})</td></tr>
          <tr><td>First trade confirmed</td><td>{ts(m.firstTradeAt)} ({secondsBetween(m.landingAt, m.firstTradeAt)})</td></tr>
          <tr><td>Agent granted</td><td>{ts(m.agentGrantedAt)}</td></tr>
          <tr><td>Agent buy seen</td><td>{ts(m.agentTradeSeenAt)} ({secondsBetween(m.agentGrantedAt, m.agentTradeSeenAt)})</td></tr>
        </tbody>
      </table>
      <h3>Transactions</h3>
      {m.txs.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <div className="scroll">
          <table className="txs">
            <thead>
              <tr><th>Step</th><th>Call</th><th>Status</th><th>Gas paid by</th><th>Tx</th></tr>
            </thead>
            <tbody>
              {m.txs.map((t, i) => (
                <tr key={`${t.hash}-${i}`}>
                  <td>{t.step}</td>
                  <td>{t.label}</td>
                  <td>{t.status}</td>
                  <td>
                    {t.payer}
                    {t.from ? ` (${short(t.from)})` : ""}
                  </td>
                  <td>
                    {t.hash ? (
                      <a href={explorerTx(t.hash)} target="_blank" rel="noreferrer">
                        {short(t.hash)}
                      </a>
                    ) : (
                      "-"
                    )}
                    {t.note ? <div className="muted small">{t.note}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        <button className="ghost" data-noclick onClick={onManualPrompt}>
          +1 native prompt
        </button>
        <button className="ghost" data-noclick onClick={copy}>
          Copy JSON
        </button>
        <button className="ghost" data-noclick onClick={onReset}>
          Reset metrics
        </button>
      </div>
    </section>
  );
}

const short = (s: string) => `${s.slice(0, 6)}...${s.slice(-4)}`;
const fmt = (v: bigint) => Number(formatUnits(v, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 });
const ts = (v: number | null) => (v ? new Date(v).toLocaleTimeString() : "-");
