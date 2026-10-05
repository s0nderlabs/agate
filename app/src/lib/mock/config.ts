// Mock-controls state, shared by the server page (reads the URL) and the client provider. Only the app's own
// states live here (Simple/Pro, theme, GPU, sign-in, data states). A design option joins while it is being judged,
// then the verdict is baked in and the option removed (clean slate Oct 4; earlier rounds are in git, 724577e).
import { DATA_STATES, type DataState } from "./data";
import type { Gpu } from "./types";

export interface MockConfig {
  /** dark mode's trade button: a deeper matte fill with light text, or the bright fill from before */
  dfill: "deep" | "bright";
  /** the app's own Simple / Pro switch */
  mode: "simple" | "pro";
  theme: "light" | "dark";
  auth: "out" | "in";
  data: DataState;
  gpu: Gpu;
  /** where the numbers come from: the example data (with its states) or the live testnet through @agate/client */
  source: "example" | "live";
  dock: "open" | "closed";
  /** phone and tablet layout being judged: the new one (bottom tabs, trade bar, ticket as a sheet) or the stacked one from before */
  phone: "new" | "stacked";
  /** the phone trade bar's Long and Short: tinted like the picked side in the ticket, or filled like the trade button */
  pbar: "tint" | "fill";
  /** example only: how the pretend sign-in answers. auto: set up only a wallet never used before. The first code of a
   *  sheet is the one a wrong or expired outcome refuses; the next one signs in */
  signin: SignInOutcome;
  /** example only: the pretend AIs on Agate's pretend server */
  ais: AisScenario;
  /** example only: how Allow runs on the connect page */
  connect: ConnectOutcome;
  /** example only: how a disconnect runs */
  disc: DisconnectOutcome;
}

export const SIGNIN_OUTCOMES = ["auto", "new", "returning", "wrong", "expired", "walletfail", "dripfail", "slow"] as const;
export type SignInOutcome = (typeof SIGNIN_OUTCOMES)[number];
export const AIS_SCENARIOS = ["none", "one", "two", "ended"] as const;
export type AisScenario = (typeof AIS_SCENARIOS)[number];
export const CONNECT_OUTCOMES = ["normal", "stepup", "notyet", "fundfail", "refused", "expired", "offline"] as const;
export type ConnectOutcome = (typeof CONNECT_OUTCOMES)[number];
export const DISCONNECT_OUTCOMES = ["normal", "stopfail", "takebackfail"] as const;
export type DisconnectOutcome = (typeof DISCONNECT_OUTCOMES)[number];

/** Mock controls (the side panel and the states it sets): on in `next dev`, off in a production build.
 *  NEXT_PUBLIC_MOCK_CONTROLS=on or =off overrides either way; Next inlines it at build time. */
const flag = process.env.NEXT_PUBLIC_MOCK_CONTROLS;
export const MOCK_CONTROLS = flag === "on" || (flag !== "off" && process.env.NODE_ENV !== "production");

// source: example data by default while the live empty states are reviewed (flip to "live" once November lists);
// a build without Mock controls is always live, so its links never carry ?source. pbar: filled, the research
// pick (Oct 4: every persistent trade bar measured is filled; tint keeps meaning "picked side" inside the ticket)
export const DEFAULT_CONFIG: MockConfig = { dfill: "deep", mode: "simple", theme: "light", auth: "out", data: "normal", gpu: "H100", source: MOCK_CONTROLS ? "example" : "live", dock: "closed", phone: "new", pbar: "fill", signin: "auto", ais: "none", connect: "normal", disc: "normal" };

export function parseConfig(sp: Record<string, string | string[] | undefined>): MockConfig {
  const pick = <T extends string>(k: string, allowed: readonly T[], d: T): T => {
    const raw = sp[k];
    const val = Array.isArray(raw) ? raw[0] : raw;
    return allowed.includes(val as T) ? (val as T) : d;
  };
  const all: MockConfig = {
    dfill: pick("dfill", ["deep", "bright"] as const, DEFAULT_CONFIG.dfill),
    mode: pick("mode", ["simple", "pro"] as const, DEFAULT_CONFIG.mode),
    theme: pick("theme", ["light", "dark"] as const, DEFAULT_CONFIG.theme),
    auth: pick("auth", ["out", "in"] as const, DEFAULT_CONFIG.auth),
    data: pick("data", DATA_STATES, DEFAULT_CONFIG.data),
    gpu: pick("gpu", ["H100", "H200", "B200", "B300", "A100", "L40S"] as const, DEFAULT_CONFIG.gpu),
    source: pick("source", ["example", "live"] as const, DEFAULT_CONFIG.source),
    dock: pick("dock", ["open", "closed"] as const, DEFAULT_CONFIG.dock),
    phone: pick("phone", ["new", "stacked"] as const, DEFAULT_CONFIG.phone),
    pbar: pick("pbar", ["fill", "tint"] as const, DEFAULT_CONFIG.pbar),
    signin: pick("signin", SIGNIN_OUTCOMES, DEFAULT_CONFIG.signin),
    ais: pick("ais", AIS_SCENARIOS, DEFAULT_CONFIG.ais),
    connect: pick("connect", CONNECT_OUTCOMES, DEFAULT_CONFIG.connect),
    disc: pick("disc", DISCONNECT_OUTCOMES, DEFAULT_CONFIG.disc),
  };
  // a build without the controls (a hosted one) shows live data only: example numbers can never reach it from a link
  if (!MOCK_CONTROLS) all.source = "live";
  // without the controls, options being judged stay at their default and the made-up data states and the panel
  // cannot be opened from a link
  const D = DEFAULT_CONFIG;
  return MOCK_CONTROLS ? all : { ...all, dfill: D.dfill, data: D.data, dock: D.dock, phone: D.phone, pbar: D.pbar, signin: D.signin, ais: D.ais, connect: D.connect, disc: D.disc };
}

/** A render-check tab (opened with ?agentcheck=1): it keeps its own wallets and pocket dollars, so it never touches a person's own. */
export function isCheckTab() {
  return typeof window !== "undefined" && window.location.search.includes("agentcheck");
}

/** The mock state as a query string (defaults left out), so links between screens keep what is being judged. */
export function configQuery(c: MockConfig, check = false) {
  const q = new URLSearchParams();
  (Object.keys(c) as (keyof MockConfig)[]).forEach((k) => {
    if (c[k] !== DEFAULT_CONFIG[k]) q.set(k, String(c[k]));
  });
  // a render-check tab keeps its marker across links, so it is never mistaken for a person's tab
  if (check) q.set("agentcheck", "1");
  const str = q.toString();
  return str ? `?${str}` : "";
}

/** The page ground behind the app (the html element), so overscroll and the edges match the theme. */
export function groundFor(c: Pick<MockConfig, "theme">) {
  return c.theme === "dark" ? "#141413" : "#f6f5f1";
}
