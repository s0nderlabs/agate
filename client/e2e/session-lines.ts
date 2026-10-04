// Lines of the demo session's report (e2e/session-report.ts) that say what could not be read: a read that failed is
// said in words, never as a count (-1 read as a number of slices), and with --no-indexer the indexer is "not used",
// not a URL that "does not answer".

/** The slices one writer posted per GPU for a day: "4 each" when every GPU agrees, else one per GPU in turn; a read
 *  that failed (null) is "read failed". */
export function slicesText(s: (number | null)[]): string {
  if (s.length > 0 && s.every((x) => x === s[0])) return s[0] === null ? "read failed" : `${s[0]} each`;
  return s.map((x) => (x === null ? "(read failed)" : String(x))).join(" ");
}

/** The indexer's line: not used (--no-indexer: url null), answering up to a block, or not answering. */
export function indexerText(url: string | null, up: boolean, processed: bigint | null, head: bigint): string {
  if (url === null) return "indexer not used (--no-indexer)";
  if (!up) return `indexer ${url}: does not answer`;
  return `indexer ${url}: answers, processed block ${processed ?? "?"} (${processed !== null ? head - processed : "?"} behind)`;
}

/** Why the claims are not listed: they come from the indexer. */
export function claimsWithoutText(url: string | null, up: boolean): string {
  if (url === null) return "not read: the claims come from the indexer, not used here (--no-indexer); the payer's transaction count is under MON below";
  if (up) return "no listed series yet";
  return "not read: the indexer does not answer (the chain's logs come 100 blocks a call on the public RPC); the payer's transaction count is under MON below";
}
