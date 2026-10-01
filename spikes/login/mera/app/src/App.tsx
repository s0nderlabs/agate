import { toViemAccount } from "@category-labs/mera/viem";
import { useEffect, useRef, useState } from "react";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  type Hash,
  http,
  isAddress,
  parseEther,
  type PublicClient,
} from "viem";
import { addressUrl, defaultRpcUrl, flow, monadTestnet, txUrl } from "./core/chain";
import { type Balances, claimTestUsd, goLong, grantAgent, readBalances, type Sent, type Signer } from "./core/flow";
import { GAS } from "./core/gas";
import { defaultScope, describeScope, type ScopeState, type SessionScope, scopeAccount } from "./core/scope";
import { type Metrics, metrics, type Step, setStep, useMetrics } from "./metrics";
import {
  createAccount,
  describeError,
  installPromptCounter,
  openNote,
  savedCredential,
  savedNoteVault,
  sealNote,
  signIn,
  type Unlocked,
} from "./passkey";
import { load, remove, save } from "./store";

const rpcUrl = import.meta.env.VITE_RPC_URL || defaultRpcUrl;
const chain = monadTestnet(rpcUrl);
const client = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
const SESSION_MINUTES = Number(import.meta.env.VITE_SESSION_MINUTES || 30);
const ENV_AGENT = import.meta.env.VITE_AGENT_ADDRESS as string | undefined;
const ADDRESS_KEY = "agate.spike.mera.address";
const AGENT_KEY = "agate.spike.mera.agent";
const GAS_FLOOR = parseEther("0.05");

installPromptCounter(metrics.prompt);
// Global click counter. Clicks inside [data-nocount] (the metrics panel and checks) are instrumentation.
document.addEventListener(
  "click",
  (e) => {
    const el = e.target as HTMLElement | null;
    if (!el || el.closest("[data-nocount]")) return;
    const step = (el.closest("[data-step]")?.getAttribute("data-step") ?? "other") as Step;
    metrics.click(step);
  },
  { capture: true },
);

type Live = { unlocked: Unlocked; scope: SessionScope; scopeState: ScopeState; wallet: Signer };

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const usd = (v?: bigint) => (v === undefined ? "-" : Number(formatUnits(v, 6)).toLocaleString());

