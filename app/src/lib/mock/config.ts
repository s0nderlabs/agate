// Mock-controls state, shared by the server page (reads the URL) and the client provider.
import type { DataState } from "./data";
import type { Gpu } from "./types";

export type Variant = "a" | "b" | "c";
export interface MockConfig {
  /** archive only: which reference grammar the old Markets mock uses */
  v: Variant;
  /** which build of the trade screen: round 4 (latest) or the frozen round 3 snapshot */
  pass: "r4" | "r3";
  /** the look being judged on the trade screen */
  style: "tech" | "simple";
  /** corner radius, judged on its own: square 2 px, soft 6 to 10 px, round 12 px and pills */
  corners: "square" | "soft" | "round";
  /** trade header: two prices + band (round 3) or one big price (round 2) */
  head: "two" | "one";
  /** under the navbar: still tabs, chips, or the scrolling ticker above the notice (round 2) */
  row: "tabs" | "chips" | "ticker";
  /** what marks the active nav link: the stone (round 3) or a small square (round 2) */
  mark: "stone" | "square";
  /** dark palette: warm graphite (round 3) or near-black (round 2) */
  dark: "graphite" | "black";
  /** price sources + comparison: on demand from "5 of 5 clouds" (round 4c), in the header (4b), below the chart (4) */
  ctx: "link" | "pop" | "top" | "bottom";
  /** the month's market stats in the header (traded today, held open, trading closes) */
  stats: "on" | "off";
  /** risk rows: "if November averages $1.95 or less" (plain) or "if it settles at $1.95" (round 4) */
  risk: "avg" | "settle";
  /** Pro mode's trade panel: an order ticket like any asset on a book (round 5), or the Simple plan (before) */
  ticket: "order" | "plan";
  /** signed out: the trade button reads "Sign in to trade" (round 5), or shows the trade as before */
  gate: "signin" | "trade";
  /** the November book: the testnet bot's real shape (3 levels, 1% around fair) or the earlier deep mock */
  book: "bot" | "deep";
  /** header: one scoreboard (labels on one line, no paragraph), or the earlier orders with the "What it means" sentence */
  horder: "board" | "numbers" | "meaning";
  /** trade panel: a full-height column from the top (prices and stats sit over the chart only), or under the header */
  tpanel: "top" | "under";
  /** header stats beside the prices: two rows with the outlook (Traders expect, Settles between, Today's range), or one row */
  hstats: "refs" | "charts" | "rich" | "grid" | "row";
  /** what tells you a label has a note: a quiet info icon, or the dotted underline */
  hint: "icon" | "dots";
  /** the app's own Simple / Pro switch */
  mode: "simple" | "pro";
  theme: "light" | "dark";
  auth: "out" | "in";
  data: DataState;
  gpu: Gpu;
  dock: "open" | "closed";
  /** wordmark size in the lockup: x-height over stone height, 37% / 48% / 56% */
  wm: "orig" | "l" | "xl";
  /** wordmark case: "Agate" (Oct 3) or the locked lowercase "agate" */
  wcase: "title" | "lower";
}

/** Mock controls (the side panel, the archive and every option being judged): on in `next dev`, off in a production
 *  build. NEXT_PUBLIC_MOCK_CONTROLS=on or =off overrides either way; Next inlines it at build time. */
const flag = process.env.NEXT_PUBLIC_MOCK_CONTROLS;
export const MOCK_CONTROLS = flag === "on" || (flag !== "off" && process.env.NODE_ENV !== "production");

export const DEFAULT_CONFIG: MockConfig = { v: "a", pass: "r4", style: "tech", corners: "square", head: "two", row: "tabs", mark: "stone", dark: "graphite", ctx: "link", stats: "on", risk: "avg", ticket: "order", gate: "signin", book: "bot", horder: "meaning", tpanel: "top", hstats: "refs", hint: "icon", mode: "simple", theme: "light", auth: "out", data: "live", gpu: "H100", dock: "closed", wm: "l", wcase: "title" };

