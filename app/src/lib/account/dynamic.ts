// The real account's two lazy libraries (wallet spec 2.3), browser only. getDynamic() is ONE headless Dynamic client
// per tab (React Strict Mode's double effects and concurrent callers share it); getWalletLib() is @agate/wallet
// (Kernel accounts, the pocket, ZeroDev). Both load on first use, so a signed-out visitor with no restore hint
// downloads neither (~460 KiB gzip). Never import either one at module scope or from a server component: screens and
// hooks import types only from here. Also the restore hint (spec 2.5) and the Google round trip flag.
export type DynLib = typeof import("@agate/wallet/dynamic");
export type WalletLib = typeof import("@agate/wallet");
export type DynClient = Awaited<ReturnType<DynLib["createAgateDynamic"]>>;
export interface Dyn {
  lib: DynLib;
  client: DynClient;
}

/** ZeroDev's bundler and paymaster (one RPC); without it nothing can be sent, so a live build without it is not set
 *  up for sign-in. A literal process.env read, so Next inlines it at build time. */
export const ZERODEV_RPC = process.env.NEXT_PUBLIC_ZERODEV_RPC ?? "";
export const REAL_CONFIGURED = ZERODEV_RPC.length > 0;

let dyn: Promise<Dyn> | null = null;
let loaded: Dyn | null = null;

/** The client once it is up (it always is while someone is signed in), for reads that must answer at once. */
export const dynNow = () => loaded;

export function getDynamic(): Promise<Dyn> {
  if (typeof window === "undefined") return Promise.reject(new Error("Dynamic runs in the browser only"));
  if (!dyn) {
    dyn = import("@agate/wallet/dynamic").then(async (lib) => {
      loaded = { lib, client: await lib.createAgateDynamic(process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID || undefined, "Agate") };
      return loaded;
    });
    // a failed start (a dropped chunk, Dynamic unreachable) is not kept: "Try again" starts a fresh one
    dyn.catch(() => {
      dyn = null;
    });
  }
  return dyn;
}

let walletLib: Promise<WalletLib> | null = null;

export function getWalletLib(): Promise<WalletLib> {
  if (typeof window === "undefined") return Promise.reject(new Error("@agate/wallet is loaded in the browser only"));
  if (!walletLib) {
    walletLib = import("@agate/wallet");
    walletLib.catch(() => {
      walletLib = null;
    });
  }
  return walletLib;
}

/** Start the download early (pointer on a Sign in button), so the sheet's first step is not the wait. */
export function prefetchDynamic() {
  void getDynamic().catch(() => {});
}

// ===== the restore hint (spec 2.5): who was signed in, so a reload shows a skeleton, never a "Sign in" flash =====

const HINT_KEY = "agate-wallet-hint-v1";

export interface Hint {
  owner: string;
  address: string;
  email: string | null;
}

export function readHint(): Hint | null {
  try {
    const raw = localStorage.getItem(HINT_KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as Partial<Hint>;
    return typeof h.owner === "string" && typeof h.address === "string" ? { owner: h.owner, address: h.address, email: typeof h.email === "string" ? h.email : null } : null;
  } catch {
    return null;
  }
}

export function writeHint(h: Hint | null) {
  try {
    if (h) localStorage.setItem(HINT_KEY, JSON.stringify(h));
    else localStorage.removeItem(HINT_KEY);
  } catch {}
}

// ===== Google's round trip: the page leaves for Google and comes back to the same URL =====

const GOOGLE_KEY = "agate-google-pending-v1";

export function markGoogle(on: boolean) {
  try {
    if (on) sessionStorage.setItem(GOOGLE_KEY, "1");
    else sessionStorage.removeItem(GOOGLE_KEY);
  } catch {}
}

export function googlePending() {
  try {
    return sessionStorage.getItem(GOOGLE_KEY) === "1";
  } catch {
    return false;
  }
}
