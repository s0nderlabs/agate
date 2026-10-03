// The deterministic diagnosis (BUILD-SPEC 15.2), from HTTP status, body and parse results. Claude may add a reason,
// never overrule it.
import type { Line } from "@agate/pagecheck";
import type { Diagnosis, Incident } from "./incidents.ts";

export const BLOCKED_STATUS = new Set([401, 403, 429, 503]);
export const REDIRECT_STATUS = new Set([301, 302, 307, 308]);
export const GONE_STATUS = new Set([404, 410]);

/** A bot wall: a challenge page, or a small page saying access is denied or asking for a captcha (a big pricing page
 *  may carry a captcha script for its contact form, so the generic words count only on small bodies). */
export function looksLikeBotWall(body: string): boolean {
  const b = body.toLowerCase();
  if (/cf-chl|challenge-platform|cf_chl_opt|<title>\s*just a moment\.\.\.\s*<\/title>|attention required! \| cloudflare/.test(b)) return true;
  if (body.length > 30_000) return false;
  return /captcha|access denied|are you a robot|verify you are human|ddos protection by|enable javascript and cookies to continue|request unsuccessful\. incapsula/.test(b);
}

export interface DiagnoseInput {
  incident: Pick<Incident, "kind" | "sourceId">;
  /** the newest attempted line of the source */
  last: Line | undefined;
  /** the newest served page's text, when saved */
  lastBody: string | null;
  lastSha: string | null;
  /** sha256 of every page the reader in force parsed VALID on every GPU */
  validShas: ReadonlySet<string>;
  /** trackers still listing fresh rows for that cloud (for "blocked") */
  support: string[];
}

export function diagnose(x: DiagnoseInput): Diagnosis {
  const { incident, last } = x;
  if (incident.kind === "sold_out") return { kind: "sold_out", why: "the page is served and the rows are found, shown not rentable on every GPU: nothing to do (a held slot is the formula's job)" };
  if (incident.kind === "wrong_cell") return { kind: "wrong_cell", why: "the reader in force reads VALID but off the trackers by more than 10% for a day (PAGECHECK_FAULT)" };
  const http = last?.httpStatus ?? 0;
  const location = last?.location;
  if (BLOCKED_STATUS.has(http)) return withSupport({ kind: "blocked", why: `HTTP ${http}: reroute the fetch (R4, R4b); a reader swap does not help` }, x.support);
  if (REDIRECT_STATUS.has(http)) return location ? { kind: "moved", why: `HTTP ${http} to another URL`, location } : { kind: "moved", why: `HTTP ${http} with no Location recorded` };
  if (GONE_STATUS.has(http)) return { kind: "moved", why: `HTTP ${http}: the page is gone from its URL` };
  if (incident.kind === "fetch") return { kind: "unsure", why: `the page did not answer (${http ? `HTTP ${http}` : "no response"}) for 6 intervals: check the fetch; a reader swap does not help` };
  if (x.lastBody !== null && looksLikeBotWall(x.lastBody)) return withSupport({ kind: "blocked", why: "the page served is a bot wall: reroute the fetch (R4, R4b); a reader swap does not help" }, x.support);
  if (x.lastSha && x.validShas.has(x.lastSha)) return { kind: "unsure", why: "the page is byte-identical to one the reader in force read VALID; the change is in the reading, not the page: check the reader and its context" };
  // the watcher follows redirects and records the final URL as `location` when it differs from the URL it asked for
  if (location) return { kind: "moved", why: `the page redirected to another URL (HTTP ${http} there)`, location };
  return { kind: "redesign", why: "HTTP 2xx, the reader in force gives NO_ROW or BAD_VALUE, and the page differs from every page it read VALID" };
}

function withSupport(d: Diagnosis, support: string[]): Diagnosis {
  return support.length > 0 ? { ...d, support } : d;
}