export function parseConfig(sp: Record<string, string | string[] | undefined>): MockConfig {
  const pick = <T extends string>(k: string, allowed: readonly T[], d: T): T => {
    const raw = sp[k];
    const val = Array.isArray(raw) ? raw[0] : raw;
    return allowed.includes(val as T) ? (val as T) : d;
  };
  const all: MockConfig = {
    v: pick("v", ["a", "b", "c"] as const, DEFAULT_CONFIG.v),
    pass: pick("pass", ["r4", "r3"] as const, DEFAULT_CONFIG.pass),
    style: pick("style", ["tech", "simple"] as const, DEFAULT_CONFIG.style),
    corners: pick("corners", ["square", "soft", "round"] as const, DEFAULT_CONFIG.corners),
    head: pick("head", ["two", "one"] as const, DEFAULT_CONFIG.head),
    row: pick("row", ["tabs", "chips", "ticker"] as const, DEFAULT_CONFIG.row),
    mark: pick("mark", ["stone", "square"] as const, DEFAULT_CONFIG.mark),
    dark: pick("dark", ["graphite", "black"] as const, DEFAULT_CONFIG.dark),
    ctx: pick("ctx", ["link", "pop", "top", "bottom"] as const, DEFAULT_CONFIG.ctx),
    stats: pick("stats", ["on", "off"] as const, DEFAULT_CONFIG.stats),
    risk: pick("risk", ["avg", "settle"] as const, DEFAULT_CONFIG.risk),
    ticket: pick("ticket", ["order", "plan"] as const, DEFAULT_CONFIG.ticket),
    gate: pick("gate", ["signin", "trade"] as const, DEFAULT_CONFIG.gate),
    book: pick("book", ["bot", "deep"] as const, DEFAULT_CONFIG.book),
    horder: pick("horder", ["board", "numbers", "meaning"] as const, DEFAULT_CONFIG.horder),
    tpanel: pick("tpanel", ["top", "under"] as const, DEFAULT_CONFIG.tpanel),
    hstats: pick("hstats", ["refs", "charts", "rich", "grid", "row"] as const, DEFAULT_CONFIG.hstats),
    hint: pick("hint", ["icon", "dots"] as const, DEFAULT_CONFIG.hint),
    mode: pick("mode", ["simple", "pro"] as const, DEFAULT_CONFIG.mode),
    theme: pick("theme", ["light", "dark"] as const, DEFAULT_CONFIG.theme),
    auth: pick("auth", ["out", "in"] as const, DEFAULT_CONFIG.auth),
    data: pick("data", ["live", "loading", "degraded", "carried"] as const, DEFAULT_CONFIG.data),
    gpu: pick("gpu", ["H100", "H200", "B200"] as const, DEFAULT_CONFIG.gpu),
    dock: pick("dock", ["open", "closed"] as const, DEFAULT_CONFIG.dock),
    wm: pick("wm", ["orig", "l", "xl"] as const, DEFAULT_CONFIG.wm),
    wcase: pick("wcase", ["title", "lower"] as const, DEFAULT_CONFIG.wcase),
  };
  // without the controls only the app's own states come from the URL (Simple/Pro, theme, GPU, sign-in);
  // every option being judged stays at its default, so an old link cannot open a rejected round
  return MOCK_CONTROLS ? all : { ...DEFAULT_CONFIG, mode: all.mode, theme: all.theme, gpu: all.gpu, auth: all.auth };
}

/** One click to see a whole round: the screen as it was before the anti-Ornn changes, or as it is now. */
export const VERSIONS: { label: string; set: Partial<MockConfig> }[] = [
  { label: "Round 4 (latest)", set: { pass: "r4", head: "two", row: "tabs", mark: "stone", dark: "graphite", wcase: "title" } },
  { label: "Round 3", set: { pass: "r3", head: "two", row: "tabs", mark: "stone", dark: "graphite", wcase: "title" } },
  { label: "Round 2", set: { pass: "r3", head: "one", row: "ticker", mark: "square", dark: "black", wcase: "lower" } },
];

/** The name as written in running text: "Agate" (Oct 3), or the earlier lowercase under Name case. */
export function brand(c: Pick<MockConfig, "wcase">) {
  return c.wcase === "lower" ? "agate" : "Agate";
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
