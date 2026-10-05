"use client";
// The mock world: the mock-controls state (mirrored in the URL so every state is a link) and a
// pretend wallet kept in localStorage. Screens never read the wallet here: they read useAccount() (lib/account), whose
// pretend account (pretend.tsx) wraps this one.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { OpenOrder } from "@/components/trade/OrderTicket";
import { DRIP } from "@/lib/account/types";
import { configQuery, DEFAULT_CONFIG, isCheckTab, type MockConfig } from "./config";
import type { Gpu, Position, Side, Wallet } from "./types";

export type { MockConfig } from "./config";

// render checks open the app with ?agentcheck=1; they get their own wallets so they never touch a person's own. Practice trades
// at live prices keep a wallet of their own, so example trades and live-price trades never mix.
function walletKey(source: MockConfig["source"]) {
  const check = isCheckTab();
  if (source === "live") return check ? "agate-practice-wallet-live-check" : "agate-practice-wallet-live-v1";
  return check ? "agate-mock-wallet-check" : "agate-mock-wallet-v1";
}
// the practice wallet in the client's Wallet shape, the chain-only fields empty until sign-in brings an address
const EMPTY_WALLET: Wallet = { signedIn: false, email: null, balance: 0, lastDrip: null, positions: [], address: "", nextDrip: null, canDrip: true, marginBalance: 0, mon: 0 };
export { DRIP };

export interface OpenArgs {
  gpu: Gpu;
  month: string;
  side: Side;
  q: number;
  price: number;
  floor: number;
  cap: number;
  daily: boolean;
  /** dollars pay me daily pays at once (the ticket's backNow) */
  backNow?: number;
}

/** An example position collected or closed in this tab, and what came back. */
export interface Finished {
  how: "collected" | "closed";
  dollars: number;
}

interface Ctx {
  config: MockConfig;
  setConfig: (patch: Partial<MockConfig>) => void;
  wallet: Wallet;
  signIn: (email: string) => void;
  signOut: () => void;
  drip: () => void;
  open: (a: OpenArgs) => Position;
  /** moves test dollars in or out of the pretend account (a pocket funded from it, or taken back into it) */
  shift: (dollars: number) => void;
  /** a position collected or closed: its dollars come in, a closed one leaves the wallet (the Day's example positions
   *  are kept here, by id, since they are made from the Day rather than saved) */
  finish: (id: string, how: Finished["how"], dollars: number) => void;
  finished: Record<string, Finished>;
  /** the data source whose wallet is loaded in state (null between a source switch and its load) */
  loadedFor: MockConfig["source"] | null;
  reset: () => void;
  /** how many times Reset was pressed on this page: what lives outside the wallet (pretend timers, the AI world) follows it */
  resets: number;
}

const MockCtx = createContext<Ctx | null>(null);

type SavedPosition = Partial<Position> & Pick<Position, "id" | "gpu" | "month" | "side" | "q" | "entry" | "daily" | "paid" | "openedAt">;

/** A practice position with the client's fields filled (a pay-me-daily or short position, nothing claimable). Wallets
 * saved before Oct 4 lack those fields, so every position read back goes through here too. */
function practicePosition(p: SavedPosition): Position {
  return { kind: "position", series: "", positionId: null, claimable: 0, payee: null, inMargin: 0, ...p };
}

function readWallet(key: string): Wallet {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return EMPTY_WALLET;
    const w = { ...EMPTY_WALLET, ...JSON.parse(raw) } as Wallet;
    return { ...w, positions: Array.isArray(w.positions) ? w.positions.map(practicePosition) : [] };
  } catch {
    return EMPTY_WALLET;
  }
}

