// Health (BUILD-SPEC 9.5, no key): every min(60 s, slice) check each role's heartbeat, the head lag against LAG_MAX,
// every role key's balance and the RPC URLs. Raises HEARTBEAT_LOST, R5_HEAD_LAG, KEY_LOW, RPC_DOWN and CLOCK_SKEW.
// KEY_LOW: a key under the 10 MON floor, or holding less than keyLowHours (24) of its own spend at the rate seen over
// the last max(1 h, DAY): six GPUs on the DEMO clock spend far more than 10 MON a day (wall spec 18.4).
import { existsSync, readFileSync } from "node:fs";
import type { Address, Hex } from "@agate/report/types";
import { AlertCode } from "@agate/report/types";
import type { AlertSink } from "./alerts.ts";
import type { IndexView } from "./chain/types.ts";
import type { RpcPool } from "./chain/rpc.ts";
import { dayEnd, type WallClock } from "./clock.ts";
import type { Heartbeat, HeartbeatBody } from "./fsutil.ts";

export interface RoleBeat {
  role: string;
  path: string;
  periodS: number;
}

export interface HealthDeps {
  view: IndexView;
  pool?: RpcPool;
  clock: WallClock;
  alerts: AlertSink;
  roles: RoleBeat[];
  gpuIds: Hex[];
  keys: { role: string; address: Address }[];
  minBalanceWei?: bigint;
  /** KEY_LOW when a key holds less than this many hours of its spend at the recent rate (AGATE_KEY_LOW_HOURS, 24) */
  keyLowHours?: number;
  heartbeat?: Heartbeat;
}

const MON = 10n ** 18n;
const monText = (w: bigint) => (w / MON).toLocaleString("en-US");
/** Tenths of a MON, floored: precise enough under the floor, coarse enough not to rewrite the alert every tick. */
const monTenths = (w: bigint) => `${w / MON}.${(w % MON) / (MON / 10n)}`;

/** One key's balances over a window: what it spent (a top-up is not spending) and over how many seconds. */
export class SpendWindow {
  private samples: { t: number; bal: bigint }[] = [];
  constructor(readonly windowS: number) {}

  /** Adds a sample; true when the balance rose since the last one (a top-up). A gap over maxGapS (a machine sleep, a
   *  stalled process) or a clock that went back starts the window over: the gap is not a time of zero spend. */
  add(t: number, bal: bigint, maxGapS = Infinity): boolean {
    const last = this.samples.at(-1);
    const toppedUp = last !== undefined && bal > last.bal;
    if (last && (t < last.t || t - last.t > maxGapS)) this.samples = [];
    this.samples.push({ t, bal });
    // keep one sample at or before t - windowS, so the span covers the whole window
    while (this.samples.length > 2 && this.samples[1]!.t <= t - this.windowS) this.samples.shift();
    return toppedUp;
  }

  spent(): { wei: bigint; spanS: number } {
    let wei = 0n;
    for (let i = 1; i < this.samples.length; i++) {
      const d = this.samples[i - 1]!.bal - this.samples[i]!.bal;
      if (d > 0n) wei += d;
    }
    return { wei, spanS: this.samples.length > 1 ? this.samples.at(-1)!.t - this.samples[0]!.t : 0 };
  }

  /** The balance `hours` of spend at the window's rate needs; null until half a window of samples is in. */
  need(hours: number): bigint | null {
    const { wei, spanS } = this.spent();
    if (spanS < this.windowS / 2) return null;
    return (wei * BigInt(Math.round(hours * 3_600))) / BigInt(spanS);
  }
}

export interface BeatStatus {
  role: string;
  age: number | null; // null: no heartbeat file
  lost: boolean;
  lastAction?: string;
}

export function readBeat(path: string): HeartbeatBody | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as HeartbeatBody) : null;
  } catch {
    return null;
  }
}

