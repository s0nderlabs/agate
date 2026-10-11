// The sums behind the explaining pictures (components/explain/figures): one trade of 100 GPU-hours on one month,
// worked to the dollar, kept pure so the pictures and their tests share them. A Long pays what buyers pay today and gets the month's average back at
// the end; a Short puts up the highest the average can count, takes what sellers get at once, and gets the highest
// minus the average at the end. The average only ever counts between the lowest and the highest, which is what lets
// every trade be paid in full up front and caps what anyone can lose at what they put in. Pay me daily pays the same
// amounts day by day instead of all at the end.
import { usd0 } from "@/lib/format";

/** The size every example is worked on. */
export const H = 100;

export type Side = "long" | "short";

/** One month's book: the lowest and highest its average can count, what buyers pay (ask), what sellers get (bid), and
 *  its days. */
export type Book = { floor: number; cap: number; ask: number; bid: number; days: number };

/** The clouds the example month was priced on (H100, Oct 8), cheapest first, shown while no live sources are read. */
export const EXAMPLE_CLOUDS: { name: string; price: number }[] = [
  { name: "Civo", price: 2.99 },
  { name: "Verda", price: 3.79 },
  { name: "Lambda", price: 3.99 },
  { name: "Nebius", price: 4.5 },
  { name: "CoreWeave", price: 6.16 },
];

const EPS = 1e-9;

/** the average as the month counts it: never under the lowest, never over the highest */
export const counted = (b: Book, a: number) => Math.min(b.cap, Math.max(b.floor, a));

/** what goes in, in whole dollars: a Long pays what buyers pay, a Short the highest less what it gets at once */
export const putIn = (b: Book, side: Side) => Math.round((side === "long" ? b.ask : b.cap - b.bid) * H);

/** what comes back at the end, in whole dollars */
export const back = (b: Book, side: Side, a: number) => Math.round((side === "long" ? counted(b, a) : b.cap - counted(b, a)) * H);

/** from the two rounded figures, so the receipt always adds up */
export const gain = (b: Book, side: Side, a: number) => back(b, side, a) - putIn(b, side);

/** where the play lands first: the first $0.50 mark at least 40 cents above what buyers pay (4.50 on the example) */
export const startAvg = (b: Book) => Math.min(b.cap, Math.ceil((b.ask + 0.4) / 0.5 - EPS) * 0.5);

/** Pay me daily on the same trade: a Long gets the lowest back at once, then each day its share above the lowest; a
 *  Short each day its share below the highest. Over the whole month it is what waiting pays. */
export function daily(b: Book, side: Side, a: number) {
  const long = side === "long";
  const c = counted(b, a);
  return {
    now: long ? Math.round(b.floor * H) : 0,
    perDay: ((long ? c - b.floor : b.cap - c) / b.days) * H,
    total: back(b, side, a),
  };
}

/** Closing early: the going price some days later, a round 40 cents or more your way, and what closing there keeps. */
export function later(b: Book, side: Side) {
  if (side === "long") {
    const at = startAvg(b);
    return { at, keep: Math.round((at - b.ask) * H) };
  }
  const at = Math.max(b.floor, Math.floor((b.bid - 0.4) / 0.5 + EPS) * 0.5);
  return { at, keep: Math.round((b.bid - at) * H) };
}

/** The middle of a set of prices: the one in the middle once sorted (or, with an even count, halfway between the two
 *  in the middle), and where it sits in the sorted order. */
export function middle(prices: number[]) {
  const s = [...prices].sort((x, y) => x - y);
  const n = s.length;
  if (!n) return { at: [] as number[], value: 0 };
  if (n % 2) return { at: [(n - 1) / 2], value: s[(n - 1) / 2] };
  return { at: [n / 2 - 1, n / 2], value: (s[n / 2 - 1] + s[n / 2]) / 2 };
}

/** whole dollars with a sign: "+$97", "−$53", "$0" */
export function signed0(n: number) {
  const r = Math.round(n);
  if (r > 0) return `+${usd0(r)}`;
  if (r < 0) return `−${usd0(-r)}`;
  return "$0";
}
