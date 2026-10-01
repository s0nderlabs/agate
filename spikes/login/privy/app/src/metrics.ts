// Metrics for the side-by-side comparison. Same fields in every spike so the numbers line up.
// Persisted in localStorage; every access is wrapped because the accessor can throw.

export type Payer = "user" | "sponsor" | "unknown";

export type TxRecord = {
  step: string;
  label: string;
  hash: string;
  from?: string; // onchain tx sender: the user for self-paid, a bundler or relayer when sponsored
  payer: Payer;
  status: "pending" | "success" | "reverted" | "unknown";
  at: number;
  note?: string;
};

export type Metrics = {
  stack: "privy";
  clicks: number;
  // Signature or confirmation requests our code makes to the wallet (each one could show a UI).
  signatureRequests: number;
  // Times a Privy modal actually opened (login modal, any wallet confirmation). Instrumented with useModalStatus.
  privyModalOpens: number;
  // Native OS prompts we cannot see from JS (passkey sheet, Google window). Logged by hand from the button.
  manualPrompts: number;
  landingAt: number | null;
  signedInAt: number | null;
  fundedAt: number | null;
  firstTradeAt: number | null;
  agentGrantedAt: number | null;
  agentTradeSeenAt: number | null;
  loginMethod: string | null;
  returningVisit: boolean;
  txs: TxRecord[];
  notes: string[];
};

const KEY = "agate-spike-privy-metrics-v1";

export function emptyMetrics(): Metrics {
  return {
    stack: "privy",
    clicks: 0,
    signatureRequests: 0,
    privyModalOpens: 0,
    manualPrompts: 0,
    landingAt: null,
    signedInAt: null,
    fundedAt: null,
    firstTradeAt: null,
    agentGrantedAt: null,
    agentTradeSeenAt: null,
    loginMethod: null,
    returningVisit: false,
    txs: [],
    notes: [],
  };
}

export function loadMetrics(): Metrics {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return { ...emptyMetrics(), ...(JSON.parse(raw) as Partial<Metrics>) };
  } catch {
    // private window, blocked storage or bad JSON: start fresh
  }
  return emptyMetrics();
}

export function saveMetrics(m: Metrics): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    // storage unavailable; metrics stay in memory for this tab
  }
}

export function clearMetrics(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function secondsBetween(a: number | null, b: number | null): string {
  if (a == null || b == null) return "-";
  return `${((b - a) / 1000).toFixed(1)} s`;
}
