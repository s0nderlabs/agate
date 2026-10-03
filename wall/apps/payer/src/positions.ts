// BOTS-SPEC 4.1: series and positions rebuilt from the scanner's events (and updated at once from our own receipts).
// PositionOpened creates {id, owner, payee, side, q, paid = paidNow, daily, open}; Claimed sets paid = paidTotal (paid
// only grows, so a stale event never lowers it); PayoutChanged sets payee and daily; PositionClosed sets open = false.
import { type Address, decodeEventLog, type Hex, type Log } from "viem";
import { agateSeriesAbi, type FactoryEntry, type ScanEvent, type Side } from "@agate/market";

export interface SeriesInfo {
  series: Address; // lowercase
  factory: Address; // lowercase
  factoryName: string;
  index: Address;
  gpuId: Hex;
  month: number;
  token: Address;
  startDay: number;
  n: number;
  startTs: bigint;
  day: number;
  lastResort: bigint;
  floor: bigint;
  cap: bigint;
  symbol: string;
}

export interface Pos {
  id: bigint;
  owner: Address;
  payee: Address;
  side: Side;
  q: bigint;
  paid: bigint;
  daily: boolean;
  open: boolean;
}

export class Positions {
  readonly series = new Map<string, SeriesInfo>();
  private readonly pos = new Map<string, Map<string, Pos>>();
  private applied = 0;
  private readonly byFactory: Map<string, FactoryEntry>;
  /** called for each PayoutChanged applied (series lowercase, id, event key): clears a bad id */
  onPayoutChanged?: (series: string, id: bigint, key: string) => void;

  constructor(factories: readonly FactoryEntry[]) {
    this.byFactory = new Map(factories.map((f) => [f.factory.toLowerCase(), f]));
  }

  /** Forgets every series and position (the scan started over: its event list is a new one, from index 0). */
  reset(): void {
    this.series.clear();
    this.pos.clear();
    this.applied = 0;
  }

  /** Applies the events not applied yet (the scanner's list only grows between resets). Returns how many were applied. */
  apply(events: readonly ScanEvent[]): number {
    let n = 0;
    for (; this.applied < events.length; this.applied++) {
      this.one(events[this.applied]!);
      n++;
    }
    return n;
  }

  private one(e: ScanEvent): void {
    switch (e.name) {
      case "SeriesListed": {
        const f = this.byFactory.get(e.address);
        if (!f) return;
        const s = e.series.toLowerCase();
        this.series.set(s, { series: s as Address, factory: e.address, factoryName: f.name, index: f.index, gpuId: e.gpuId, month: e.month, token: e.token, startDay: e.startDay, n: e.n, startTs: e.startTs, day: e.day, lastResort: e.lastResort, floor: e.floor, cap: e.cap, symbol: e.symbol });
        if (!this.pos.has(s)) this.pos.set(s, new Map());
        return;
      }
      case "PositionOpened": {
        const m = this.pos.get(e.address);
        if (!m) return;
        m.set(e.id.toString(), { id: e.id, owner: e.owner, payee: e.payee, side: (e.side === 1 ? 1 : 0) as Side, q: e.q, paid: e.paidNow, daily: e.daily, open: true });
        return;
      }
      case "Claimed":
        this.setPaid(e.address, e.id, e.paidTotal);
        return;
      case "PayoutChanged": {
        const p = this.pos.get(e.address)?.get(e.id.toString());
        if (p) {
          p.payee = e.payee;
          p.daily = e.daily;
        }
        this.onPayoutChanged?.(e.address, e.id, e.key);
        return;
      }
      case "PositionClosed":
        this.close(e.address, e.id);
        return;
      default:
        return;
    }
  }

  setPaid(series: string, id: bigint, paidTotal: bigint): void {
    const p = this.pos.get(series.toLowerCase())?.get(id.toString());
    if (p && paidTotal > p.paid) p.paid = paidTotal;
  }

  close(series: string, id: bigint): void {
    const p = this.pos.get(series.toLowerCase())?.get(id.toString());
    if (p) p.open = false;
  }

  /** Overwrites a position from a fresh view (null: it no longer exists). */
  refresh(series: string, id: bigint, v: { paid: bigint; payee: Address; daily: boolean } | null): void {
    const p = this.pos.get(series.toLowerCase())?.get(id.toString());
    if (!p) return;
    if (v === null) p.open = false;
    else {
      if (v.paid > p.paid) p.paid = v.paid;
      p.payee = v.payee;
      p.daily = v.daily;
    }
  }

  get(series: string, id: bigint): Pos | undefined {
    return this.pos.get(series.toLowerCase())?.get(id.toString());
  }

  open(series: string): Pos[] {
    return [...(this.pos.get(series.toLowerCase())?.values() ?? [])].filter((p) => p.open);
  }

  /** Series with at least one open position. */
  withOpen(): SeriesInfo[] {
    return [...this.series.values()].filter((s) => this.open(s.series).length > 0);
  }

  /** Our own claimMany's receipt: Claimed raises paid, PositionClosed closes (the scanner sees both again later). */
  applyReceipt(series: Address, logs: readonly Log[]): { claimed: number; closed: number; paidU: bigint } {
    let claimed = 0;
    let closed = 0;
    let paidU = 0n;
    for (const l of logs) {
      if (l.address.toLowerCase() !== series.toLowerCase()) continue;
      try {
        const d = decodeEventLog({ abi: agateSeriesAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: Record<string, unknown> };
        if (d.eventName === "Claimed") {
          this.setPaid(series, d.args.id as bigint, d.args.paidTotal as bigint);
          paidU += d.args.amount as bigint;
          claimed++;
        } else if (d.eventName === "PositionClosed") {
          this.close(series, d.args.id as bigint);
          closed++;
        }
      } catch {
        // another event of the series
      }
    }
    return { claimed, closed, paidU };
  }
}
