"use client";
// The mock world: the mock-controls state (mirrored in the URL so every state is a link) and a
// pretend wallet kept in localStorage. Swapping to live data replaces this provider, not the screens.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { configQuery, DEFAULT_CONFIG, type MockConfig } from "./config";
import type { Gpu, Position, Side, Wallet } from "./types";

export type { MockConfig } from "./config";

// render checks open the app with ?agentcheck=1; they get their own wallet so they never touch a person's own
const WALLET_KEY = typeof window !== "undefined" && window.location.search.includes("agentcheck") ? "agate-mock-wallet-check" : "agate-mock-wallet-v1";
const EMPTY_WALLET: Wallet = { signedIn: false, email: null, balance: 0, lastDrip: null, positions: [] };
export const DRIP = 10_000;

export interface OpenArgs {
  gpu: Gpu;
  month: string;
  side: Side;
  q: number;
  price: number;
  floor: number;
  cap: number;
  daily: boolean;
}

interface Ctx {
  config: MockConfig;
  setConfig: (patch: Partial<MockConfig>) => void;
  wallet: Wallet;
  signIn: (email: string) => void;
  signOut: () => void;
  drip: () => void;
  open: (a: OpenArgs) => Position;
  reset: () => void;
}

const MockCtx = createContext<Ctx | null>(null);

function readWallet(): Wallet {
  try {
    const raw = localStorage.getItem(WALLET_KEY);
    return raw ? { ...EMPTY_WALLET, ...JSON.parse(raw) } : EMPTY_WALLET;
  } catch {
    return EMPTY_WALLET;
  }
}

export function MockProvider({ initial, children }: { initial: MockConfig; children: React.ReactNode }) {
  const [config, setConfigState] = useState<MockConfig>(initial);
  const [wallet, setWallet] = useState<Wallet>(EMPTY_WALLET);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const w = readWallet();
    // the URL wins over the stored sign-in, so ?auth=in always shows the signed-in app
    if (initial.auth === "in" && !w.signedIn) setWallet({ ...w, signedIn: true, email: "you@example.com", balance: w.balance || DRIP });
    else if (initial.auth === "out" && w.signedIn) setWallet({ ...w, signedIn: false });
    else setWallet(w);
    setReady(true);
  }, [initial.auth]);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(WALLET_KEY, JSON.stringify(wallet));
    } catch {}
  }, [wallet, ready]);

  // keep every mock state in the URL (defaults left out); an effect, because the router may not update mid-render
  useEffect(() => {
    const url = new URL(window.location.href);
    (Object.keys(config) as (keyof MockConfig)[]).forEach((k) => {
      if (config[k] === DEFAULT_CONFIG[k]) url.searchParams.delete(k);
      else url.searchParams.set(k, String(config[k]));
    });
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.toString());
  }, [config]);

  const setConfig = useCallback((patch: Partial<MockConfig>) => {
    setConfigState((c) => ({ ...c, ...patch }));
    if (patch.auth === "in") setWallet((w) => (w.signedIn ? w : { ...w, signedIn: true, email: w.email ?? "you@example.com", balance: w.balance || DRIP }));
    if (patch.auth === "out") setWallet((w) => ({ ...w, signedIn: false }));
  }, []);

  const signIn = useCallback(
    (email: string) => {
      setWallet((w) => ({ ...w, signedIn: true, email }));
      setConfig({ auth: "in" });
    },
    [setConfig],
  );
  const signOut = useCallback(() => setConfig({ auth: "out" }), [setConfig]);
  const drip = useCallback(() => setWallet((w) => ({ ...w, balance: w.balance + DRIP, lastDrip: new Date().toISOString() })), []);

  const open = useCallback((a: OpenArgs): Position => {
    const cost = a.side === "long" ? a.price * a.q : (a.cap - a.price) * a.q;
    const backNow = a.side === "long" && a.daily ? a.floor * a.q : 0;
    const pos: Position = {
      id: Math.random().toString(36).slice(2, 10),
      gpu: a.gpu,
      month: a.month,
      side: a.side,
      q: a.q,
      entry: a.price,
      daily: a.daily,
      paid: backNow,
      openedAt: new Date().toISOString(),
    };
    setWallet((w) => ({ ...w, balance: w.balance - cost + backNow, positions: [pos, ...w.positions] }));
    return pos;
  }, []);

  const reset = useCallback(() => {
    setWallet(EMPTY_WALLET);
    setConfig({ auth: "out" });
  }, [setConfig]);

  const value = useMemo(() => ({ config, setConfig, wallet, signIn, signOut, drip, open, reset }), [config, setConfig, wallet, signIn, signOut, drip, open, reset]);
  return <MockCtx.Provider value={value}>{children}</MockCtx.Provider>;
}

export function useMock() {
  const c = useContext(MockCtx);
  if (!c) throw new Error("useMock outside MockProvider");
  return c;
}

/** Query string for in-app links. The check-tab marker is read after mount, so the server and the first client
 * render agree (reading window during render caused a hydration mismatch on the nav links). */
export function useLinkQuery() {
  const { config } = useMock();
  const [check, setCheck] = useState(false);
  useEffect(() => {
    setCheck(window.location.search.includes("agentcheck"));
  }, []);
  return configQuery(config, check);
}
