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
  /** example only: the day the example stands on: today (November listed, December not yet), or a day when two months
   *  are live, November's last hours, the gap before its last day is final, and after it (lib/mock/timeline.ts) */
  when: Moment;
  /** example only: the signed-in example account already holds H100 November (Long with pay me daily, Long, Short) */
  holds: "none" | "nov";
  /** Simple's months, being judged: one (the next full month beside the index) or every open month (before) */
  months: "one" | "both";
  /** being judged (Oct 6 rework study): the trade panel closes what you hold (Open | Close tabs) or only opens (before) */
  closeUi: "tabs" | "before";
  /** being judged: the month chart's candle size follows its range (1D hourly, 1W 4-hourly, Since listing daily; Pro
   *  can override) or is always hourly (before) */
  candles: "auto" | "before";
  /** being judged: Positions in the market page's frame (round 2, Oct 7), the Oct 6 rework, or the page before */
  positionsUi: "market" | "new" | "before";
  /** being judged: Index in the market page's frame (round 2, Oct 7), the Oct 6 rework, or the page before */
  indexUi: "market" | "new" | "before";
  /** being judged (Oct 8): the landing's hero, ten styles, each built on one piece of the product */
  landing: Landing;
  /** being judged (Oct 7): the new mark (round 7's pebble with AGATE in Outfit) in blue lace or onyx, or today's stone;
   *  Oct 9 pick, the folded A (Kuwayama mark 8 as one sheet folded into an A, round 9's pick 3), then "use ink
   *  only": one ink, blue lace kept to compare */
  logo: "fold" | "foldlace" | "lace" | "onyx" | "stone";
  /** being judged (Oct 9): the chip candles without or with wicks */
  wicks: "off" | "on";
  /** being judged (Oct 9):
   *  the chips in silicon's colours, the first chips' one ink, or the page's ink */
  chipColor: "silicon" | "mono" | "ink";
  /** being judged (Oct 9): the half-month before the month faded back
   *  (Landscape, Field) or at full strength */
  oldDays: "faded" | "full";
  /** being judged (Oct 9): on the field, the chips under the top bar and
   *  behind the words switch off (on) or a shade lies over the board (off, before) */
  boardCut: "on" | "off";
  /** being judged (the same ask): the chips heroes' top bar with Markets, Index, Docs and a quiet Open app, or before */
  navLinks: "docs" | "before";
  /** being judged (Oct 9): the field's words low on the left, up top
   *  on the left, or up top centred */
  heroWords: "low" | "top" | "center";
  /** being judged (Oct 9): the top bar split to the edges (before),
   *  its links on the centre line, or a floating capsule */
  navShape: "split" | "center" | "pill";
  /** being judged (Oct 9):
   *  the chips heroes' buttons and top bar square (the app's 2 px corner) or round (before) */
  corners: "square" | "round";
  /** being judged (Oct 9): the landing opens on a loading screen where a chip-shaped sheet folds into the A, then the
   *  hero's film plays from its cell; or no loading screen, the cell breathing while it loads (before) */
  intro: "fold" | "cell";
  /** being judged (Oct 9): once the film settles, the
   *  field's chart keeps trading (a day closes every few seconds, the board glides a column left, a new day comes in
   *  at the right edge), or it stays still (before) */
  chartMotion: "live" | "still";
  /** being judged (Oct 10): the hero's words
   *  settle in one after another on a long soft ease-out with a blur that clears, or arrive all at once (before) */
  textIn: "settle" | "quick";
  /** being judged (Oct 10): the landing's close as type only, in the page's grid, the rendered server
   *  aisle under the words, or the H100 at rest (before) */
  closeArt: "type" | "aisle" | "chip";
  /** being judged (Oct 9): below the chips hero, one pinned story told in
   *  zooms (into a chip, the H100, the clouds' prices, the jump, the sides, every day, your AI, back out), or nothing
   *  below the hero (before). Oct 10: "site", the chip dive kept, then a market page in the order
   *  of Public's prediction markets page (the turn, what makes Agate different, your AI, five clouds one price, paid
   *  every day, build on the price, questions, the close) */
  story: "site" | "on" | "off";
  /** the site's turn (Oct 10): its line beside the H100 as the dive lets go (AirPods), or under it (iPhone) */
  turnAt: "beside" | "under";
  /** the site's AI section (Oct 10): three tabs under a wide panel (Public), or the card held while three blocks scroll
   *  past (Ledger) */
  aiUi: "tabs" | "held";
  /** the site's paid-every-day piece (Oct 10): ruled rows in a dark card, or the month as a grid */
  payUi: "rows" | "grid";
  /** the site's pages (docs, privacy) under the landing's own bar, as a full-width bar or its floating capsule, or
   *  under the app's bar (before) */
  siteNav: "bar" | "pill" | "before";
  /** the docs' contents page opening on four ways in (the app, an AI, the price, building on it) in the site's panel
   *  grid, or the plain contents (before) */
  docsHome: "ways" | "before";
}

