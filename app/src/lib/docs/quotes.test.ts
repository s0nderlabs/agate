// Every sentence the docs quote as the code's own words is still in the code: the error tables (17-errors.md with the
// SDK's reasons, the developer API's in 08-api.md) and the server's instructions (11-mcp-tools.md) say "exact" and "word for word", so a
// wording change in the source without the docs fails here. Each entry is a docs file, a string the docs show, and
// the source that must contain it; quotes with placeholders (<gpu>, <when>) list the pieces between them.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Lexer } from "marked";
import { WRITE_REASONS } from "../account/errors";
import { parseFrontmatter, plainText } from "./markdown";
import { tidy } from "./search";
import { DOCS_PATH } from "./types";

const ROOT = path.join(import.meta.dir, "..", "..", "..", "..");

type Quote = { doc: string; text: string; source: string; inSource?: string };

const group = (doc: string, source: string, texts: readonly string[]): Quote[] => texts.map((text) => ({ doc, text, source }));
const page = (file: string) => `${DOCS_PATH}/${file}`;

const QUOTES: Quote[] = [
  ...group(page("08-api.md"), "server/src/developer.ts", ["gpu must be one of", "month is YYYY-MM, for example 2026-11", "market on sale (see /v1/markets)", "price yet", "requests a minute; wait a minute", "the markets could not be read right now; try again shortly", "trades could not be read right now; try again shortly", "candles could not be read right now; try again shortly", "no such endpoint: ", "(see /v1 for the list)"]),
  // backup codes: the sign-in sheet's own lines (app/src/components/flow/SignInSheet.tsx, account/errors.ts)
  ...group(page("17-errors.md"), "app/src/components/flow/SignInSheet.tsx", ["That isn't a backup code. They look like K7QD-9XMP: 8 letters and numbers."]),
  ...group(page("17-errors.md"), "app/src/lib/account/errors.ts", ["No new passkey was made, so your code still works."]),
  ...group(page("17-errors.md"), "server/src/mcp/routes.ts", ["missing credential", "invalid or expired access token", "unknown connection", "this AI connection was disconnected: connect it again from Agate", "method not allowed", "payload too large", "rate limit exceeded for this connection", "too many requests"]),
  ...group(page("17-errors.md"), "server/src/mcp/server.ts", ["budget_left", "not_enough_tokens", "price_moved", "thin_book", "above_band", "below_band", "drip_too_soon", "empty_book", "bad_amount", "sponsor_limit", "no_market", "parts_too_small", "bad_input", "not_found", "grant_revoked", "grant_expired"]),
  ...group(page("17-errors.md"), "wallet/src/allowed.ts", ["over_per_trade_cap", "payee_must_be_you", "approve_router_only", "no_native_value", "not_allowed_contract", "not_allowed_function"]),
  ...group(page("17-errors.md"), "client/src", ["has no Kuru market yet", "no positions given", "the size is too small for that many parts", "is not listed", "is price only: ", "must be a decimal string or a bigint, never a number", "is not a plain decimal like 12.34", "decimals", "must be a multiple of 0.0001 GPU-hour", "must be a positive multiple of $0.01"]),
  ...group(page("17-errors.md"), "server/src/grants.ts", ["trades used in the last 24 hours", "daily_limit", "the per-trade cap must be above 0 and at most the budget", "trades per day: 1 to", "the end date must be within", "the Assistant is not delegated to agate yet (try again in a few seconds)", "pocket_in_use: this pocket already serves", "the signed permission does not match: "]),
  ...group(page("17-errors.md"), "app/src/lib/account/errors.ts", [
    "That code doesn't match. Check the newest email from Agate and try again.",
    "test dollars arrive",
    "Agate couldn't pay the network fee this time. Nothing was sent. Try again in a minute.",
    "It now fills",
    "can still pay, the book holds",
    "At these prices this trade can only lose: the asks are above what",
    "At these prices this trade can only lose: the bids are below the least",
    "This trade needs more test dollars than your account holds. Nothing was sent.",
    "settles once every day is final. Nothing was sent.",
    "No passkey was made.",
    "This device already has a passkey for Agate. Sign in with it.",
    "This passkey is from the older sign-in, where a passkey was added to an email or Google account.",
    "That took too long. Try again.",
    "Too many tries from this network. Wait a minute, then try again.",
    "Too many new accounts from this network. Try again in an hour.",
    "New passkey accounts are paused for today. Use Google or your email instead.",
    "Agate couldn't accept that passkey. Try again.",
    "Your passkey worked, but sign-in didn't finish. Try again.",
    "That code doesn't work. Check it, or try another of your backup codes.",
    "Agate can't be reached right now. Try again in a moment.",
    "This browser can't use passkeys. Use Google or your email instead.",
    "Your passkey didn't confirm it. Try again, or Cancel.",
    "Your passkey worked, but it didn't finish. Try again.",
  ]),
  // also a piece of an older, longer message: pinned to its own string literal
  { doc: page("17-errors.md"), text: "No passkey signed you in.", source: "app/src/lib/account/errors.ts", inSource: '"No passkey signed you in."' },
  // the passkey choices the errors page names, as the sign-in sheet labels them
  ...group(page("17-errors.md"), "app/src/components/flow/SignInSheet.tsx", ["Try again or use my phone", "Make a new passkey", "Use your email instead", "I already have a passkey", "Sign in with it"]),
  // every reason the SDK throws is in the errors page's SDK table; in the source each is a string literal
  ...WRITE_REASONS.map((text) => ({ doc: page("17-errors.md"), text, source: "client/src", inSource: `"${text}"` })),
  ...group(page("11-mcp-tools.md"), "server/src/mcp/server.ts", [
    "agate makes the price of GPU compute tradable: a daily index of GPU-hour rental prices (H100, H200, B200 and more) and monthly tokens that pay that month's average price.",
    "Refusals name the rule (over_per_trade_cap, budget_left, daily_limit, grant_expired, price_moved, ...): read them before retrying.",
  ]),
  // the check-day report the price page shows, in the script's own words
  ...group(page("04-the-price.md"), "client/scripts/check-day.ts", ["company", "readings day price counted", "yes, at its day price", "yes, at its last good day price", "Median of the", "counted: ", "MATCH (", "price, status, counts and the record's digest", "for the held prices: ", "each matches its record"]),
];

/** A docs page as the site renders its words (no frontmatter, no markdown), and a source file or folder of .ts
 *  files with its white space collapsed; each read once. */
const docs = new Map<string, string>();
const sources = new Map<string, string>();
const docText = (rel: string) => {
  let t = docs.get(rel);
  if (t === undefined) docs.set(rel, (t = plainText(new Lexer({ gfm: true }).lex(parseFrontmatter(fs.readFileSync(path.join(ROOT, rel), "utf8")).body))));
  return t;
};
const sourceText = (rel: string) => {
  let t = sources.get(rel);
  if (t === undefined) {
    const full = path.join(ROOT, rel);
    const files = fs.statSync(full).isDirectory() ? fs.readdirSync(full).filter((f) => f.endsWith(".ts")).map((f) => path.join(full, f)) : [full];
    sources.set(rel, (t = tidy(files.map((f) => fs.readFileSync(f, "utf8")).join("\n"))));
  }
  return t;
};

describe("the docs quote the code's own words", () => {
  for (const q of QUOTES) {
    test(`${path.basename(q.doc)}: ${q.text.slice(0, 60)}`, () => {
      expect(docText(q.doc).includes(q.text)).toBe(true);
      expect(sourceText(q.source).includes(q.inSource ?? q.text)).toBe(true);
    });
  }
});
