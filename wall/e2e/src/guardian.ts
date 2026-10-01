// The scripted honest guardian (6.6's procedure at GUARD_ACT), acting only through the guardian CLI's commands
// (check, look, attest, attest --r12, veto, suspend, kick) with the operator's confirmations typed in. It never
// signs or vetoes anything the CLI itself would refuse: the CLI re-checks R11, R12 and F2 before every send.
import { join } from "node:path";
import { AlertCode, Status } from "@agate/report/types";
import { EventIndexer, GuardianLog, httpFetchPage, LogStore, RpcDown, ViemIndex } from "@agate/watcher";
import { type CliDeps, check, run } from "../../apps/guardian/src/commands.ts";
import { lookReader } from "../../apps/guardian/src/look.ts";
import type { GuardianSpec, World } from "./world.ts";

const lc = (a: string) => a.toLowerCase();

export interface GuardianAct {
  at: number;
  gpu: string;
  day: number;
  act: string;
  code?: number;
  detail?: string;
}

export async function startGuardian(w: World, spec: GuardianSpec): Promise<{ acts: GuardianAct[]; lines: string[] }> {
  const pool = await w.watchPool("guardian");
  const view = new ViemIndex(pool, w.dep.index);
  const alerts = w.watchAlerts("guardian");
  const answers: string[] = [];
  const lines: string[] = [];
  const acts: GuardianAct[] = [];
  const look = lookReader({ fetchPage: httpFetchPage, base: `${w.replay.url}/r/look`, timeoutMs: 2_000, now: () => w.now });
  const deps: CliDeps = {
    view,
    events: new EventIndexer({ pool, address: w.dep.index, dir: join(w.home, "guardian", "events"), fromBlock: w.dep.fromBlock, chunk: 5_000n }),
    log: new LogStore(w.watcherDir),
    glog: new GuardianLog(join(w.home, "guardian")),
    alerts,
    clock: w.wc,
    panels: w.panels,
    now: () => w.now,
    out: (l) => {
      lines.push(l);
      if (lines.length > 4_000) lines.splice(0, 1_000);
    },
    prompt: async () => answers.shift() ?? "",
    senderFor: (k) => w.watchSender(pool, k, k === "AGATE_KICK_KEY" ? "kick" : "guardian", alerts),
    look,
    beats: w.roleBeats(),
    writerRegion: "writer",
  };
  const seen = new Map<string, number>();
  let lastKick = -Infinity;
  const cli = async (argv: string[], answer?: string): Promise<number> => {
    if (answer !== undefined) answers.push(answer);
    const code = await run(deps, argv);
    answers.length = 0;
    return code;
  };

  w.guardianTick = async (now) => {
    try {
      await act(now);
    } catch (e) {
      // the CLI fails like this for a person too (every RPC URL down): note it and try again next tick
      if (e instanceof RpcDown) acts.push({ at: now, gpu: "-", day: -1, act: "rpc down", detail: e.message.slice(0, 120) });
      else throw e;
    }
  };
  const act = async (now: number) => {
    if (spec.from !== undefined && now < spec.from) return;
    await pool.tick(now);
    const open = alerts.open();
    // A1: the keeper's job by hand while its heartbeat is lost
    const keeperLost = open.some((a) => a.code === AlertCode.HEARTBEAT_LOST && (a.data as { role?: string } | undefined)?.role === "keep");
    if (keeperLost && now - lastKick >= w.wc.keeperPeriod) {
      lastKick = now;
      for (const p of w.panels) {
        const code = await cli(["kick", p.gpu]);
        acts.push({ at: now, gpu: p.gpu, day: -1, act: "kick", code });
      }
    }
    for (const p of w.panels) {
      const head = await view.head(p.gpuId);
      const d = head - 1;
      const r = await view.record(p.gpuId, d);
      if (!r.exists || r.isFinal || r.rec.status === Status.CARRIED || r.rec.attestedAt !== 0n) continue;
      const mine = open.filter((a) => a.severity === "action" && a.gpuId !== undefined && lc(a.gpuId) === lc(p.gpuId));
      const trig = mine.filter((a) => a.day === d && ([AlertCode.R1_NO_CANDIDATE, AlertCode.R9_UNCHANGED_NOT_STRICT, AlertCode.R5_HEAD_LAG, AlertCode.R3_VETO_REASON, AlertCode.RPC_DOWN] as string[]).includes(a.code));
      const dropped = mine.some((a) => a.code === AlertCode.FREEZE_LOOP);
      const attLost = open.filter((a) => a.code === AlertCode.HEARTBEAT_LOST && (a.data as { role?: string } | undefined)?.role === "attest");
      const times = [...trig.map((a) => a.at), ...attLost.map((a) => Math.max(a.at, Number(r.rec.postedAt)))];
      if (times.length === 0 && !dropped) continue;
      const raised = times.length > 0 ? Math.min(...times) : now;
      if (now < raised + spec.delay) continue;
      const key = `${p.gpuId}:${d}:${r.rec.digest}`;
      if (now - (seen.get(key) ?? -Infinity) < Math.max(1, Math.floor(w.wc.slice / 4))) continue;
      seen.set(key, now);
      let ev = await check(deps, [p.gpu, String(d)]);
      if (spec.looks && ev.guardian.looksNeeded.length > 0) {
        const recent = deps.glog.looks(p.gpuId);
        let took = false;
        for (const i of ev.guardian.looksNeeded) {
          const src = p.sources[i]!;
          if (recent.some((l) => l.sourceId === src && l.at >= now - w.wc.slice)) continue;
          const code = await cli(["look", p.gpu, "--region", "writer", "--source", src]);
          acts.push({ at: now, gpu: p.gpu, day: d, act: `look ${src}`, code });
          took = true;
        }
        if (took) ev = await check(deps, [p.gpu, String(d)]);
      }
      if (spec.suspend) {
        for (const x of ev.guardian.r8.filter((y) => !y.reason.includes("look from the writer's region first"))) {
          const code = await cli(["suspend", x.writer], "yes");
          acts.push({ at: now, gpu: p.gpu, day: d, act: `suspend ${x.writer}`, code, detail: x.reason });
        }
      }
      const g = ev.guardian;
      if (g.r11) {
        if (lc(g.r11.writer) === lc(r.rec.source) && !r.rec.needsSign) {
          acts.push({ at: now, gpu: p.gpu, day: d, act: "R11 lets it stand" });
          continue;
        }
        const code = await cli(["attest", p.gpu, String(d), "--writer", g.r11.writer, "--digest", g.r11.digest], "yes");
        acts.push({ at: now, gpu: p.gpu, day: d, act: `R11 attest ${g.r11.writer}`, code });
        if (code === 0) continue;
      }
      if (g.r12Ready && g.r12) {
        const code = await cli(["attest", p.gpu, String(d), "--writer", g.r12.writer, "--digest", g.r12.digest, "--r12"], "yes");
        acts.push({ at: now, gpu: p.gpu, day: d, act: `R12 attest ${g.r12.writer}`, code });
        if (code === 0) continue;
      }
      const r12Time = dropped || now >= raised + w.wc.guardAct;
      if (g.veto && (!r.rec.needsSign || r12Time)) {
        const code = await cli(["veto", p.gpu, String(d), "--source", g.veto.writer, "--digest", g.veto.digest], g.veto.digest.slice(2, 10));
        acts.push({ at: now, gpu: p.gpu, day: d, act: `veto ${g.veto.writer}`, code, detail: g.veto.reasons.join("; ") });
        continue;
      }
      if (r12Time) acts.push({ at: now, gpu: p.gpu, day: d, act: "nothing qualifies", detail: g.r12Why.join("; ") });
    }
  };
  return { acts, lines };
}