/** The heroes being judged (Oct 8: of the ten styles 6 and 9 were kept, then animation related to gpu or
 *  compute"), in the order the dock, its arrows and the number keys show them. Earlier rounds left the dock. */
export const LANDINGS = [
  ["chipsfield", "Field: the whole hero a board of chips, the chart the ones that are on"],
  ["chipsheet", "Sheet: Direction 3's ruled sheet, its windows onto the chip board and chart"],
  ["chipsland", "Landscape: the chart fills the hero, older days faded, a floor"],
  ["chipshorizon", "Horizon: the headline up top, the chart a band below"],
  ["chips", "The opening v2: real chips slide into a candlestick chart"],
  ["chipsmono", "The opening v2: the first chips, one ink"],
  ["open", "The opening: a cell, its die, a wafer that is the chart"],
  ["hourlow", "Direction 1: one cell to the whole die, real chip colours"],
  ["hourlight", "Direction 1: the same on a light page"],
  ["clean", "Direction 2: one clean line, white"],
  ["bands", "Direction 3: agate bands, abstract"],
  ["loom", "Direction 3, new: the loom, price woven into cloth"],
  ["plot", "Direction 3, new: the chip's layout plot, an engineering drawing"],
  ["signals", "Direction 3, new: signals, a GPU on a logic analyzer"],
  ["hour", "Direction 1 with the headline in the middle"],
  ["answer", "A question becoming an answer"],
  ["dial", "The hour as the product: 3,600 seconds, then a month of hours"],
  ["wafer", "The wafer, split light"],
  ["chip", "The chip, warmed by the market"],
  ["hours", "Every GPU-hour, night blue (your 9)"],
  ["line", "One line, pure white (your 6)"],
] as const;
export type Landing = (typeof LANDINGS)[number][0];

/** The cookie that keeps the picked theme across reloads (written by the store, read by the pages: savedTheme.ts). */
export const THEME_COOKIE = "agate-theme";

export const MOMENTS = ["oct", "nov3", "nov13", "nov30", "dec1gap", "dec1final"] as const;
export type Moment = (typeof MOMENTS)[number];

export const SIGNIN_OUTCOMES = ["auto", "new", "returning", "wrong", "expired", "walletfail", "dripfail", "slow"] as const;
export type SignInOutcome = (typeof SIGNIN_OUTCOMES)[number];
export const AIS_SCENARIOS = ["none", "one", "two", "ended"] as const;
export type AisScenario = (typeof AIS_SCENARIOS)[number];
export const CONNECT_OUTCOMES = ["normal", "notyet", "fundfail", "refused", "expired", "offline"] as const;
export type ConnectOutcome = (typeof CONNECT_OUTCOMES)[number];
export const DISCONNECT_OUTCOMES = ["normal", "stopfail", "takebackfail"] as const;
export type DisconnectOutcome = (typeof DISCONNECT_OUTCOMES)[number];

/** Mock controls (the side panel and the states it sets): off in every build while the current look is locked, so a
 *  dev build shows exactly what the hosted one shows. NEXT_PUBLIC_MOCK_CONTROLS=on brings them back; Next inlines it at
 *  build time. */
const flag = process.env.NEXT_PUBLIC_MOCK_CONTROLS;
export const MOCK_CONTROLS = flag === "on";