export function MockProvider({ initial, children }: { initial: MockConfig; children: React.ReactNode }) {
  const [config, setConfigState] = useState<MockConfig>(initial);
  const [wallet, setWallet] = useState<Wallet>(EMPTY_WALLET);
  // the storage key the wallet in state came from: it is written back only there, so switching the data source never
  // copies one wallet into the other
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const key = walletKey(config.source);
  const authNow = useRef(config.auth);
  authNow.current = config.auth;

  useEffect(() => {
    const w = readWallet(key);
    // the URL wins over the stored sign-in, so ?auth=in always shows the signed-in app
    if (authNow.current === "in" && !w.signedIn) setWallet({ ...w, signedIn: true, email: "you@example.com", balance: w.balance || DRIP });
    else if (authNow.current === "out" && w.signedIn) setWallet({ ...w, signedIn: false });
    else setWallet(w);
    setLoadedKey(key);
  }, [key]);

  useEffect(() => {
    if (loadedKey !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify(wallet));
    } catch {}
  }, [wallet, loadedKey, key]);

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
    const backNow = a.backNow ?? (a.side === "long" && a.daily ? a.floor * a.q : 0);
    const id = Math.random().toString(36).slice(2, 10);
    // held tokens for a plain Long; a pay me daily Long or a Short is a position, closed by its id
    const tokens = a.side === "long" && !a.daily;
    const pos = practicePosition({
      id,
      kind: tokens ? "tokens" : "position",
      positionId: tokens ? null : id,
      gpu: a.gpu,
      month: a.month,
      side: a.side,
      q: a.q,
      entry: a.price,
      daily: a.daily,
      paid: backNow,
      openedAt: new Date().toISOString(),
    });
    setWallet((w) => ({ ...w, balance: w.balance - cost + backNow, positions: [pos, ...w.positions] }));
    return pos;
  }, []);

  const shift = useCallback((dollars: number) => setWallet((w) => ({ ...w, balance: Math.max(0, Math.round((w.balance + dollars) * 100) / 100) })), []);

  const [finished, setFinished] = useState<Record<string, Finished>>({});
  // kept beside the wallet it paid into (its own key), loaded and saved with it
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`${key}-finished`);
      setFinished(raw ? (JSON.parse(raw) as Record<string, Finished>) : {});
    } catch {
      setFinished({});
    }
  }, [key]);
  useEffect(() => {
    if (loadedKey !== key) return;
    try {
      localStorage.setItem(`${key}-finished`, JSON.stringify(finished));
    } catch {}
  }, [finished, loadedKey, key]);
  const finish = useCallback((id: string, how: Finished["how"], dollars: number) => {
    setFinished((f) => ({ ...f, [id]: { how, dollars } }));
    setWallet((w) => ({ ...w, balance: Math.max(0, Math.round((w.balance + dollars) * 100) / 100), positions: how === "closed" ? w.positions.filter((p) => p.id !== id) : w.positions }));
  }, []);

  const [resets, setResets] = useState(0);
  const reset = useCallback(() => {
    setFinished({});
    setWallet(EMPTY_WALLET);
    setConfig({ auth: "out" });
    setResets((n) => n + 1);
  }, [setConfig]);

  const loadedFor = loadedKey === key ? config.source : null;
  const value = useMemo(
    () => ({ config, setConfig, wallet, signIn, signOut, drip, open, shift, finish, finished, loadedFor, reset, resets }),
    [config, setConfig, wallet, signIn, signOut, drip, open, shift, finish, finished, loadedFor, reset, resets],
  );
  return <MockCtx.Provider value={value}>{children}</MockCtx.Provider>;
}

export function useMock() {
  const c = useContext(MockCtx);
  if (!c) throw new Error("useMock outside MockProvider");
  return c;
}

// Pro's resting practice limit orders, per data source (an example order never shows, or holds dollars, under live).
// Kept for the page's life outside any screen: each route mounts its own MockProvider, so state there would drop the
// orders, and the dollars they hold, on a trip to Positions and back. A reload clears them (practice only).
const NO_ORDERS: OpenOrder[] = [];
const ordersBySource: Record<MockConfig["source"], OpenOrder[]> = { example: NO_ORDERS, live: NO_ORDERS };
const orderSubs = new Set<() => void>();
function subscribeOrders(fn: () => void) {
  orderSubs.add(fn);
  return () => {
    orderSubs.delete(fn);
  };
}

/** The open practice orders of the source on screen, and a way to change them. */
export function useOpenOrders() {
  const { config } = useMock();
  const source = config.source;
  const orders = useSyncExternalStore(
    subscribeOrders,
    () => ordersBySource[source],
    () => NO_ORDERS,
  );
  const setOrders = useCallback(
    (f: (list: OpenOrder[]) => OpenOrder[]) => {
      ordersBySource[source] = f(ordersBySource[source]);
      orderSubs.forEach((fn) => fn());
    },
    [source],
  );
  return { orders, setOrders };
}

/** Query string for in-app links. The check-tab marker is read after mount, so the server and the first client
 * render agree (reading window during render caused a hydration mismatch on the nav links). */
export function useLinkQuery() {
  const { config } = useMock();
  const [check, setCheck] = useState(false);
  useEffect(() => {
    setCheck(isCheckTab());
  }, []);
  return configQuery(config, check);
}