export function App() {
  const m = useMetrics();
  const [live, setLive] = useState<Live | null>(null);
  const [address, setAddress] = useState<Address | undefined>(() => load<Address | undefined>(ADDRESS_KEY, undefined));
  const [hasCredential, setHasCredential] = useState(() => !!savedCredential());
  const [balances, setBalances] = useState<Balances>();
  const [busy, setBusy] = useState<Step | null>(null);
  const [msg, setMsg] = useState<Partial<Record<Step, string>>>({});
  const [agentInput, setAgentInput] = useState<string>(() => ENV_AGENT || load(AGENT_KEY, ""));
  const [now, setNow] = useState(Date.now());
  const [note, setNote] = useState("");
  const [agentHash, setAgentHash] = useState("");
  const expiryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const agent = isAddress(agentInput) ? (agentInput as Address) : undefined;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function refresh(addr = address) {
    if (addr) setBalances(await readBalances(client, addr, agent).catch(() => undefined));
  }
  useEffect(() => {
    void refresh();
  }, [address, agent]);

  function goLive(u: Unlocked): Live {
    const scope = defaultScope(Date.now(), SESSION_MINUTES);
    const scopeState: ScopeState = { spent: 0n, signatures: 0 };
    const account = scopeAccount(toViemAccount(u.session), scope, scopeState, () => metrics.signature());
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) }) as Signer;
    const next = { unlocked: u, scope, scopeState, wallet };
    clearTimeout(expiryTimer.current);
    expiryTimer.current = setTimeout(() => {
      u.session.end(); // zeroes the key; the next action asks for the passkey again
      setLive(null);
    }, scope.expiresAt - Date.now());
    setLive(next);
    setAddress(u.address);
    setHasCredential(true);
    save(ADDRESS_KEY, u.address);
    return next;
  }

  async function ensureLive(): Promise<Live> {
    if (live && Date.now() < live.scope.expiresAt) return live;
    live?.unlocked.session.end();
    const pinned = savedCredential();
    if (!pinned) throw new Error("Sign in first (step 1).");
    return goLive(await signIn(pinned));
  }

  async function ensureGas(addr: Address) {
    const bal = await client.getBalance({ address: addr });
    if (bal >= GAS_FLOOR) return;
    const res = await fetch("/drip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: addr }),
    }).catch(() => undefined);
    const body = (await res?.json().catch(() => ({}))) as { hash?: Hash; from?: string; error?: string; reason?: string; skipped?: boolean };
    if (!res || !res.ok) throw new Error(`Gas drip unavailable (${body?.error ?? "is drip/server.ts running?"}).`);
    if (body.hash && !body.skipped) {
      metrics.tx({ step: "sign-in", label: "gas drip 0.2 MON", hash: body.hash, payerKind: "drip sponsor", payer: body.from ?? "drip", at: Date.now(), gasLimit: GAS.dripTransfer.toString() });
      metrics.mark("gasDripped");
    } else if (body.skipped && (await client.getBalance({ address: addr })) < GAS_FLOOR) {
      throw new Error(`No gas: drip skipped (${body.reason}).`);
    }
  }

  function record(step: Step, sent: Sent, from: Address) {
    metrics.tx({
      step,
      label: sent.label,
      hash: sent.hash,
      payerKind: "user",
      payer: from,
      at: Date.now(),
      gasLimit: sent.gasLimit.toString(),
      gasUsed: sent.receipt.gasUsed.toString(),
    });
  }

  async function run(step: Step, fn: () => Promise<string | undefined>) {
    setStep(step);
    setBusy(step);
    setMsg((s) => ({ ...s, [step]: "Working..." }));
    try {
      const done = await fn();
      setMsg((s) => ({ ...s, [step]: done ?? "Done" }));
    } catch (e) {
      setMsg((s) => ({ ...s, [step]: describeError(e) }));
    } finally {
      setBusy(null);
      setStep("other");
      void refresh();
    }
  }

  const onSignIn = (mode: "auto" | "picker" | "create") =>
    run("sign-in", async () => {
      const pinned = savedCredential();
      const u =
        mode === "create" || (mode === "auto" && !pinned)
          ? await createAccount()
          : await signIn(mode === "picker" ? undefined : pinned);
      const l = goLive(u);
      metrics.mark("signedIn");
      await ensureGas(l.unlocked.address);
      await refresh(l.unlocked.address);
      return `Signed in as ${short(u.address)}. Session live, no more prompts until it ends.`;
    });

  const onFund = () =>
    run("fund", async () => {
      const l = await ensureLive();
      await ensureGas(l.unlocked.address);
      const sent = await claimTestUsd(l.wallet, client);
      record("fund", sent, l.unlocked.address);
      metrics.mark("funded");
      return "10,000 testUSD received.";
    });

  const onLong = () =>
    run("long", async () => {
      const l = await ensureLive();
      await ensureGas(l.unlocked.address);
      const sent = await goLong(l.wallet, client, flow.buyAmount);
      record("long", sent, l.unlocked.address);
      metrics.mark("firstTrade");
      return "Bought 100 testUSD of spUP (one permit signature + one transaction, no prompt).";
    });

  const onAgent = () =>
    run("agent", async () => {
      if (!agent) throw new Error("Set the agent address first (VITE_AGENT_ADDRESS or the field above).");
      const l = await ensureLive();
      await ensureGas(l.unlocked.address);
      const { approve, grant, expiry } = await grantAgent(l.wallet, client, agent);
      record("agent", approve, l.unlocked.address);
      record("agent", grant, l.unlocked.address);
      metrics.mark("agentGranted");
      return `Agent ${short(agent)} may spend 200 testUSD until ${new Date(Number(expiry) * 1000).toLocaleString()}. Now run agent/run.ts.`;
    });

  const onLogAgentTx = () =>
    run("other", async () => {
      const r = await client.getTransactionReceipt({ hash: agentHash.trim() as Hash });
      metrics.tx({ step: "agent", label: "buyUpFor (agent/run.ts)", hash: r.transactionHash, payerKind: "agent", payer: r.from, at: Date.now(), gasUsed: r.gasUsed.toString() });
      metrics.mark("agentBought");
      return `Logged agent tx, status ${r.status}.`;
    });

  const onSeal = () =>
    run("bonus", async () => {
      const pinned = savedCredential();
      if (!pinned) throw new Error("Sign in first.");
      await sealNote(pinned, note || "(empty)");
      setNote("");
      return "Note sealed with its own PRF namespace. Only ciphertext is stored.";
    });
  const onOpen = () => run("bonus", async () => `Your note: ${await openNote()}`);

  const onEnd = () => {
    live?.unlocked.session.end();
    clearTimeout(expiryTimer.current);
    setLive(null);
  };
  const onForget = () => {
    onEnd();
    for (const k of [ADDRESS_KEY, "agate.spike.mera.credential", "agate.spike.mera.noteVault"]) remove(k);
    setAddress(undefined);
    setHasCredential(false);
    setBalances(undefined);
  };

  const left = live ? Math.max(0, Math.round((live.scope.expiresAt - now) / 1000)) : 0;
  const status = (s: Step) => msg[s] && <p className="status">{msg[s]}</p>;

  return (
    <main>
      <header>
        <h1>agate login spike: Mera</h1>
        <p className="sub">Passkey EOA on Monad testnet. Session signs without prompts. Gas from a 0.2 MON drip.</p>
        {address && (
          <p className="acct">
            <a href={addressUrl(address)} target="_blank" rel="noreferrer">{short(address)}</a>
            <span>{balances ? `${Number(formatEther(balances.mon)).toFixed(4)} MON` : "-"}</span>
            <span>{usd(balances?.usd)} testUSD</span>
            <span>{usd(balances?.up)} spUP</span>
          </p>
        )}
      </header>

      <section className="card" data-step="sign-in">
        <h2><span className="n">1</span> Sign in</h2>
        <p className="hint">{hasCredential ? "Welcome back: one passkey prompt rebuilds the same account." : "First visit: one passkey prompt creates your account. No email, no seed phrase."}</p>
        <div className="row">
          <button type="button" className="primary" disabled={!!busy || !!live} onClick={() => void onSignIn("auto")}>
            {live ? "Signed in" : hasCredential ? "Sign in" : "Create account"}
          </button>
          <button type="button" className="ghost" disabled={!!busy} onClick={() => void onSignIn(hasCredential ? "create" : "picker")}>
            {hasCredential ? "Create a new account" : "I already have a passkey"}
          </button>
        </div>
        {status("sign-in")}
      </section>

      <section className="card" data-step="fund">
        <h2><span className="n">2</span> Get 10,000 testUSD</h2>
        <button type="button" className="primary" disabled={!!busy || !address} onClick={() => void onFund()}>Get 10,000 testUSD</button>
        {status("fund")}
      </section>

      <section className="card" data-step="long">
        <h2><span className="n">3</span> Go Long</h2>
        <p className="hint">Buy 100 testUSD of spUP (H100 UP). Permit and buy in one transaction.</p>
        <button type="button" className="primary" disabled={!!busy || !address} onClick={() => void onLong()}>Go Long 100</button>
        {status("long")}
      </section>

      <section className="card" data-step="agent">
        <h2><span className="n">4</span> Let an agent buy for me</h2>
        <p className="hint">Grants the agent up to 200 testUSD for 1 day. The agent then buys on its own.</p>
        {!ENV_AGENT && (
          <label className="field" data-nocount>
            Agent address (VITE_AGENT_ADDRESS is not set; get it with <code>bun agent/run.ts --address</code>)
            <input value={agentInput} placeholder="0x..." onChange={(e) => { setAgentInput(e.target.value); save(AGENT_KEY, e.target.value); }} />
          </label>
        )}
        <button type="button" className="primary" disabled={!!busy || !address || !agent} onClick={() => void onAgent()}>Allow agent: 200 testUSD, 1 day</button>
        {status("agent")}
        {address && (
          <div className="agentbox" data-nocount>
            <p>Then, with nobody at the page:</p>
            <pre>bun agent/run.ts {address}</pre>
            <p className="hint">
              Grant left: {usd(balances?.agentRemaining)} testUSD
              {balances?.agentExpiry ? `, expires ${new Date(Number(balances.agentExpiry) * 1000).toLocaleString()}` : ""}
            </p>
            <div className="row">
              <input value={agentHash} placeholder="paste the agent tx hash to log it" onChange={(e) => setAgentHash(e.target.value)} />
              <button type="button" className="ghost" disabled={!agentHash} onClick={() => void onLogAgentTx()}>Log</button>
              <button type="button" className="ghost" onClick={() => void refresh()}>Refresh</button>
            </div>
            {status("other")}
          </div>
        )}
      </section>

      <section className="card session" data-nocount>
        <h2>Session</h2>
        {live ? (
          <>
            <p>
              Live, ends in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}. Signed {live.scopeState.signatures} times without a prompt. Spent {usd(live.scopeState.spent)} of {usd(live.scope.buyCap)} testUSD.
            </p>
            <ul>{describeScope(live.scope).map((s) => <li key={s}>{s}</li>)}</ul>
            <button type="button" className="ghost" onClick={onEnd}>End session now</button>
          </>
        ) : (
          <p>No live session. {hasCredential ? "The next step asks for your passkey once, then signs without prompts." : ""}</p>
        )}
        <button type="button" className="ghost" onClick={onForget}>Forget this device (stateless test)</button>
      </section>

      <section className="card" data-step="bonus">
        <h2>Bonus: private trade note</h2>
        <p className="hint">Encrypted with a key from a separate PRF namespace of the same passkey (Mera Keys bounty). One prompt to seal, one to open.</p>
        <textarea value={note} placeholder="Why I went long..." onChange={(e) => setNote(e.target.value)} />
        <div className="row">
          <button type="button" className="ghost" disabled={!!busy || !hasCredential} onClick={() => void onSeal()}>Seal note</button>
          <button type="button" className="ghost" disabled={!!busy || !savedNoteVault()} onClick={() => void onOpen()}>Open note</button>
        </div>
        {status("bonus")}
      </section>

      <MetricsPanel m={m} />
    </main>
  );
}

