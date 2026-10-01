// The comparison numbers, kept in localStorage (wrapped) so a reload keeps them.
import { useSyncExternalStore } from "react";
import { load, save } from "./store";

const KEY = "agate.spike.mera.metrics";

export type Step = "sign-in" | "fund" | "long" | "agent" | "bonus" | "other";
export type Milestone = "landing" | "signedIn" | "gasDripped" | "funded" | "firstTrade" | "agentGranted" | "agentBought";
export type TxRecord = {
  step: Step;
  label: string;
  hash: string;
  payerKind: "user" | "drip sponsor" | "agent";
  payer: string;
  at: number;
  gasLimit?: string;
  gasUsed?: string;
};
export type Metrics = {
  clicks: number;
  clicksByStep: Partial<Record<Step, number>>;
  prompts: number;
  promptsByStep: Partial<Record<Step, number>>;
  promptLog: { at: number; kind: "create" | "get"; step: Step }[];
  sessionSignatures: number;
  times: Partial<Record<Milestone, number>>;
  txs: TxRecord[];
};

const fresh = (): Metrics => ({
  clicks: 0,
  clicksByStep: {},
  prompts: 0,
  promptsByStep: {},
  promptLog: [],
  sessionSignatures: 0,
  times: { landing: Date.now() },
  txs: [],
});

let state: Metrics = load<Metrics | null>(KEY, null) ?? fresh();
if (!state.times.landing) state.times.landing = Date.now();
save(KEY, state);
const listeners = new Set<() => void>();

function update(fn: (m: Metrics) => void) {
  const next = structuredClone(state);
  fn(next);
  state = next;
  save(KEY, state);
  for (const l of listeners) l();
}

/** The step whose button is running, so prompts and clicks are attributed to it. */
export let currentStep: Step = "other";
export const setStep = (s: Step) => {
  currentStep = s;
};

export const metrics = {
  get: () => state,
  click: (step: Step) =>
    update((m) => {
      m.clicks += 1;
      m.clicksByStep[step] = (m.clicksByStep[step] ?? 0) + 1;
    }),
  prompt: (kind: "create" | "get") =>
    update((m) => {
      m.prompts += 1;
      m.promptsByStep[currentStep] = (m.promptsByStep[currentStep] ?? 0) + 1;
      m.promptLog.push({ at: Date.now(), kind, step: currentStep });
    }),
  signature: () => update((m) => void (m.sessionSignatures += 1)),
  mark: (k: Milestone, once = true) =>
    update((m) => {
      if (!once || !m.times[k]) m.times[k] = Date.now();
    }),
  tx: (t: TxRecord) => update((m) => void m.txs.push(t)),
  reset: () => {
    state = fresh();
    save(KEY, state);
    for (const l of listeners) l();
  },
};

export function useMetrics(): Metrics {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
