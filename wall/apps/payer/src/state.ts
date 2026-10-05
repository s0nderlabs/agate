// BOTS-SPEC 4.6: the payer's persisted state (state.json, written atomically after every receipt): lastClaimK and
// sweepDone per series, the ids skipped after a bisection (until a later PayoutChanged), and the lister's never-list
// set, its retry times, the sends its budget bounds again (Oct 5) and the info alerts it raised once. It carries the
// scan identity (chain id, start block, factory set: audit P-M3): a state of another chain or deployment is set aside
// and the payer starts fresh (every action is idempotent by chain state), so a fork rehearsal's lastClaimK or
// sweepDone never hides a real series.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "@agate/watcher";
import { identityMismatch, type ScanIdentity } from "@agate/market";

export interface SeriesMark {
  lastClaimK: number;
  sweepDone: boolean;
}

export interface PayerStateData {
  version: 1;
  series: Record<string, SeriesMark>;
  /** "<series>:<id>" -> the scan key from which a PayoutChanged clears it */
  badIds: Record<string, string>;
  /** "<factory>:<gpuId>:<month>" (lowercase): IndexStartsAfterMonth, never listed */
  neverList: string[];
  /** list key -> chain time of the next try after LISTER_REFUSED */
  retryAt: Record<string, number>;
  /** series -> chain time of the next createMarket try after LISTER_MARKET_REFUSED */
  marketRetryAt: Record<string, number>;
  /** (Oct 5) list keys and series whose lister send reverted onchain: their retries are the day's budget's, not
   *  safety sends, until the slot fills; absent in an older file (empty) */
  budgetBound: string[];
  /** what this state belongs to (P-M3); absent in an older file (adopted) */
  identity?: ScanIdentity;
}

export function emptyState(): PayerStateData {
  return { version: 1, series: {}, badIds: {}, neverList: [], retryAt: {}, marketRetryAt: {}, budgetBound: [] };
}

export class StateStore {
  data: PayerStateData;
  readonly path: string;
  /** why a foreign state was set aside at start (null: it was not) */
  readonly resetWhy: string | null = null;
  private readonly dir: string;

  constructor(dir: string, identity?: ScanIdentity) {
    this.dir = dir;
    this.path = join(dir, "state.json");
    this.data = emptyState();
    if (existsSync(this.path)) {
      try {
        const j = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PayerStateData>;
        const bad = identity && j.identity ? identityMismatch(identity, j.identity) : null;
        if (bad !== null) {
          renameSync(this.path, join(dir, `state.stale-${Date.now()}.json`));
          this.resetWhy = `state.json belongs to another chain or deployment (${bad} differ)`;
        } else this.data = { ...emptyState(), ...j, version: 1 };
      } catch {
        // unreadable: start empty; every action is idempotent by chain state (4.6)
        this.data = emptyState();
      }
    }
    if (identity) this.data.identity = identity;
  }

  /** The scan started over while running (the chain was reset under the cursor, review finding of Oct 3): every mark
   *  belonged to the old chain, so it is set aside like a foreign state at start and the payer starts fresh (every
   *  action is idempotent by chain state). */
  reset(): void {
    if (existsSync(this.path)) renameSync(this.path, join(this.dir, `state.stale-${Date.now()}.json`));
    const identity = this.data.identity;
    this.data = emptyState();
    if (identity) this.data.identity = identity;
    this.save();
  }

  mark(series: string): SeriesMark {
    const k = series.toLowerCase();
    let m = this.data.series[k];
    if (!m) {
      m = { lastClaimK: 0, sweepDone: false };
      this.data.series[k] = m;
    }
    return m;
  }

  isBad(series: string, id: bigint): boolean {
    return this.data.badIds[`${series.toLowerCase()}:${id}`] !== undefined;
  }

  setBad(series: string, id: bigint, fromKey: string): void {
    this.data.badIds[`${series.toLowerCase()}:${id}`] = fromKey;
  }

  /** A PayoutChanged at `key` clears a bad id marked at or before it. */
  payoutChanged(series: string, id: bigint, key: string): void {
    const k = `${series.toLowerCase()}:${id}`;
    const from = this.data.badIds[k];
    if (from !== undefined && key >= from) delete this.data.badIds[k];
  }

  save(): void {
    writeAtomic(this.path, JSON.stringify(this.data, null, 1));
  }
}