const MILESTONES: [keyof Metrics["times"], string][] = [
  ["landing", "Landing"],
  ["signedIn", "Signed in"],
  ["gasDripped", "Gas dripped"],
  ["funded", "Funded (testUSD)"],
  ["firstTrade", "First trade confirmed"],
  ["agentGranted", "Agent granted"],
  ["agentBought", "Agent buy logged"],
];

function MetricsPanel({ m }: { m: Metrics }) {
  const t0 = m.times.landing ?? Date.now();
  const steps: Step[] = ["sign-in", "fund", "long", "agent", "bonus"];
  return (
    <section className="card metrics" data-nocount>
      <h2>Metrics</h2>
      <div className="grid">
        <div><b>{m.clicks}</b><span>clicks</span></div>
        <div><b>{m.prompts}</b><span>passkey prompts</span></div>
        <div><b>{m.sessionSignatures}</b><span>prompt-free signatures</span></div>
        <div><b>{m.txs.length}</b><span>transactions</span></div>
      </div>
      <table>
        <thead><tr><th>Step</th><th>Clicks</th><th>Prompts</th></tr></thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s}><td>{s}</td><td>{m.clicksByStep[s] ?? 0}</td><td>{m.promptsByStep[s] ?? 0}</td></tr>
          ))}
        </tbody>
      </table>
      <table>
        <thead><tr><th>Milestone</th><th>At</th><th>Since landing</th></tr></thead>
        <tbody>
          {MILESTONES.map(([k, label]) => (
            <tr key={k}>
              <td>{label}</td>
              <td>{m.times[k] ? new Date(m.times[k]).toLocaleTimeString() : "-"}</td>
              <td>{m.times[k] ? `+${((m.times[k] - t0) / 1000).toFixed(1)} s` : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table>
        <thead><tr><th>Step</th><th>Tx</th><th>Gas paid by</th><th>Gas (declared / used)</th></tr></thead>
        <tbody>
          {m.txs.map((t) => (
            <tr key={t.hash}>
              <td>{t.step}: {t.label}</td>
              <td><a href={txUrl(t.hash)} target="_blank" rel="noreferrer">{short(t.hash)}</a></td>
              <td>{t.payerKind} {short(t.payer)}</td>
              <td>{t.gasLimit ?? "-"} / {t.gasUsed ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Prompts are counted by wrapping navigator.credentials, so Mera's fallback second prompt at creation is included. Monad bills the declared gas.</p>
      <div className="row">
        <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(m, null, 2))}>Copy JSON</button>
        <button type="button" className="ghost" onClick={metrics.reset}>Reset metrics</button>
      </div>
    </section>
  );
}
