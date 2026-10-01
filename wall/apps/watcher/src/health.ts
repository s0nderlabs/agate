// Health (BUILD-SPEC 9.5, no key): every min(60 s, slice) check each role's heartbeat, the head lag against LAG_MAX,
// every role key's balance and the RPC URLs. Raises HEARTBEAT_LOST, R5_HEAD_LAG, KEY_LOW, RPC_DOWN and CLOCK_SKEW.
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
  heartbeat?: Heartbeat;
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
      for (const k of this.x.keys) {
        const bal = await this.x.view.balance(k.address);
        if (bal < (this.x.minBalanceWei ?? 10n * 10n ** 18n))
          this.x.alerts.raise({ code: AlertCode.KEY_LOW, severity: "action", writer: k.address, message: `${k.role} key ${k.address} holds ${bal} wei (below 10 MON)` });
      }
    } catch (e) {
      this.x.heartbeat?.beat(now, `chain checks failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.x.heartbeat?.beat(now, "ok");
  }
}
