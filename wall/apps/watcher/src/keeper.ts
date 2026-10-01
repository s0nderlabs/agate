// The keeper (BUILD-SPEC 9.3): a plain funded key with no role. At least every DAY/12 per GPU, and at once on wake:
// closeDay when the head day is past dayEnd + CLOSE_GRACE and a source can close it, carryDay when a needsSign record
// is droppable or a no-data day is carriable. Never sends what eth_call says reverts (the sender simulates first).
// After an outage it catches up one carry per call; the contract spaces carries by STEP.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "@agate/report/types";
import { AlertCode, Status } from "@agate/report/types";
import type { AlertSink } from "./alerts.ts";
import type { IndexView, Sender } from "./chain/types.ts";
import { dayEnd, type WallClock } from "./clock.ts";
import type { Heartbeat } from "./fsutil.ts";

export interface KeeperDeps {
  view: IndexView;
  sender: Sender;
  clock: WallClock;
  gpuIds: Hex[];
  alerts?: AlertSink;
  heartbeat?: Heartbeat;
  tickS: number;
  /** LV-3: the attester's noted pick for a GPU's pending record ({day, digest, at}), or null */
  attesterPick?: (gpuId: Hex) => { day: number; digest: Hex; at: number } | null;
  /** test hook */
  onSend?: (fn: string, gpuId: Hex, ok: boolean, error?: string) => void;
}

export class Keeper {
  private readonly nextTry = new Map<string, number>();
  private lastTick: number | null = null;
  // LV-3: no case-1 drop until this time (one slice after a wake or an RPC recovery), so the attester acts first
  private holdDropUntil = -Infinity;
  private rpcFailed = false;
  readonly sent: { at: number; fn: string; gpuId: Hex; ok: boolean; error?: string }[] = [];

  constructor(readonly x: KeeperDeps) {}

  private get backoff(): number {
    const c = this.x.clock;
    return Math.min(c.keeperPeriod, Math.max(1, Math.floor(c.slice / 12)));
  }

  async tick(now: number): Promise<void> {
    const woke = this.lastTick === null || now - this.lastTick > 3 * this.x.tickS;
    if (woke && this.lastTick !== null) this.x.alerts?.raise({ code: AlertCode.CLOCK_JUMP, severity: "info", message: `keeper woke after ${now - this.lastTick} s`, data: { slept: now - this.lastTick, role: "keep" } });
    if (woke) {
      this.nextTry.clear();
      this.holdDropUntil = now + this.x.clock.slice;
    }
    this.lastTick = now;
    for (const g of this.x.gpuIds) {
      try {
        await this.gpuTick(g, now);
      } catch (e) {
        this.rpcFailed = true;
        this.x.heartbeat?.beat(now, `gpu ${g}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.x.heartbeat?.beat(now, "ok");
  }

  private async gpuTick(g: Hex, now: number): Promise<void> {
    if ((this.nextTry.get(g.toLowerCase()) ?? 0) > now) return;
    const c = this.x.clock;
    const head = await this.x.view.head(g);
    const r = await this.x.view.record(g, head - 1);
    if (this.rpcFailed) {
      this.rpcFailed = false;
      this.holdDropUntil = Math.max(this.holdDropUntil, now + c.slice);
    }
    const pendingUnfinal = r.exists && !r.isFinal && r.rec.status !== Status.CARRIED;
    let fn: "closeDay" | "carryDay" | null = null;
    if (pendingUnfinal) {
      // only a droppable needsSign record (unattested, finalAt 0) is the keeper's business; the contract checks the time
      if (r.rec.needsSign && r.rec.attestedAt === 0n && r.rec.finalAt === 0n) fn = "carryDay";
      // LV-3: never race the attester: hold the drop one slice after a wake or RPC recovery, and while the attester
      // has a fresh pick noted for this very record
      const pick = fn ? this.x.attesterPick?.(g) : null;
      const picked = pick && pick.day === head - 1 && pick.digest.toLowerCase() === r.rec.digest.toLowerCase() && pick.at >= now - 2 * c.slice;
      if (fn && (now < this.holdDropUntil || picked)) fn = null;
    } else if (now >= dayEnd(c, head) + c.closeGrace) fn = "closeDay";
    else if (now >= dayEnd(c, head)) fn = "carryDay";
    if (!fn) {
      this.nextTry.set(g.toLowerCase(), now + this.backoff);
      return;
    }
    let res = await this.x.sender.send(fn, [g]);
    if (!res.ok && !res.sent && fn === "closeDay") res = await this.x.sender.send((fn = "carryDay"), [g]);
    this.sent.push({ at: now, fn, gpuId: g, ok: res.ok, ...(res.error ? { error: res.error } : {}) });
    this.x.onSend?.(fn, g, res.ok, res.error);
    // after a success try again at once (catch-up); after a refusal wait the backoff
    this.nextTry.set(g.toLowerCase(), res.ok ? now : now + this.backoff);
  }
}

/** LV-3: the file where the attester notes the pick it is sending for a GPU (same machine as the keeper). Per index:
 *  every index registers the same gpuIds under one AGATE_WALL_HOME. */
export function pickNotePath(home: string, index: string, gpuId: Hex): string {
  return join(home, "attester", `pick-${index.slice(2, 10).toLowerCase()}-${gpuId.slice(2, 10).toLowerCase()}.json`);
}

export function readPickNote(path: string): { day: number; digest: Hex; at: number } | null {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf8")) as { day?: unknown; digest?: unknown; at?: unknown };
    if (typeof j.day !== "number" || typeof j.digest !== "string" || typeof j.at !== "number") return null;
    return { day: j.day, digest: j.digest as Hex, at: j.at };
  } catch {
    return null; // an unreadable note never blocks the keeper
  }
}
