// Metrics for the side-by-side comparison. Persisted in localStorage (wrapped: private windows and blocked
// storage throw on access), so a reload or a return visit keeps the numbers.
import { useSyncExternalStore } from "react";

export type TxRecord = {
  step: string;
  at: number;
  userOpHash?: string;
  txHash: string;
  payer: string;
  bundler: string;
  sponsored: boolean;
  path: string;
  signatures: number | "n/a";
  ms: number;
};

export type Metrics = {
  clicks: number;
  visiblePrompts: number; // OS or wallet UI the user had to answer: passkey sheets (create or use)
  silentSignatures: number; // embedded-wallet signatures with no UI (Dynamic MPC signing through our signer)
  emailCodes: number; // one-time codes the user typed
  promptLog: { at: number; kind: string }[];
  t: { landing?: number; signedIn?: number; funded?: number; firstTrade?: number; agentGranted?: number };
  txs: TxRecord[];
  notes: string[];
};

const KEY = "agate-spike-dynamic-metrics-v1";
const empty = (): Metrics => ({
  clicks: 0,
  visiblePrompts: 0,
  silentSignatures: 0,
  emailCodes: 0,
  promptLog: [],
  t: {},
  txs: [],
  notes: [],
});

const load = (): Metrics => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  } catch {
    return empty();
  }
};

let state: Metrics = load();
const listeners = new Set<() => void>();
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
  for (const l of listeners) l();
};

export const metrics = {
  get: () => state,
  update(fn: (m: Metrics) => void) {
    const next = structuredClone(state);
    fn(next);
    state = next;
    save();
  },
  mark(k: keyof Metrics["t"]) {
    if (!state.t[k]) metrics.update((m) => (m.t[k] = Date.now()));
  },
  prompt(kind: string) {
    metrics.update((m) => {
      m.visiblePrompts++;
      m.promptLog.push({ at: Date.now(), kind });
    });
  },
  signature() {
    metrics.update((m) => m.silentSignatures++);
  },
  tx(r: TxRecord) {
    metrics.update((m) => m.txs.push(r));
  },
  note(s: string) {
    metrics.update((m) => m.notes.push(`${new Date().toISOString()} ${s}`));
  },
  reset() {
    state = empty();
    state.t.landing = Date.now();
    save();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export const useMetrics = () => useSyncExternalStore(metrics.subscribe, metrics.get);

// Landing is the first page load of a measurement run (kept until "Reset metrics").
metrics.mark("landing");
// Global click counter: every click anywhere on the page.
if (typeof document !== "undefined") document.addEventListener("click", () => metrics.update((m) => m.clicks++), true);
