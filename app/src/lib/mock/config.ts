// Mock-controls state, shared by the server page (reads the URL) and the client provider. Only the app's own
// states live here (Simple/Pro, theme, GPU, sign-in, data states). A design option joins while it is being judged,
// then the verdict is baked in and the option removed (clean slate Oct 4; earlier rounds are in git, 724577e).
import type { DataState } from "./data";
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
  dock: "open" | "closed";
}

/** Mock controls (the side panel and the states it sets): on in `next dev`, off in a production build.
 *  NEXT_PUBLIC_MOCK_CONTROLS=on or =off overrides either way; Next inlines it at build time. */
const flag = process.env.NEXT_PUBLIC_MOCK_CONTROLS;
export const MOCK_CONTROLS = flag === "on" || (flag !== "off" && process.env.NODE_ENV !== "production");

export const DEFAULT_CONFIG: MockConfig = { dfill: "deep", mode: "simple", theme: "light", auth: "out", data: "live", gpu: "H100", dock: "closed" };

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
    data: pick("data", ["live", "loading", "degraded", "carried"] as const, DEFAULT_CONFIG.data),
    gpu: pick("gpu", ["H100", "H200", "B200"] as const, DEFAULT_CONFIG.gpu),
    dock: pick("dock", ["open", "closed"] as const, DEFAULT_CONFIG.dock),
  };
  // without the controls, options being judged stay at their default and the made-up data states and the panel
  // cannot be opened from a link
  const D = DEFAULT_CONFIG;
  return MOCK_CONTROLS ? all : { ...all, dfill: D.dfill, data: D.data, dock: D.dock };
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