export function beatStatus(roles: RoleBeat[], now: number): BeatStatus[] {
  return roles.map((r) => {
    const b = readBeat(r.path);
    const age = b ? now - b.at : null;
    const s: BeatStatus = { role: r.role, age, lost: age === null || age > 3 * r.periodS };
    if (b) s.lastAction = b.lastAction;
    return s;
  });
}

export class Health {
  private skewTicks = 0;
  private readonly spend = new Map<string, SpendWindow>();
  constructor(readonly x: HealthDeps) {}

  async tick(now: number): Promise<void> {
    const c = this.x.clock;
    beatStatus(this.x.roles, now).forEach((s, slot) => {
      // one alert id per role: the role's index rides in the id's slot field, the role name in the message
      if (s.lost)
        this.x.alerts.raise({ code: AlertCode.HEARTBEAT_LOST, severity: "action", slot, message: `${s.role}: heartbeat ${s.age === null ? "missing" : `${s.age} s old`} (more than three tick periods)`, data: { role: s.role } });
      else this.x.alerts.clearWhere((a) => a.code === AlertCode.HEARTBEAT_LOST && a.slot === slot);
    });
    try {
      if (this.x.pool) await this.x.pool.tick(now);
      const chainNow = await this.x.view.blockTime();
      const skewMax = Math.max(5, c.slice / 20);
      this.skewTicks = Math.abs(chainNow - now) > skewMax ? this.skewTicks + 1 : 0;
      if (this.skewTicks >= 3) this.x.alerts.raise({ code: AlertCode.CLOCK_SKEW, severity: "action", message: `health: local clock ${now} vs chain head ${chainNow} (more than ${skewMax} s for 3 ticks)` });
      for (const g of this.x.gpuIds) {
        const head = await this.x.view.head(g);
        const r = await this.x.view.record(g, head - 1);
        const d0 = r.exists && !r.isFinal ? head - 1 : head;
        if (now >= dayEnd(c, d0) + c.day)
          this.x.alerts.raise({ code: AlertCode.R5_HEAD_LAG, severity: "action", gpuId: g, day: d0, deadline: dayEnd(c, d0) + c.lagMax, message: `day ${d0} has no final record ${now - dayEnd(c, d0)} s after it ended (LAG_MAX ${c.lagMax} s)` });
      }
      const floor = this.x.minBalanceWei ?? 10n * MON;
      const hours = this.x.keyLowHours ?? 24;
      for (const k of this.x.keys) {
        const bal = await this.x.view.balance(k.address);
        const key = k.address.toLowerCase();
        const win = this.spend.get(key) ?? new SpendWindow(Math.max(3_600, c.day));
        this.spend.set(key, win);
        const toppedUp = win.add(now, bal, 3 * Math.min(60, c.slice)); // three of health's ticks (main.ts)
        const need = win.need(hours);
        // whole MON in the message, so a falling balance does not rewrite the alert every tick
        if (bal < floor)
          this.x.alerts.raise({ code: AlertCode.KEY_LOW, severity: "action", writer: k.address, message: `${k.role} key ${k.address} holds ${monTenths(bal)} MON, below the ${monText(floor)} MON floor`, data: { role: k.role } });
        else if (need !== null && bal < need)
          this.x.alerts.raise({ code: AlertCode.KEY_LOW, severity: "action", writer: k.address, message: `${k.role} key ${k.address} holds ${monText(bal)} MON, under ${hours} h of its sends at the recent rate (${monText(need)} MON): fund it`, data: { role: k.role } });
        // clear on a top-up, or once the balance covers the measured need by a quarter (hysteresis: a lumpy send entering
        // or leaving the window moves need by several MON, which must not flap the alert); with no rate yet keep it
        else if (toppedUp || (need !== null && bal >= need + need / 4n)) this.x.alerts.clearWhere((a) => a.code === AlertCode.KEY_LOW && a.writer?.toLowerCase() === key);
      }
    } catch (e) {
      this.x.heartbeat?.beat(now, `chain checks failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.x.heartbeat?.beat(now, "ok");
  }
}