// source: example data by default while the live empty states are reviewed (flip to "live" once November lists);
// a build without Mock controls is always live, so its links never carry ?source. pbar: filled, the research
// pick (Oct 4: every persistent trade bar measured is filled; tint keeps meaning "picked side" inside the ticket)
export const DEFAULT_CONFIG: MockConfig = { dfill: "deep", mode: "simple", theme: "light", auth: "out", data: "normal", gpu: "H100", source: MOCK_CONTROLS ? "example" : "live", dock: "closed", phone: "new", pbar: "fill", signin: "auto", ais: "none", connect: "normal", disc: "normal", when: "oct", holds: "none", months: "one", closeUi: "tabs", candles: "auto", positionsUi: "market", indexUi: "market", landing: "chipsfield", logo: "fold", wicks: "off", chipColor: "mono", oldDays: "full", boardCut: "off", navLinks: "docs", heroWords: "center", navShape: "center", corners: "square", intro: "cell", chartMotion: "live", textIn: "settle", closeArt: "type", story: "site", turnAt: "beside", aiUi: "tabs", payUi: "rows", siteNav: "bar", docsHome: "ways" };

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
    when: pick("when", MOMENTS, DEFAULT_CONFIG.when),
    holds: pick("holds", ["none", "nov"] as const, DEFAULT_CONFIG.holds),
    months: pick("months", ["one", "both"] as const, DEFAULT_CONFIG.months),
    closeUi: pick("closeUi", ["tabs", "before"] as const, DEFAULT_CONFIG.closeUi),
    candles: pick("candles", ["auto", "before"] as const, DEFAULT_CONFIG.candles),
    positionsUi: pick("positionsUi", ["market", "new", "before"] as const, DEFAULT_CONFIG.positionsUi),
    indexUi: pick("indexUi", ["market", "new", "before"] as const, DEFAULT_CONFIG.indexUi),
    landing: pick("landing", LANDINGS.map(([k]) => k), DEFAULT_CONFIG.landing),
    logo: pick("logo", ["fold", "foldlace", "lace", "onyx", "stone"] as const, DEFAULT_CONFIG.logo),
    wicks: pick("wicks", ["off", "on"] as const, DEFAULT_CONFIG.wicks),
    chipColor: pick("chipColor", ["silicon", "mono", "ink"] as const, DEFAULT_CONFIG.chipColor),
    oldDays: pick("oldDays", ["faded", "full"] as const, DEFAULT_CONFIG.oldDays),
    boardCut: pick("boardCut", ["on", "off"] as const, DEFAULT_CONFIG.boardCut),
    navLinks: pick("navLinks", ["docs", "before"] as const, DEFAULT_CONFIG.navLinks),
    heroWords: pick("heroWords", ["low", "top", "center"] as const, DEFAULT_CONFIG.heroWords),
    navShape: pick("navShape", ["split", "center", "pill"] as const, DEFAULT_CONFIG.navShape),
    corners: pick("corners", ["square", "round"] as const, DEFAULT_CONFIG.corners),
    intro: pick("intro", ["fold", "cell"] as const, DEFAULT_CONFIG.intro),
    chartMotion: pick("chartMotion", ["live", "still"] as const, DEFAULT_CONFIG.chartMotion),
    textIn: pick("textIn", ["settle", "quick"] as const, DEFAULT_CONFIG.textIn),
    closeArt: pick("closeArt", ["type", "aisle", "chip"] as const, DEFAULT_CONFIG.closeArt),
    story: pick("story", ["site", "on", "off"] as const, DEFAULT_CONFIG.story),
    turnAt: pick("turnAt", ["beside", "under"] as const, DEFAULT_CONFIG.turnAt),
    aiUi: pick("aiUi", ["tabs", "held"] as const, DEFAULT_CONFIG.aiUi),
    payUi: pick("payUi", ["rows", "grid"] as const, DEFAULT_CONFIG.payUi),
    siteNav: pick("siteNav", ["bar", "pill", "before"] as const, DEFAULT_CONFIG.siteNav),
    docsHome: pick("docsHome", ["ways", "before"] as const, DEFAULT_CONFIG.docsHome),
  };
  // a build without the controls (a hosted one) shows live data only: example numbers can never reach it from a link
  if (!MOCK_CONTROLS) all.source = "live";
  // without the controls, options being judged stay at their default and the made-up data states and the panel
  // cannot be opened from a link
  const D = DEFAULT_CONFIG;
  // a hosted build shows the picks: the Oct 7 market-frame Positions and Index, Close in the trade panel and candles
  // that follow the range (judged Oct 10), the Oct 9 logo and the landing's opening, so it shows one mark: the same in
  // the top bar and in the loader
  return MOCK_CONTROLS
    ? all
    : { ...all, dfill: D.dfill, data: D.data, dock: D.dock, phone: D.phone, pbar: D.pbar, signin: D.signin, ais: D.ais, connect: D.connect, disc: D.disc, when: D.when, holds: D.holds, months: D.months, closeUi: D.closeUi, candles: D.candles, positionsUi: D.positionsUi, indexUi: D.indexUi, logo: D.logo, intro: D.intro, landing: D.landing, wicks: D.wicks, chipColor: D.chipColor, oldDays: D.oldDays, boardCut: D.boardCut, navLinks: D.navLinks, heroWords: D.heroWords, navShape: D.navShape, corners: D.corners, chartMotion: D.chartMotion, textIn: D.textIn, closeArt: D.closeArt, story: D.story, turnAt: D.turnAt, aiUi: D.aiUi, payUi: D.payUi, siteNav: D.siteNav, docsHome: D.docsHome };
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
