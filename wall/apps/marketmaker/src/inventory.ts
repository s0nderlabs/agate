// BOTS-SPEC 3.4: inventory, funding plans and limits, pure. Token amounts in base units (U per token), dollars in u.
import { LOT, U } from "@agate/market";
import { cutAsks, cutBids, type Level, lockOf } from "./ladder.ts";

export interface Inventory {
  Tw: bigint; // token in the maker's wallet
  Tm: bigint; // token in Kuru's MarginAccount
  Tr: bigint; // token locked in the maker's active asks (remaining x 100)
  Sh: bigint; // the maker's fungible short balance in the series
}

export function owned(i: Inventory): bigint {
  return i.Tw + i.Tm + i.Tr;
}

/** E = T - Sh: net exposure; a pair is worth C whatever happens. */
export function exposure(i: Inventory): bigint {
  return owned(i) - i.Sh;
}

const units = (base: bigint) => base / LOT;

export interface TokenPlan {
  mintQ: bigint; // pairs to mint, base units (whole tokens)
  mintCost: bigint; // u, ceil(q * C / U)
  depositT: bigint; // tokens to deposit into the MarginAccount, base units
  asks: Level[]; // the target asks, cut to what the maker has or may mint
  capped: boolean; // the pairs cap or the wallet's dollars cut the asks
}

/** Tokens for the target asks: a batch cancels before it adds, so the current asks' locks (Tr) come back first.
 *  needT = sum of ask units x 100; haveT = Tm + Tr; deposit needT - haveT from the wallet, minting the shortfall in
 *  whole tokens (capped by maxPairs - Sh and by the dollars the wallet can spend on it). */
export function planTokens(asks: readonly Level[], inv: Inventory, o: { cap: bigint; maxPairsBase: bigint; walletDollars: bigint }): TokenPlan {
  const needT = asks.reduce((s, a) => s + a.size, 0n) * LOT;
  const haveT = inv.Tm + inv.Tr;
  if (needT <= haveT) return { mintQ: 0n, mintCost: 0n, depositT: 0n, asks: [...asks], capped: false };
  const deficit = needT - haveT;
  const fromWallet = inv.Tw < deficit ? inv.Tw : deficit;
  const short = deficit - fromWallet;
  let mintQ = 0n;
  let capped = false;
  if (short > 0n) {
    mintQ = ((short + U - 1n) / U) * U;
    const room = inv.Sh >= o.maxPairsBase ? 0n : ((o.maxPairsBase - inv.Sh) / U) * U;
    if (mintQ > room) {
      mintQ = room;
      capped = true;
    }
    const affordable = ((o.walletDollars * U) / o.cap / U) * U;
    if (mintQ > affordable) {
      mintQ = affordable;
      capped = true;
    }
  }
  const mintCost = (mintQ * o.cap + U - 1n) / U;
  const avail = haveT + fromWallet + mintQ;
  const depositT = (fromWallet + mintQ < deficit ? fromWallet + mintQ : deficit);
  const out = avail >= needT ? [...asks] : cutAsks(asks, units(avail));
  return { mintQ, mintCost, depositT, asks: out, capped: capped && avail < needT };
}

export interface DollarBook {
  market: string;
  bids: Level[]; // target
  currentBidLock: bigint; // u locked by the book's current bids (they come back first)
}

export interface DollarPlan {
  deposit: bigint; // u, one deposit for every due book
  bids: Map<string, Level[]>; // per market, cut when the dollars do not reach
  short: boolean; // some bids were cut
}

/** One dollar deposit for every due book (the margin dollar is one pool). Each book's batch cancels its own bids
 *  before it adds, so it needs d = need - its current bid lock from the pool; books go one after another, so the
 *  plan counts only the positive d (a book that frees dollars may come after one that needs them):
 *  needD = sum of max(0, d), haveD = margin dollars; when short, deposit needD - haveD + buffer (as far as the wallet
 *  reaches after the mints); bids that still do not fit are cut from the outermost level, books in order. */
export function planDollars(books: readonly DollarBook[], o: { marginDollars: bigint; walletDollars: bigint; mintCosts: bigint; bufferU: bigint }): DollarPlan {
  const lock = (b: DollarBook) => b.bids.reduce((x, l) => x + lockOf(l), 0n);
  const needD = books.reduce((s, b) => {
    const d = lock(b) - b.currentBidLock;
    return d > 0n ? s + d : s;
  }, 0n);
  const haveD = o.marginDollars;
  const spendable = o.walletDollars > o.mintCosts ? o.walletDollars - o.mintCosts : 0n;
  let deposit = 0n;
  if (needD > haveD) {
    const want = needD - haveD + o.bufferU;
    deposit = want <= spendable ? want : spendable;
  }
  let left = haveD + deposit; // the pool before each book's batch, freed locks included as they come back
  const bids = new Map<string, Level[]>();
  let short = false;
  for (const b of books) {
    const room = left + b.currentBidLock;
    const need = lock(b);
    if (need <= room) {
      bids.set(b.market, b.bids);
      left = room - need;
    } else {
      const cut = cutBids(b.bids, room);
      short = true;
      bids.set(b.market, cut);
      left = room - cut.reduce((x, l) => x + lockOf(l), 0n);
    }
  }
  return { deposit, bids, short };
}

/** Pairs to redeem at wind-down or when dollars are low: min(Tw, Sh) floored to LOT. */
export function redeemable(Tw: bigint, Sh: bigint): bigint {
  const q = Tw < Sh ? Tw : Sh;
  return (q / LOT) * LOT;
}

/** The mark of one series (3.8): (T x fair + Sh x (C - fair)) / U. */
export function markSeries(T: bigint, Sh: bigint, fair: bigint, cap: bigint): bigint {
  return (T * fair + Sh * (cap - fair)) / U;
}
