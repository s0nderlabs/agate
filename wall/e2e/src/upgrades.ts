// The Oct 3 upgrade scenarios (BUILD-SPEC 17.2, the wall upgrades): the reader swap taking effect
// at the next day start (4.15, 8.6), owner actions and swaps that expire (4.11), the writers reposting through a long
// RPC outage inside GRACE (8.1, with 13.6's redaction checked on every file), KEY_MISMATCH on a second user of a
// writer's key (8.5, R8 (d)), the page check's review and fault alerts (15.1), two indexes side by side on one chain
// with the same keys (13.7) and CoreWeave in the launch panel (7.10). Synthetic pages and tracker files only (numbers
// written here); the CoreWeave run reads the live logger's archive in place.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AlertCode, type Address, type GpuModel, type Hex } from "@agate/report/types";
import type { TrackerScript } from "@agate/sources/io";
import { decisionsPath, guardianLogDir, type WallEvent } from "@agate/watcher";
import { reportHex } from "@agate/writer-standby";
import { archiveView } from "./archive.ts";
import { ActionKind, ADDR, executeAction, LAUNCH_PANELS_FILE, PROFILES, queueAction, read, type ReaderArg, ROLE, ROOT, SELECTOR, send, simulate } from "./chain.ts";
import { demoScenario, eventTime, filesUnder, final, GUARD, guard, H100_ID, h100World, jsonLines, lc, NOV1, OCT1, p, relDay, runWorld, type Scenario, T0 } from "./kit.ts";
import { installLambdaV2, LAMBDA_V2 } from "./lambda-v2.ts";
import { EXTRACTORS_BY_VERSION, GPUS } from "@agate/sources/pure";
import type { Extractor } from "@agate/sources/types";
import { AlertSink, WsWake } from "@agate/watcher";
import { loadConfig as repairConfig, RepairAgent, readerSwapId as repairSwapId, Spawner, viemChain } from "../../apps/repair/src/index.ts";
import { GOOD_V2 } from "../../apps/repair/test/canned.ts";
import { cliOutput, fakeClaude } from "../../apps/repair/test/world.ts";
import { type Check, judge, readAlerts, type RunReport } from "./report.ts";
import { index8, World } from "./world.ts";

const H100 = H100_ID as Hex;
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const ok = (name: string, cond: boolean, detail: string): Check => ({ name, ok: cond, detail });

/** The indented rows printed under one header line of a CLI output (until the next unindented line). */
function section(out: readonly string[], header: string): string[] {
  const i = out.findIndex((l) => l.startsWith(header));
  if (i < 0) return [];
  const rows: string[] = [];
  for (const l of out.slice(i + 1)) {
    if (!l.startsWith("  ")) break;
    rows.push(l);
  }
  return rows;
}

type ReadingLine = { kind: string; index?: string; dayId: number; slice: number; readAt: number; entries: { gpuId: string; values: number[] }[]; sources: { sourceId: string; rows: Partial<Record<GpuModel, { state: string; valueU: number }>>; parsers?: Partial<Record<GpuModel, string>> }[] };
type WatchLine = { sourceId: string; interval: number; attempts: number; gpus: Partial<Record<GpuModel, { state: string; valueU: number }>>; parsers?: Partial<Record<GpuModel, string>>; url?: string };

/** A writer's reading lines of this index. */
function writerReadings(w: World, role: "primary" | "standby"): ReadingLine[] {
  const ix = lc(w.dep.index);
  return jsonLines<ReadingLine>(join(w.home, role, "readings")).filter((l) => l.kind === "reading" && lc(l.index ?? ix) === ix);
}

/** Every final record of a GPU and both writers' readings of its day, as JSON (the "byte-identical" snapshot). */
async function snapshot(w: World, g: Hex): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const cfg = await read<{ firstDay: number; head: number }>(w.a, w.dep.index, "gpu", [g]);
  for (let d = Number(cfg.firstDay); d < Number(cfg.head); d++) {
    const r = await read<[boolean, boolean, unknown]>(w.a, w.dep.index, "record", [g, d]);
    if (!r[0] || !r[1]) continue;
    const rd = [];
    for (const who of [ADDR[ROLE.primary]!, ADDR[ROLE.standby]!]) rd.push(await read<unknown>(w.a, w.dep.index, "readings", [g, d, who]));
    out.set(d, json({ record: r[2], readings: rd }));
  }
  return out;
}

function sameSnapshots(before: Map<number, string>, after: Map<number, string>): string[] {
  const bad: string[] = [];
  for (const [d, s] of before) if (after.get(d) !== s) bad.push(String(d));
  return bad;
}

// ------------------------------------------------------------------ reader swap (4.15, 8.6)

/** Lambda (H100 slot 2, the median) is redesigned from demo day 2: lambda/1 reads no row for everyone. The owner
 *  queues a swap to the test-installed lambda/2 one slice later, and a spare swap of the same slot that nobody
 *  executes; the swap is executed at its eta; from fromDay both writers, the logger, the attester's rule R and the
 *  guardian's look read with lambda/2. Lambda steps 3.40 to 3.50 the day after fromDay. */
const readerSwap: Scenario = {
  name: "reader-swap",
  what: "DEMO: Lambda's page (H100 slot 2, the median) redesigned from demo day 2 (lambda/1 reads no row for everyone); the owner queues a swap to a test-installed lambda/2 (and a spare swap of the same slot) a slice later and executes it at eta; both writers and the watcher switch at fromDay, never mid-day; Lambda steps 3.40 to 3.50 the day after; every record recorded before the execute byte-identical; the spare is refused after its window (ActionExpired), queued afresh and cancelled; guardian on",
  run: async () => {
    const R = 2;
    const slot = 2;
    const reader: ReaderArg = { url: "https://lambda.ai/pricing", parserVersion: LAMBDA_V2 };
    const spare: ReaderArg = { url: "https://lambda.ai/pricing?agate=spare", parserVersion: LAMBDA_V2 };
    const scripted = h100World({ 2: [{ from: { day: R + 4 }, ...p("3.50") }] });
    scripted.p_lambda!.page = [{ from: { day: R }, state: "redesigned" }];
    let queuedAt = 0;
    let eta = 0;
    let spareEta = 0;
    let executedAt = 0;
    let fromDay = 0;
    let atQueue = new Map<number, string>();
    let atExecute = new Map<number, string>();
    const status: { when: string; out: string[] }[] = [];
    const sendErr: string[] = [];
    let uninstall = () => {};
    return runWorld(
      {
        name: "reader-swap",
        profile: PROFILES.DEMO,
        startTs: T0,
        epochDay: NOV1,
        gpus: [{ gpu: "H100" }],
        scenario: { archive: false, scripted },
        primary: {},
        standby: {},
        guardian: guard(PROFILES.DEMO.day),
        setup: async (w) => {
          uninstall = installLambdaV2();
          w.cleanups.push(() => uninstall());
        },
      },
      (w) => w.dayEnd(relDay(w, R + 6)) + 300,
      {
        extra: async (w, ev, days) => {
          const out: Check[] = [];
          const swapped = ev.filter((e): e is Extract<WallEvent, { name: "ReaderSwapped" }> => e.name === "ReaderSwapped");
          const at = swapped[0] ? await eventTime(w, swapped[0]) : 0;
          out.push(ok("queued, executed at its eta, effective from the next day start", swapped.length === 1 && eta === queuedAt + w.wc.timelock && at >= eta && at - eta <= w.step && fromDay === w.dayAt(at + w.wc.slice) + 1 && fromDay === relDay(w, R + 3), `queued ${queuedAt}, eta ${eta} (TIMELOCK ${w.wc.timelock} s), executed ${at} (${at - eta} s after eta), fromDay ${fromDay} = day of (execute + one slice) + 1 = ${w.dayAt(at + w.wc.slice) + 1}; ${swapped.length} ReaderSwapped`));
          const hist = await read<{ fromDay: number; url: string; parserVersion: string; reason: string }[]>(w.a, w.dep.index, "readerHistory", [H100, slot]);
          const before = await read<[boolean, unknown]>(w.a, w.dep.index, "readerAt", [H100, slot, fromDay - 1]);
          const on = await read<[boolean, { parserVersion: string }]>(w.a, w.dep.index, "readerAt", [H100, slot, fromDay]);
          out.push(ok("reader history onchain", hist.length === 1 && Number(hist[0]!.fromDay) === fromDay && hist[0]!.parserVersion === LAMBDA_V2 && hist[0]!.reason.includes("redesigned") && !before[0] && on[0] && on[1].parserVersion === LAMBDA_V2, `history ${json(hist.map((h) => ({ fromDay: Number(h.fromDay), url: h.url, parserVersion: h.parserVersion, reason: h.reason })))}; readerAt(fromDay - 1) swapped ${before[0]}, readerAt(fromDay) ${on[0]} ${on[1].parserVersion}`));
          // both writers: lambda/1 before the redesign, no row on the redesign days, lambda/2 from fromDay (never mid-day)
          for (const role of ["primary", "standby"] as const) {
            const bad: string[] = [];
            let n = 0;
            for (const l of writerReadings(w, role)) {
              const src = l.sources.find((s) => s.sourceId === "p_lambda");
              const row = src?.rows.H100;
              const v = l.entries.find((e) => lc(e.gpuId) === lc(H100))?.values[slot];
              if (!src || !row) continue;
              n++;
              const k = l.dayId - w.dep.epochDay;
              const want = l.dayId >= fromDay ? { parser: LAMBDA_V2, state: "VALID", v: k >= R + 4 ? 3_500_000 : 3_400_000 } : k >= R ? { parser: undefined, state: "NO_ROW", v: 0 } : { parser: undefined, state: "VALID", v: 3_400_000 };
              if (src.parsers?.H100 !== want.parser || row.state !== want.state || v !== want.v) bad.push(`${l.dayId}/${l.slice}: ${src.parsers?.H100 ?? "lambda/1"} ${row.state} ${v}`);
            }
            out.push(ok(`${role} switches to lambda/2 at fromDay`, bad.length === 0 && n > 0, bad.length ? bad.slice(0, 6).join("; ") : `${n} readings: lambda/1 VALID before day ${relDay(w, R)}, NO_ROW to day ${fromDay - 1}, lambda/2 VALID from day ${fromDay}`));
          }
          // the watcher's logger: the same switch, one line per (source, URL)
          const wl = jsonLines<WatchLine>(join(w.watcherDir, "log")).filter((l) => l.sourceId === "p_lambda" && l.attempts > 0);
          const wbad: string[] = [];
          for (const l of wl) {
            const day = w.dep.epochDay + Math.floor(l.interval / w.wc.slices);
            const k = day - w.dep.epochDay;
            const g = l.gpus.H100;
            const want = day >= fromDay ? { parser: LAMBDA_V2, state: "VALID" } : k >= R ? { parser: undefined, state: "NO_ROW" } : { parser: undefined, state: "VALID" };
            if (l.parsers?.H100 !== want.parser || g?.state !== want.state || l.url !== undefined) wbad.push(`${l.interval} (day ${day}): ${l.parsers?.H100 ?? "lambda/1"} ${g?.state}${l.url ? ` url ${l.url}` : ""}`);
          }
          out.push(ok("the watcher switches to lambda/2 at fromDay", wbad.length === 0 && wl.length > 0, wbad.length ? wbad.slice(0, 6).join("; ") : `${wl.length} Lambda lines, lambda/2 from day ${fromDay}`));
          const f0 = final(days, fromDay);
          const f1 = final(days, fromDay + 1);
          out.push(ok("the swapped reader drives the fix", f0?.value === 3_400_000 && f1?.value === 3_500_000 && f1.status !== "CARRIED", `day ${fromDay}: ${f0?.value} ${f0?.status}; day ${fromDay + 1} (Lambda 3.50): ${f1?.value} ${f1?.status}`));
          const now = await snapshot(w, H100);
          const b1 = sameSnapshots(atQueue, now);
          const b2 = sameSnapshots(atExecute, now);
          out.push(ok("every record before the queue and the execute byte-identical", b1.length === 0 && b2.length === 0 && atQueue.size > 0 && atExecute.size > atQueue.size, `${atQueue.size} final days at the queue, ${atExecute.size} at the execute; changed: ${[...b1, ...b2].join(", ") || "none"}`));
          const al = readAlerts(w);
          const swapId = swapped[0]?.id ?? "0x";
          const qAlert = al.filter((a) => a.code === AlertCode.ONCHAIN_EVENT && a.severity === "action" && (a.data as { id?: string } | undefined)?.id === swapId);
          const missing = al.filter((a) => a.code === AlertCode.READER_MISSING || a.code === AlertCode.READER_REFUSED);
          out.push(ok("queue alert (action, deadline eta) raised, cleared by the execute; no READER_MISSING or READER_REFUSED", qAlert.length > 0 && qAlert.some((a) => (a as { deadline?: number }).deadline === eta) && qAlert.some((a) => a.cleared !== undefined) && missing.length === 0, `${qAlert.length} line(s) for the swap's ONCHAIN_EVENT action alert; ${missing.length} reader alert(s)`));
          const s1 = status.find((s) => s.when === "queued")?.out.filter((l) => l.includes("reader swap H100 slot 2")) ?? [];
          const s2 = status.find((s) => s.when === "executed")?.out.filter((l) => l.includes("reader swap H100 slot 2")) ?? [];
          const hl = status.find((s) => s.when === "executed")?.out.filter((l) => l.startsWith("reader history")) ?? [];
          out.push(ok("guardian status: both swaps while queued, only the spare after the execute, then the history", s1.length === 2 && s1.every((l) => l.includes(LAMBDA_V2) && l.includes("(p_lambda)")) && s2.length === 1 && s2[0]!.includes("agate=spare") && hl.some((l) => l.includes(`from day ${fromDay}`)), `queued: ${s1.length} line(s); after execute: ${s2.map((l) => l.trim().slice(0, 90)).join(" | ") || "none"}; ${hl.join(" | ")}`));
          // the spare: dead after its window (no event, a time), refused, queued afresh, cancelled
          const spareId = await read<Hex>(w.a, w.dep.index, "readerSwapId", [H100, slot, spare]);
          const windowEnd = spareEta + 14 * w.wc.day;
          w.now = await w.a.warp(windowEnd + 1);
          const exp = await simulate(w.a, ROLE.owner, "executeReaderSwap", [H100, slot, spare], w.dep.index);
          const etaAfter = Number(await read<bigint>(w.a, w.dep.index, "queuedEta", [spareId]));
          await send(w.a, ROLE.owner, "queueReaderSwap", [H100, slot, spare, "e2e: the spare queued again after its window"], w.dep.index);
          const etaAgain = Number(await read<bigint>(w.a, w.dep.index, "queuedEta", [spareId]));
          const early = await simulate(w.a, ROLE.owner, "executeReaderSwap", [H100, slot, spare], w.dep.index);
          await send(w.a, ROLE.owner, "cancelReaderSwap", [H100, slot, spare], w.dep.index);
          const etaCancelled = Number(await read<bigint>(w.a, w.dep.index, "queuedEta", [spareId]));
          out.push(ok("the spare swap: ActionExpired after its window, queuedEta 0, queued afresh with a new TIMELOCK, then cancelled", exp === "ActionExpired" && etaAfter === 0 && etaAgain === w.now + w.wc.timelock && early === "TimelockActive" && etaCancelled === 0, `execute at window end + 1: ${exp}; queuedEta then ${etaAfter}; queued again: eta ${etaAgain} (now + TIMELOCK ${w.now + w.wc.timelock}), execute before it: ${early}; after cancel ${etaCancelled}`));
          if (sendErr.length) out.push(ok("owner sends", false, sendErr.join("; ")));
          return out;
        },
      },
      async (w) => {
        try {
          if (!queuedAt && w.now >= w.sliceStart(relDay(w, R), 1) + 20) {
            atQueue = await snapshot(w, H100);
            await send(w.a, ROLE.owner, "queueReaderSwap", [H100, slot, reader, "e2e: Lambda's pricing page was redesigned; lambda/1 reads no row"], w.dep.index);
            await send(w.a, ROLE.owner, "queueReaderSwap", [H100, slot, spare, "e2e: a spare nobody executes"], w.dep.index);
            queuedAt = w.now;
            eta = Number(await read<bigint>(w.a, w.dep.index, "queuedEta", [await read<Hex>(w.a, w.dep.index, "readerSwapId", [H100, slot, reader])]));
            spareEta = Number(await read<bigint>(w.a, w.dep.index, "queuedEta", [await read<Hex>(w.a, w.dep.index, "readerSwapId", [H100, slot, spare])]));
            w.note(`queued reader swap, eta ${eta}`);
          } else if (queuedAt && !status.some((s) => s.when === "queued") && w.now >= queuedAt + w.wc.slice) {
            status.push({ when: "queued", out: (await w.guardian!.cli(["status"])).out });
          } else if (queuedAt && !executedAt && w.now >= eta) {
            atExecute = await snapshot(w, H100);
            const early = await simulate(w.a, ROLE.owner, "executeReaderSwap", [H100, slot, reader], w.dep.index);
            if (early !== null) sendErr.push(`execute at eta simulates as ${early}`);
            await send(w.a, ROLE.owner, "executeReaderSwap", [H100, slot, reader], w.dep.index);
            executedAt = w.now;
            const h = await read<{ fromDay: number }[]>(w.a, w.dep.index, "readerHistory", [H100, slot]);
            fromDay = Number(h[0]?.fromDay ?? 0);
            const rel = fromDay - w.dep.epochDay;
            // the honest reference: from fromDay the H100 Lambda slot is read with lambda/2, which reads the new layout
            w.truth.readsRedesign = (id, gpu, replayDay) => id === "p_lambda" && gpu === "H100" && replayDay >= rel;
            w.note(`executed reader swap, fromDay ${fromDay}`);
          } else if (executedAt && !status.some((s) => s.when === "executed") && w.now >= executedAt + w.wc.slice) {
            status.push({ when: "executed", out: (await w.guardian!.cli(["status"])).out });
          }
        } catch (e) {
          sendErr.push(`${w.now}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        }
      },
    );
  },
};

// ------------------------------------------------------------------ expired owner actions (4.11, 9.4, 10)

const ownerExpired: Scenario = {
  name: "owner-action-expired",
  what: "FAST: the owner queues a GUARDIAN action (executed in its window), an ATTESTER action and a Lambda reader swap (both left to expire) and a FORWARDER action (cancelled) while the attester is down and restarted; guardian status lists only live entries with kind and fields; after 14 DAY both are refused with ActionExpired, the attester announces each once, status --all lists them as expired, and the action is queued afresh; beside it, 13.6's websocket wake on anvil's own ws endpoint (no monadLogs there: the finalized logs fallback)",
  run: async () => {
    const g1: { kind: number; slot: number; addr: Address; gpuId: Hex; day: number; mode: number } = { kind: ActionKind.GUARDIAN, slot: 1, addr: ADDR[7]!, gpuId: `0x${"0".repeat(64)}` as Hex, day: 0, mode: 0 };
    const att = { ...g1, kind: ActionKind.ATTESTER, slot: 0, addr: ADDR[6]! };
    const fwd = { ...g1, kind: ActionKind.FORWARDER, slot: 0, addr: ADDR[7]!, mode: 0 };
    const swap: ReaderArg = { url: "https://lambda.ai/pricing", parserVersion: LAMBDA_V2 };
    const ids: Record<string, Hex> = {};
    let eta = 0;
    let swapEta = 0;
    let executed = false;
    const status: { when: string; out: string[] }[] = [];
    const notes: string[] = [];
    let expiredChecked = false;
    let requeueEta = 0;
    let q = 0;
    let restarted = false;
    const errs: string[] = [];
    let ws: WsWake | null = null;
    const wsLog: string[] = [];
    let wakes = 0;
    return runWorld(
      {
        name: "owner-action-expired",
        profile: PROFILES.FAST,
        startTs: T0,
        epochDay: NOV1,
        gpus: [{ gpu: "H100" }],
        scenario: { archive: false, scripted: h100World() },
        primary: {},
        standby: {},
        guardian: GUARD,
        setup: async (w) => {
          // 13.6 on a real node: the attester's wake subscription against anvil's websocket (the same port)
          ws = new WsWake({ urls: [`ws://127.0.0.1:${w.a.port}`], address: w.dep.index, kinds: ["logs"], onWake: () => void wakes++, role: "attest", log: (e, d) => void wsLog.push(`${e} ${json(d)}`) });
          ws.start();
          const x = ws;
          w.cleanups.push(() => x.stop());
        },
      },
      (w) => {
        // the owner queues on day 1; the attester process is down then and restarted from its files before it runs
        // again, so the queue lands while it is not running (9.4: it must still announce it)
        q = w.dayStart(relDay(w, 1)) + 5;
        w.down = (pp, t) => pp === "attest" && t >= q - 3 && t < q + 3;
        return q + w.wc.timelock + 14 * w.wc.day + 4 * w.wc.day;
      },
      {
        extra: async (w) => {
          const out: Check[] = [];
          const end = eta + 14 * w.wc.day;
          const LIVE = "queued owner actions and reader swaps (live):";
          const liveRows = section(status.find((s) => s.when === "live")?.out ?? [], LIVE);
          out.push(ok("status inside the window: only live entries, with kind and fields", liveRows.length === 2 && liveRows.some((l) => l.includes("ATTESTER") && lc(l).includes(lc(ADDR[6]!)) && l.includes("executable, window ends in")) && liveRows.some((l) => l.includes("reader swap H100 slot 2 (p_lambda)") && l.includes(LAMBDA_V2) && l.includes("e2e: queued and never executed")) && !liveRows.some((l) => lc(l).includes(lc(ids.g1!)) || lc(l).includes(lc(ids.fwd!))), liveRows.map((l) => l.trim().slice(0, 120)).join(" | ") || "none"));
          const after = status.find((s) => s.when === "expired")?.out ?? [];
          const all = status.find((s) => s.when === "expired --all")?.out ?? [];
          const dead = section(all, "expired (queue again to use)");
          out.push(ok("after the window: status lists none, --all lists both as expired", after.some((l) => l.startsWith(`${LIVE} none`)) && section(after, LIVE).length === 0 && dead.length === 2 && dead.every((l) => l.includes("expired at")) && dead.some((l) => lc(l).includes(lc(ids.att!))) && dead.some((l) => lc(l).includes(lc(ids.swap!))), `live: ${after.find((l) => l.startsWith(LIVE))?.trim()}; expired: ${dead.map((l) => l.trim().slice(0, 80)).join(" | ")}`));
          const al = readAlerts(w);
          const ann = (id: string) => al.filter((a) => a.code === AlertCode.ONCHAIN_EVENT && (a.data as { id?: string; expired?: boolean } | undefined)?.id === id && (a.data as { expired?: boolean }).expired === true);
          const ids2 = new Set(ann(ids.att!).map((a) => (a as { id?: string }).id));
          out.push(ok("the attester announces each expired entry once (info ONCHAIN_EVENT)", ids2.size === 1 && ann(ids.swap!).length >= 1 && ann(ids.att!).every((a) => a.severity === "info" && a.at > end), `ATTESTER action: ${ann(ids.att!).length} line(s), first at ${ann(ids.att!)[0]?.at} (window end ${end}); swap: ${ann(ids.swap!).length} line(s)`));
          const rm = al.filter((a) => a.code === AlertCode.READER_MISSING && (a.data as { id?: string } | undefined)?.id === ids.swap);
          out.push(ok("READER_MISSING at queue time for the uninstalled lambda/2 (deadline its eta), cleared once the swap is dead", rm.some((a) => (a as { deadline?: number }).deadline === swapEta) && rm.some((a) => a.cleared !== undefined && a.cleared > end), `${rm.length} line(s), deadline ${(rm[0] as { deadline?: number } | undefined)?.deadline} (eta ${swapEta}), cleared at ${rm.find((a) => a.cleared !== undefined)?.cleared} (window end ${end})`));
          const qa = al.filter((a) => a.code === AlertCode.ONCHAIN_EVENT && a.severity === "action" && (a.data as { id?: string } | undefined)?.id === ids.swap);
          const qi = al.filter((a) => a.code === AlertCode.ONCHAIN_EVENT && a.message.startsWith("ActionQueued") && (a.message.includes(ids.att!) || a.message.includes(ids.g1!)));
          out.push(ok("queued while the attester was down and restarted: the swap's action alert and the ActionQueued infos are still raised", qa.length > 0 && qa[0]!.at >= q && qi.length >= 2, `swap action alert ${qa.length} line(s) first at ${qa[0]?.at} (queued at ${q}); ActionQueued infos ${qi.length}`));
          out.push(ok("executed and cancelled entries hold no eta; the expired ones are refused", executed && notes.length === 0 && expiredChecked, notes.join("; ") || "GUARDIAN executed in its window; FORWARDER cancelled; ATTESTER and the swap ActionExpired after it"));
          out.push(ok("an expired action can be queued afresh", requeueEta > end, `new eta ${requeueEta}`));
          const subscribed = wsLog.filter((l) => l.startsWith("ws_subscribed"));
          const refused = wsLog.filter((l) => l.startsWith("ws_subscribe_refused"));
          out.push(ok("13.6 websocket wake on a real node: monadLogs refused, the finalized logs subscription live, index logs delivered as wake-ups", Boolean(ws?.live) && refused.some((l) => l.includes('"monad":true')) && subscribed.some((l) => l.includes('"monad":false')) && (ws?.notifications ?? 0) > 0 && wakes > 0, `live ${ws?.live}; ${ws?.notifications} notifications, ${wakes} wakes (debounced); ${[...refused, ...subscribed].join(" | ")}`));
          if (errs.length) out.push(ok("owner sends", false, errs.join("; ")));
          return out;
        },
      },
      async (w) => {
        ws?.tick();
        await Bun.sleep(0); // let the socket's messages in
        try {
          const end = eta + 14 * w.wc.day;
          if (!eta && w.now >= q) {
            for (const [k, a] of Object.entries({ g1, att, fwd })) {
              await queueAction(w.a, w.dep.index, a);
              ids[k] = await read<Hex>(w.a, w.dep.index, "actionId", [a]);
            }
            await send(w.a, ROLE.owner, "cancel", [fwd], w.dep.index);
            await send(w.a, ROLE.owner, "queueReaderSwap", [H100, 2, swap, "e2e: queued and never executed"], w.dep.index);
            ids.swap = await read<Hex>(w.a, w.dep.index, "readerSwapId", [H100, 2, swap]);
            eta = Number(await read<bigint>(w.a, w.dep.index, "queuedEta", [ids.att]));
            swapEta = Number(await read<bigint>(w.a, w.dep.index, "queuedEta", [ids.swap]));
            w.note(`queued, eta ${eta}`);
          } else if (eta && !restarted && w.now >= q + 2) {
            restarted = true;
            await w.restart("attest");
          } else if (eta && !executed && w.now >= eta + 2) {
            await executeAction(w.a, w.dep.index, g1);
            executed = true;
            const gs = await read<readonly Address[]>(w.a, w.dep.index, "guardians", []);
            if (lc(gs[1]!) !== lc(ADDR[7]!)) notes.push(`guardian slot 1 is ${gs[1]}`);
            for (const k of ["g1", "fwd"]) if (Number(await read<bigint>(w.a, w.dep.index, "queuedEta", [ids[k]!])) !== 0) notes.push(`${k} still has an eta`);
          } else if (executed && !status.some((s) => s.when === "live") && w.now >= eta + 3 * w.wc.day) {
            status.push({ when: "live", out: (await w.guardian!.cli(["status"])).out });
          } else if (eta && !expiredChecked && w.now > end + 1) {
            expiredChecked = true;
            const a = await simulate(w.a, ROLE.owner, "execute", [att], w.dep.index);
            const s = await simulate(w.a, ROLE.owner, "executeReaderSwap", [H100, 2, swap], w.dep.index);
            if (a !== "ActionExpired" || s !== "ActionExpired") notes.push(`execute after the window: action ${a}, swap ${s}`);
            for (const k of ["att", "swap"]) if (Number(await read<bigint>(w.a, w.dep.index, "queuedEta", [ids[k]!])) !== 0) notes.push(`${k} still has an eta after its window`);
          } else if (expiredChecked && !status.some((s) => s.when === "expired") && w.now > end + 2 * w.wc.day) {
            status.push({ when: "expired", out: (await w.guardian!.cli(["status"])).out });
            status.push({ when: "expired --all", out: (await w.guardian!.cli(["status", "--all"])).out });
            await queueAction(w.a, w.dep.index, att);
            requeueEta = Number(await read<bigint>(w.a, w.dep.index, "queuedEta", [ids.att!]));
            await send(w.a, ROLE.owner, "cancel", [att], w.dep.index);
          }
        } catch (e) {
          errs.push(`${w.now}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        }
      },
    );
  },
};

// ------------------------------------------------------------------ reposts through a long RPC outage (8.1, 13.6)

const SECRET = "FAKEALCHEMYKEY0123456789";

/** Both RPC URLs down from slice 9 of day D until 1,800 s after its end (TEST: REPOST_END is 2,200 s after it). The
 *  RPC URLs carry a fake Alchemy-style key, read through AGATE_RPC_URLS_CMD: it must reach no file. */
const repostOutage: Scenario = {
  name: "repost-outage",
  what: "TEST: both RPC URLs (each carrying a fake API key, read through AGATE_RPC_URLS_CMD; the first one also fails alone for 300 s on day 1) error from slice 9 of day 2 until 1,800 s after its end (REPOST_END = graceStart + GRACE - slice = 2,200 s after it): neither writer abandons anything (the close waits one CLOSE_GRACE after the recovery, 8.1 step 3), both backlogs reposted inside GRACE, the day computed and complete, not carried; the key in no file; guardian on",
  run: async () => {
    const D = 2;
    let from = 0;
    let to = 0;
    let oneFrom = 0;
    return runWorld(
      { name: "repost-outage", profile: PROFILES.TEST, startTs: T0, epochDay: OCT1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World() }, primary: {}, standby: {}, guardian: guard(PROFILES.TEST.day), rpcSecret: SECRET },
      (w) => {
        from = w.sliceStart(relDay(w, D), 9);
        to = w.dayEnd(relDay(w, D)) + 1_800;
        oneFrom = w.sliceStart(relDay(w, 1), 3);
        return w.dayEnd(relDay(w, D + 2)) + 900;
      },
      {
        expectAlerts: [AlertCode.RPC_DOWN, AlertCode.RPC_FAILOVER],
        forbidAlerts: [AlertCode.NONCE_STUCK, AlertCode.GAS_CAP],
        extra: async (w, ev, days) => {
          const out: Check[] = [];
          const d = relDay(w, D);
          const c = w.wc;
          const end = w.dayEnd(d);
          const reg = await read<{ registeredAt: bigint }>(w.a, w.dep.index, "gpu", [H100]);
          const graceStart = Math.max(end, Number(reg.registeredAt));
          const repostEnd = graceStart + c.grace - c.slice;
          out.push(ok("REPOST_END = graceStart + GRACE - slice, 2,200 s after the day's end", repostEnd - end === 2_200 && to < repostEnd, `GRACE ${c.grace} s, slice ${c.slice} s, REPOST_END dayEnd + ${repostEnd - end} s; outage ${from - w.dayStart(d)} s into the day to dayEnd + ${to - end} s`));
          const fd = final(days, d);
          const closed = ev.find((e): e is Extract<WallEvent, { name: "DayClosed" }> => e.name === "DayClosed" && e.day === d);
          const closedAt = closed ? await eventTime(w, closed) : 0;
          const posts = ev.filter((e): e is Extract<WallEvent, { name: "ReadingsPosted" }> => e.name === "ReadingsPosted" && e.day === d);
          const abandonOf = (role: "primary" | "standby") => jsonLines<{ kind: string; index?: string; dayId: number; slice: number; at: number; reason: string }>(join(w.home, role, "readings")).filter((l) => l.kind === "abandon" && lc(l.index ?? "") === lc(w.dep.index));
          for (const role of ["primary", "standby"] as const) {
            const a = lc(ADDR[role === "primary" ? ROLE.primary : ROLE.standby]!);
            const mine = posts.filter((e) => lc(e.writer) === a);
            const slices = new Set(mine.map((e) => e.slice));
            const late: string[] = [];
            for (const e of mine.filter((x) => x.slice >= 9)) {
              const t = await eventTime(w, e);
              late.push(`slice ${e.slice} read ${e.readAt - w.sliceStart(d, e.slice)} s into it, landed dayEnd + ${t - end} s`);
              if (t < to || t > repostEnd || e.readAt < w.sliceStart(d, e.slice) || e.readAt >= w.sliceStart(d, e.slice) + c.slice) late.push("BAD: outside [outage end, REPOST_END] or not read in its slice");
            }
            const ab = abandonOf(role);
            if (lc(closed?.source ?? "") === a) {
              out.push(ok(`${role} (the source): abandons nothing, every slice of day D landed, its backlog after the outage and before REPOST_END`, ab.length === 0 && slices.size === c.slices && late.length === 3 && !late.some((l) => l.startsWith("BAD")), `${slices.size}/${c.slices} slices; ${late.join("; ")}; ${ab.length} abandoned`));
            } else {
              // 8.1 step 3: after an outage past the day no writer closes before the recovery +
              // CLOSE_GRACE, so the second writer's backlog lands first and its record stays complete (selectable, F6)
              out.push(ok(`${role} (second writer): abandons nothing, every slice of day D landed before the close (8.1 step 3)`, ab.length === 0 && slices.size === c.slices && !late.some((l) => l.startsWith("BAD")), `${slices.size}/${c.slices} slices landed${late.length ? ` (${late.join("; ")})` : ""}; abandoned ${ab.map((x) => `${x.dayId}/${x.slice} at dayEnd + ${x.at - end} s (${x.reason})`).join(", ") || "none"}; the source closed at dayEnd + ${closedAt - end} s`));
            }
          }
          const others = (["primary", "standby"] as const).flatMap((r) => abandonOf(r).filter((x) => x.dayId !== d).map((x) => `${r} ${x.dayId}/${x.slice}`));
          out.push(ok("no slice of any other day abandoned", others.length === 0, others.join(", ") || "none"));
          out.push(ok("day D computed and complete, not carried; closed after the backlog", Boolean(fd?.final && fd.status !== "CARRIED" && !fd.incomplete && closedAt >= to), `day ${d}: ${fd?.status} ${fd?.final ? "final" : "pending"} incomplete ${fd?.incomplete}, closed at dayEnd + ${closedAt - end} s by ${closed?.source}`));
          const d1 = final(days, d + 1);
          out.push(ok("day D+1 computed (its own slices read during the outage, posted after it)", Boolean(d1?.final && d1.status !== "CARRIED"), `day ${d + 1}: ${d1?.status} incomplete ${d1?.incomplete}`));
          // 13.6: the fake key reaches no file under AGATE_WALL_HOME, and the alerts name the endpoints redacted
          const leaks = filesUnder(w.home).filter((f) => readFileSync(f).includes(SECRET));
          const down = readAlerts(w).filter((a) => a.code === AlertCode.RPC_DOWN || a.code === AlertCode.RPC_FAILOVER);
          const named = down.filter((a) => a.message.includes("127.0.0.1"));
          const urlsHadKey = (w.endpoints?.http ?? []).every((u) => u.includes(SECRET)) && (w.endpoints?.http.length ?? 0) === 2;
          out.push(ok("13.6: the URLs came from the command with the key inside; the key in no file; RPC alerts name the endpoints redacted", urlsHadKey && leaks.length === 0 && named.length > 0 && named.every((a) => !a.message.includes(SECRET)) && w.errors.every((e) => !e.includes(SECRET)) && w.timeline.every((x) => !x.what.includes(SECRET)), `${filesUnder(w.home).length} files scanned, ${leaks.length} with the key${leaks.length ? `: ${leaks.slice(0, 3).join(", ")}` : ""}; ${down.length} RPC alert lines, ${named.length} naming an endpoint, e.g. ${named[0]?.message.slice(0, 140) ?? "-"}`));
          return out;
        },
      },
      (w) => {
        const [a, b] = w.proxies;
        const dn = w.now >= from && w.now < to;
        a!.mode = dn || (w.now >= oneFrom && w.now < oneFrom + 300) ? "error" : "ok";
        b!.mode = dn ? "error" : "ok";
      },
    );
  },
};

/** PRODUCTION (time-warped): a one-hour outage of both URLs from 23:10 to 00:10, over both writers' slice-23 read
 *  seconds: what they read is held, then reposted after the outage, inside the F1 window (CLOSE_GRACE is one slice on
 *  PRODUCTION), so both writers' days are complete and nothing is abandoned. */
const repostOutageProduction: Scenario = {
  name: "repost-outage-production-1h",
  what: "PRODUCTION (time-warped, 60 s steps): both RPC URLs error for one hour, 23:10 to 00:10, over both writers' slice-23 read seconds: both readings held, reposted after the outage before the F1 point (dayEnd + CLOSE_GRACE - margin), both writers complete, nothing abandoned, the day computed; guardian on",
  run: async () => {
    const day0 = 20_727;
    const D = day0 + 1;
    let from = 0;
    let to = 0;
    return runWorld(
      // seeds 7 and 8 put the two slice-23 reads 839 s and 1,319 s into the slice, inside the outage
      { name: "repost-outage-production-1h", profile: PROFILES.PRODUCTION, startTs: day0 * 86_400 + 600, epochTs: 0, epochDay: 0, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World() }, primary: { seed: 7 }, standby: { seed: 8 }, guardian: guard(86_400), step: 60 },
      (w) => {
        from = w.sliceStart(D, 23) + 600;
        to = from + 3_600;
        return w.dayEnd(D) + w.wc.lagMax + 3_600;
      },
      {
        expectAlerts: [AlertCode.RPC_DOWN],
        forbidAlerts: [AlertCode.NONCE_STUCK, AlertCode.GAS_CAP],
        lagFrom: D,
        extra: async (w, ev, days) => {
          const out: Check[] = [];
          const c = w.wc;
          const end = w.dayEnd(D);
          const f1 = end + c.closeGrace - c.margin;
          const posts = ev.filter((e): e is Extract<WallEvent, { name: "ReadingsPosted" }> => e.name === "ReadingsPosted" && e.day === D && e.slice === 23);
          const rows: string[] = [];
          let held = 0;
          for (const e of posts) {
            const t = await eventTime(w, e);
            if (e.readAt >= from && e.readAt < to && t >= to && t <= f1) held++;
            rows.push(`${lc(e.writer) === lc(ADDR[ROLE.primary]!) ? "primary" : "standby"} read ${e.readAt - w.sliceStart(D, 23)} s into slice 23, landed dayEnd + ${t - end} s`);
          }
          out.push(ok("both slice-23 readings held through the outage and reposted after it, before the F1 point", posts.length === 2 && held === 2, `outage ${from - w.sliceStart(D, 23)} s into slice 23 to dayEnd + ${to - end} s, F1 point dayEnd + ${f1 - end} s; ${rows.join("; ")}`));
          const ab = (["primary", "standby"] as const).flatMap((r) => jsonLines<{ kind: string; dayId: number; slice: number; reason: string }>(join(w.home, r, "readings")).filter((l) => l.kind === "abandon").map((l) => `${r} ${l.dayId}/${l.slice} ${l.reason}`));
          out.push(ok("no slice abandoned by either writer", ab.length === 0, ab.join("; ") || "none"));
          const full: string[] = [];
          for (const r of [ROLE.primary, ROLE.standby]) full.push(`${r === ROLE.primary ? "primary" : "standby"} ${new Set(ev.filter((e) => e.name === "ReadingsPosted" && e.day === D && lc((e as { writer: string }).writer) === lc(ADDR[r]!)).map((e) => (e as { slice: number }).slice)).size}/24`);
          const fd = final(days, D);
          out.push(ok("day D computed and complete, both writers' days complete", Boolean(fd?.final && fd.status !== "CARRIED" && !fd.incomplete) && full.every((x) => x.endsWith("24/24")), `${fd?.status} incomplete ${fd?.incomplete} lag ${fd?.lag} s; ${full.join(", ")}`));
          return out;
        },
      },
      (w) => {
        const [a, b] = w.proxies;
        const dn = w.now >= from && w.now < to;
        a!.mode = dn ? "error" : "ok";
        b!.mode = dn ? "error" : "ok";
      },
    );
  },
};

// ------------------------------------------------------------------ KEY_MISMATCH (8.5, R8 (d))

/** A thief holding a copy of the standby's key posts slice 5 of day 2 first, at the slice's start, with its own
 *  values; the honest standby reads its own values later and its post is a duplicate. */
const keyMismatch: Scenario = {
  name: "key-mismatch",
  what: "TEST: a second user of the standby's key posts slice 5 of day 2 first (4.50 everywhere); the standby's own post of that slice is a duplicate; the standby raises KEY_MISMATCH with both sides; the guardian's keycheck confirms it and suspends the standby (R8 (d)); the primary carries on as the source; no false KEY_MISMATCH",
  run: async () => {
    const D = 2;
    const H = 5;
    let posted = 0;
    let txHash = "";
    const errs: string[] = [];
    const bad = [4_500_000, 4_500_000, 4_500_000, 4_500_000, 4_500_000];
    return runWorld(
      { name: "key-mismatch", profile: PROFILES.TEST, startTs: T0, epochDay: OCT1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World() }, primary: {}, standby: {}, guardian: { ...guard(PROFILES.TEST.day), keycheck: true } },
      (w) => w.dayEnd(relDay(w, D + 2)) + 900,
      {
        honest: ["primary"],
        thieves: ["standby"],
        expectAlerts: [AlertCode.KEY_MISMATCH],
        extra: async (w, ev, days) => {
          const out: Check[] = [];
          const d = relDay(w, D);
          const sb = lc(ADDR[ROLE.standby]!);
          const km = w.writers.flatMap((x) => x.alerts.filter((a) => a.code === AlertCode.KEY_MISMATCH).map((a) => ({ role: x.role, a })));
          const mine = km.filter((x) => x.role === "standby");
          const data = mine[0]?.a.data as { gpuId?: string; day?: number; slice?: number; onchain?: { values?: number[]; readAt?: number }; logged?: { values?: number[]; readAt?: number } | null } | undefined;
          out.push(ok("the standby raises KEY_MISMATCH for the stolen slice, with both sides", mine.length > 0 && data?.day === d && data.slice === H && lc(data.gpuId ?? "") === lc(H100) && json(data.onchain?.values) === json(bad) && data.logged !== null && json(data.logged?.values) !== json(bad), `${mine.length} alert(s): day ${data?.day} slice ${data?.slice} onchain ${json(data?.onchain?.values)} readAt ${data?.onchain?.readAt}; logged ${json(data?.logged?.values)} readAt ${data?.logged?.readAt}`));
          out.push(ok("no KEY_MISMATCH for the primary (no false alarm)", km.every((x) => x.role === "standby"), `${km.filter((x) => x.role === "primary").length} for the primary`));
          const acts = w.guardian?.acts ?? [];
          const kc = acts.find((a) => a.act.startsWith("keycheck"));
          const su = acts.find((a) => a.act.startsWith("suspend") && a.detail?.includes("R8 (d)"));
          const confirmed = (w.guardian?.lines ?? []).some((l) => l.includes("confirmed: another party posted"));
          const sus = ev.filter((e): e is Extract<WallEvent, { name: "WriterSuspended" }> => e.name === "WriterSuspended");
          const tx = txHash ? await w.a.pub.getTransaction({ hash: txHash as Hex }) : null;
          out.push(ok("keycheck confirms (the thief's transaction is from the standby's own key), the guardian suspends it", Boolean(kc && kc.code === 0 && confirmed && su && su.code === 0 && sus.length === 1 && lc(sus[0]!.writer) === sb && tx && lc(tx.from) === sb), `keycheck at ${kc?.at} code ${kc?.code} confirmed ${confirmed}; suspend at ${su?.at} code ${su?.code}; WriterSuspended ${sus.map((e) => e.writer).join(", ")}; thief tx from ${tx?.from} (posted at ${posted})`));
          const fd = final(days, d);
          out.push(ok("day D: the primary's record, the stolen values never final", Boolean(fd?.final && lc(fd.source) === lc(ADDR[ROLE.primary]!) && fd.value === 3_400_000), `${fd?.status} ${fd?.value} from ${fd?.source}`));
          const skips = await w.a.pub.getLogs({ address: w.dep.index, event: { type: "event", name: "EntrySkipped", inputs: [{ name: "gpuId", type: "bytes32", indexed: true }, { name: "day", type: "uint32", indexed: true }, { name: "writer", type: "address", indexed: true }, { name: "slice", type: "uint8", indexed: false }, { name: "reason", type: "uint8", indexed: false }] }, fromBlock: w.dep.fromBlock });
          const dup = skips.filter((l) => { const a = (l as unknown as { args: { day: number; slice: number; reason: number; writer: string } }).args; return Number(a.day) === d && Number(a.slice) === H && Number(a.reason) === 7 && lc(a.writer) === sb; });
          out.push(ok("the standby's own post of that slice is a duplicate (E7)", dup.length >= 1, `${dup.length} E7 skip(s) for the standby on ${d}/${H}`));
          if (errs.length) out.push(ok("thief post", false, errs.join("; ")));
          return out;
        },
      },
      async (w) => {
        const d = relDay(w, D);
        const s = w.sliceStart(d, H);
        if (posted || w.now < s) return;
        try {
          const entries = [{ gpuId: H100, dayId: d, slice: H, readAt: BigInt(Math.max(s, w.now - 1)), values: bad }];
          const report = reportHex(SELECTOR, w.dep.index, entries);
          const before = await w.a.pub.getBlockNumber();
          await send(w.a, ROLE.standby, "postReport", [report], w.dep.index);
          const blk = await w.a.pub.getBlock({ blockNumber: before + 1n });
          txHash = String(blk.transactions[0] ?? "");
          posted = w.now;
          w.note(`thief posted ${d}/${H} with the standby's key`);
        } catch (e) {
          errs.push(e instanceof Error ? e.message.split("\n")[0]! : String(e));
          posted = -1;
        }
      },
    );
  },
};

// ------------------------------------------------------------------ the page check (15.1)

const iso = (t: number) => new Date(t * 1000).toISOString();

function geRow(provider_id: string, usd: string, extra: Record<string, unknown> = {}) {
  return { provider_id, price_type: "on_demand", status: "live", usd_per_gpu_hour: usd, gpu_count: 8, listed_since: "2026-09-01T00:00:00Z", ...extra };
}

/** GPU Economy's H100 file per demo day (synthetic numbers in its field names): Verda absent (GPUTable fallback),
 *  Nebius one half-day late on its step, Lambda 3.90 against the page's 3.40 from day 1 to day 4, Civo exactly 10%
 *  above its page (not a gap), Hyperstack absent and its GPUTable H100 row excluded, a Runpod row and a spot row. */
function pagecheckTrackers(updatedAt: number): TrackerScript {
  const ge = (nebius: string, lambda: string) => ({
    data_updated_at: iso(updatedAt),
    prices: [
      geRow("nebius", nebius),
      geRow("lambda", lambda),
      geRow("lambda", "0.99", { price_type: "spot" }),
      geRow("civo", "4.00"),
      geRow("runpod", "1.99"),
      geRow("coreweave", "6.16"),
    ],
  });
  const gt = {
    generated_at: iso(updatedAt),
    data: [
      { provider: "Verda", gpu: "H100 SXM", gpu_count: 8, price_per_hour_usd: 3.0, pricing_type: "on_demand", commitment_months: null },
      { provider: "Verda", gpu: "H100 SXM", gpu_count: 8, price_per_hour_usd: 2.1, pricing_type: "reserved", commitment_months: 12 },
      { provider: "Hyperstack", gpu: "H100 SXM", gpu_count: 8, price_per_hour_usd: 2.4, pricing_type: "on_demand", commitment_months: null },
      { provider: "Together AI", gpu: "H100 SXM", gpu_count: 8, price_per_hour_usd: 9.99, pricing_type: "on_demand", commitment_months: null },
      { provider: "RunPod", gpu: "H100 SXM", gpu_count: 8, price_per_hour_usd: 1.99, pricing_type: "on_demand", commitment_months: null },
    ],
  };
  return {
    gpuEconomy: {
      "h100-sxm": [
        { from: { day: 0 }, body: ge("3.20", "3.40") },
        { from: { day: 1 }, body: ge("3.20", "3.90") },
        { from: { day: 2, slice: 2 }, body: ge("3.70", "3.90") },
        { from: { day: 4 }, body: ge("3.70", "3.40") },
      ],
    },
    gputable: [{ from: { day: 0 }, body: gt }],
  };
}

const pagecheckScenario: Scenario = {
  name: "pagecheck-review-fault",
  what: "DEMO with the page check on the replay's tracker routes: Lambda's tracker row 3.90 against its page's 3.40 from day 1 to day 4 (REVIEW, then a likely parser fault after one DAY, both cleared when it agrees again), Nebius's tracker half a day late on a page step (REVIEW only, cleared), Civo exactly 10% off (no alert), Verda from the GPUTable fallback, Hyperstack's GPUTable H100 row excluded, Runpod, Together and spot rows ignored; never in the price path",
  run: async () =>
    runWorld(
      { name: "pagecheck-review-fault", profile: PROFILES.DEMO, startTs: T0, epochDay: NOV1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World({ 1: [{ from: { day: 2 }, ...p("3.70") }] }), trackers: pagecheckTrackers(T0) }, primary: {}, standby: {}, guardian: guard(PROFILES.DEMO.day), pagecheck: true },
      (w) => w.dayEnd(relDay(w, 5)) + 300,
      {
        expectAlerts: [AlertCode.PAGECHECK_REVIEW, AlertCode.PAGECHECK_FAULT],
        forbidAlerts: [AlertCode.PAGECHECK_TRACKERS_DOWN],
        extra: async (w, _ev, days) => {
          const out: Check[] = [];
          const al = readAlerts(w);
          const slotOf = (a: { data?: unknown }) => (a as { slot?: number }).slot;
          const rv = al.filter((a) => a.code === AlertCode.PAGECHECK_REVIEW);
          const ft = al.filter((a) => a.code === AlertCode.PAGECHECK_FAULT);
          const k = (day: number, h = 0) => (day * w.wc.day + h * w.wc.slice) / w.wc.slice; // interval of a demo day's slice
          const lamRv = rv.filter((a) => slotOf(a) === 2);
          const lamFt = ft.filter((a) => slotOf(a) === 2);
          const ftK = (lamFt[0]?.data as { k?: number; runStartK?: number; gapped?: number } | undefined) ?? {};
          out.push(ok("Lambda: REVIEW on the first gap, FAULT after one DAY with MIN_READINGS gaps, both cleared on day 4", lamRv.length > 0 && (lamRv[0]!.data as { k?: number }).k === k(1) && lamFt.length > 0 && ftK.runStartK === k(1) && (ftK.k ?? 0) - k(1) >= w.wc.slices && (ftK.gapped ?? 0) >= w.wc.minReadings && lamRv.some((a) => (a.cleared ?? 0) >= w.dayStart(relDay(w, 4))) && lamFt.some((a) => (a.cleared ?? 0) >= w.dayStart(relDay(w, 4))), `review at interval ${(lamRv[0]?.data as { k?: number } | undefined)?.k} (day 1 starts at ${k(1)}); fault at ${ftK.k}, run from ${ftK.runStartK}, ${ftK.gapped} gapped; cleared at ${lamFt.find((a) => a.cleared !== undefined)?.cleared} (day 4 starts ${w.dayStart(relDay(w, 4))})`));
          const nebRv = rv.filter((a) => slotOf(a) === 1);
          out.push(ok("Nebius: REVIEW while its tracker lags the page step, cleared when it catches up; no FAULT", nebRv.length > 0 && (nebRv[0]!.data as { k?: number }).k === k(2) && nebRv.some((a) => a.cleared !== undefined) && !ft.some((a) => slotOf(a) === 1), `review at ${(nebRv[0]?.data as { k?: number } | undefined)?.k} (day 2 starts at ${k(2)}), cleared ${nebRv.some((a) => a.cleared !== undefined)}`));
          out.push(ok("no alert for Verda (fallback agrees), Civo (exactly 10%) or Hyperstack (excluded)", ![0, 3, 4].some((s) => rv.some((a) => slotOf(a) === s) || ft.some((a) => slotOf(a) === s)), `review slots ${[...new Set(rv.map(slotOf))].join(", ")}; fault slots ${[...new Set(ft.map(slotOf))].join(", ")}`));
          const cmp = jsonLines<{ k: number; sourceId: string; tracker: string; fallback?: string; gapBps: number; gap: boolean; own: number; t: number }>(join(w.home, "pagecheck", index8(w.dep.index)));
          const by = (id: string) => cmp.filter((c) => c.sourceId === id);
          const verda = by("p_verda");
          const civo = by("p_civo");
          out.push(ok("compare lines: Verda from GPUTable (no GPU Economy row), Civo at exactly 1000 bps and no gap, Hyperstack never compared", verda.length > 0 && verda.every((c) => c.tracker === "gputable" && c.fallback === "no-row" && !c.gap) && civo.length > 0 && civo.every((c) => c.gapBps === 1000 && !c.gap) && by("p_hyperstack").length === 0, `${cmp.length} lines: Verda ${verda.length} (${verda[0]?.tracker} ${verda[0]?.fallback}), Civo ${civo.length} (${civo[0]?.gapBps} bps), Hyperstack ${by("p_hyperstack").length}, Lambda gapped ${by("p_lambda").filter((c) => c.gap).length}`));
          const st = JSON.parse(readFileSync(join(w.home, "pagecheck", index8(w.dep.index), "status.json"), "utf8")) as { pairs: { sourceId: string; state: string }[] };
          out.push(ok("status.json at the end: every compared pair ok", st.pairs.filter((x) => x.sourceId !== "p_hyperstack").every((x) => x.state === "ok"), st.pairs.map((x) => `${x.sourceId} ${x.state}`).join(", ")));
          out.push(ok("never in the price path: day 2's fix follows Nebius's page, not its tracker", final(days, relDay(w, 2))?.value === 3_600_000, `day ${relDay(w, 2)}: ${final(days, relDay(w, 2))?.value}`));
          return out;
        },
      },
    ),
};

// ------------------------------------------------------------------ the repair loop on the wall (15.2 to 15.4, 4.15)

type Registry = Record<string, { sourceId: string; extract: Extractor }>;

/** `repair install`, in memory: the draft file the note names (its sha256 checked), loaded from a copy whose one
 *  value import points at the sources package (its type imports are erased), and added to the parser registry. */
async function installDraft(w: World, draftFile: string, version: string, sha: string): Promise<() => void> {
  const src = readFileSync(draftFile, "utf8");
  if (new Bun.CryptoHasher("sha256").update(src).digest("hex") !== sha) throw new Error("the draft differs from the note");
  const copy = join(w.home, "installed", `${version.replace("/", ".v")}.ts`);
  mkdirSync(join(w.home, "installed"), { recursive: true });
  writeFileSync(copy, src.replace('from "../text.ts"', `from ${JSON.stringify(join(ROOT, "wall/packages/sources/src/pure/text.ts"))}`));
  const m = (await import(copy)) as { extract: Extractor };
  const reg = EXTRACTORS_BY_VERSION as Registry;
  reg[version] = { sourceId: "p_lambda", extract: m.extract };
  return () => void delete reg[version];
}

const repairLoop: Scenario = {
  name: "repair-loop",
  needsSandbox: true,
  what: "DEMO with the page check and the repair agent beside the wall (a fake Claude CLI answering the canned good draft; the real tsc and sandbox): Lambda's page redesigned from demo day 2; the agent opens a reader incident from the watcher's own log and raw pages, drafts lambda/2, gates it on the saved pages and the page check's saved trackers, shadows it and writes the approval note and owner action file; the harness, as the operator, installs exactly that draft (in memory) and queues the action file's swap; executed at eta, the wall reads with it from fromDay and the incident closes",
  run: async () => {
    const R = 2;
    const scripted = h100World();
    scripted.p_lambda!.page = [{ from: { day: R }, state: "redesigned" }];
    const ge = { data_updated_at: iso(T0), prices: [geRow("datacrunch", "3.00"), geRow("nebius", "3.20"), geRow("lambda", "3.40"), geRow("civo", "3.60"), geRow("hyperstack", "3.80")] };
    let agent: RepairAgent | null = null;
    let cfg: ReturnType<typeof repairConfig> | null = null;
    let fake: ReturnType<typeof fakeClaude> | null = null;
    let action: { file: string; incident: string; actions: { kind: string; gpuId: Hex; slot: number; url: string; parserVersion: string; reason: string }[]; draft?: { path: string; sha256: string; version?: string } } | null = null;
    let queuedAt = 0;
    let eta = 0;
    let executedAt = 0;
    let fromDay = 0;
    const errs: string[] = [];
    return runWorld(
      {
        name: "repair-loop",
        profile: PROFILES.DEMO,
        startTs: T0,
        epochDay: NOV1,
        gpus: [{ gpu: "H100" }],
        scenario: { archive: false, scripted, trackers: { gpuEconomy: { "h100-sxm": [{ from: { day: 0 }, body: ge }] } } },
        primary: {},
        standby: {},
        guardian: guard(PROFILES.DEMO.day),
        pagecheck: true,
        writeRaw: true,
        setup: async (w) => {
          const dir = join(w.home, "fake-claude");
          mkdirSync(dir, { recursive: true });
          fake = fakeClaude(dir);
          writeFileSync(fake.answerFile, cliOutput({ diagnosis: "redesign", extractorSource: GOOD_V2, notes: "The page now shows one card per GPU; read the on-demand card." }));
          const panelsFile = join(w.home, "panels-repair.json");
          writeFileSync(panelsFile, JSON.stringify({ panels: w.dep.panels }));
          const rawDir = join(w.home, "logger-archive-none");
          mkdirSync(rawDir, { recursive: true });
          // the agent's own environment holds no key (it refuses one) and no RPC URL list
          cfg = repairConfig({ AGATE_WALL_HOME: w.home, AGATE_INDEXES: lc(w.dep.index), AGATE_PANELS: panelsFile, AGATE_RAW_DIR: rawDir, AGATE_CLAUDE_BIN: fake.bin, AGATE_REPAIR_NOTIFY: "0", AGATE_REPO: ROOT });
          const c = cfg;
          const sinks = new Map<string, AlertSink>();
          const sink = (index: string | null) => {
            const k = index ?? "";
            let x = sinks.get(k);
            if (!x) sinks.set(k, (x = new AlertSink(join(w.home, "alerts", "alerts.jsonl"), { now: () => w.now, role: "repair", print: false, ...(index ? { index } : {}) })));
            return x;
          };
          agent = new RepairAgent({ cfg: c, spawner: new Spawner({ claude: c.claudeBin, sandbox: c.sandboxExec, bun: c.bun, tsc: c.tsc, osascript: c.osascript }), env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", USER: "operator", LANG: "C", TMPDIR: process.env.TMPDIR ?? "/tmp" }, now: () => w.now, sink, chain: (ix) => viemChain(ix as Hex, w.rpcUrls) });
        },
      },
      (w) => w.dayEnd(relDay(w, R + 7)) + 300,
      {
        extra: async (w, ev, days) => {
          const out: Check[] = [];
          const incs = agent!.store.all().filter((x) => x.sourceId === "p_lambda");
          const inc = incs[0];
          out.push(ok("a reader incident from the watcher's log, diagnosed as a redesign", Boolean(inc && inc.kind === "reader" && inc.diagnosis?.kind === "redesign" && inc.sinceK === R * w.wc.slices), `${incs.length} Lambda incident(s): ${inc ? `${inc.kind} since interval ${inc.sinceK} (day ${relDay(w, R)} starts at ${R * w.wc.slices}), diagnosis ${inc.diagnosis?.kind}, ${inc.calls} Claude call(s), status ${inc.status}` : "none"}`));
          const rec = existsSync(fake!.rec) ? readFileSync(fake!.rec, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { env: Record<string, string>; stdin: string }) : [];
          const leaked = rec.flatMap((r) => Object.keys(r.env).filter((k) => /KEY|RPC|AGATE_/.test(k)));
          out.push(ok("one Claude call (the fixture), the redesigned page as untrusted input, no key or RPC variable in its environment", rec.length === 1 && rec[0]!.stdin.includes('class="gpu-cards"') && rec[0]!.stdin.includes("<<<PAGE id=") && leaked.length === 0, `${rec.length} call(s); env keys leaked: ${leaked.join(", ") || "none"}`));
          const gates = inc?.draftId ? JSON.parse(readFileSync(join(cfg!.dir, "drafts", inc.draftId, "gates.json"), "utf8")) as { version: string; gates: Record<string, unknown> } : null;
          out.push(ok("the draft passed the five gates on the watcher's saved pages and the page check's trackers", Boolean(gates && gates.version === LAMBDA_V2 && Object.keys(gates.gates).length === 5), `${gates ? `${gates.version}: ${Object.keys(gates.gates).join(", ")}` : "no gates file"}`));
          const a0 = action?.actions[0];
          const contractId = a0 ? await read<Hex>(w.a, w.dep.index, "readerSwapId", [a0.gpuId, a0.slot, { url: a0.url, parserVersion: a0.parserVersion }]) : "0x";
          const queued = ev.filter((e): e is Extract<WallEvent, { name: "ReaderSwapQueued" }> => e.name === "ReaderSwapQueued");
          out.push(ok("the note's action file names the H100 Lambda slot with lambda/2; the agent's swap id is the contract's and the queued one", Boolean(a0 && action!.actions.length === 1 && a0.kind === "READER" && lc(a0.gpuId) === lc(H100) && a0.slot === 2 && a0.parserVersion === LAMBDA_V2 && repairSwapId(a0.gpuId, a0.slot, a0.url, a0.parserVersion) === contractId && queued.length === 1 && lc(queued[0]!.id) === lc(contractId)), a0 ? `${a0.kind} gpu ${a0.gpuId.slice(0, 10)} slot ${a0.slot} ${a0.url} ${a0.parserVersion}, reason "${a0.reason}"; id ${contractId.slice(0, 10)}, queued ${queued.length}` : "no action file"));
          const al = readAlerts(w);
          const note = al.filter((x) => x.code === "REPAIR_NOTE");
          const incAlert = al.filter((x) => x.code === "REPAIR_INCIDENT");
          out.push(ok("REPAIR_INCIDENT and REPAIR_NOTE raised, both cleared once the incident closed", note.length > 0 && note.some((x) => x.cleared !== undefined) && incAlert.length > 0 && incAlert.some((x) => x.cleared !== undefined) && inc?.status === "closed", `note ${note.length} line(s), incident ${incAlert.length} line(s); status ${inc?.status}`));
          const swapped = ev.find((e): e is Extract<WallEvent, { name: "ReaderSwapped" }> => e.name === "ReaderSwapped");
          const at = swapped ? await eventTime(w, swapped) : 0;
          out.push(ok("executed at eta, effective from the next day start", Boolean(swapped && at >= eta && at - eta <= w.step && fromDay === w.dayAt(at + w.wc.slice) + 1), `queued ${queuedAt}, eta ${eta}, executed ${at}, fromDay ${fromDay}`));
          const wl = jsonLines<WatchLine>(join(w.watcherDir, "log")).filter((l) => l.sourceId === "p_lambda" && l.attempts > 0 && w.dep.epochDay + Math.floor(l.interval / w.wc.slices) >= fromDay);
          out.push(ok("the watcher reads Lambda with the installed draft from fromDay", wl.length > 0 && wl.every((l) => l.parsers?.H100 === LAMBDA_V2 && l.gpus.H100?.state === "VALID" && l.gpus.H100.valueU === 3_400_000), `${wl.length} lines from day ${fromDay}`));
          const f = final(days, fromDay);
          out.push(ok("the fix of fromDay is computed with Lambda back in", Boolean(f?.final && f.status !== "CARRIED" && f.value === 3_400_000), `${f?.status} ${f?.value}`));
          if (errs.length) out.push(ok("harness", false, errs.join("; ")));
          return out;
        },
      },
      async (w) => {
        try {
          await agent!.tick(w.now);
          if (!action) {
            const dir = join(cfg!.dir, "actions");
            const f = existsSync(dir) ? readdirSync(dir).find((x) => x.endsWith(".json")) : undefined;
            if (!f) return;
            const file = join(dir, f);
            const j = JSON.parse(readFileSync(file, "utf8")) as { actions: NonNullable<typeof action>["actions"] };
            const inc = agent!.store.all().find((x) => f.startsWith(x.id));
            const n = inc ? (JSON.parse(readFileSync(join(cfg!.dir, "notes", `${inc.id}.json`), "utf8")) as { draft?: { path: string; sha256: string } }) : {};
            action = { file, incident: inc?.id ?? "", actions: j.actions, ...(n.draft ? { draft: n.draft } : {}) };
            // the operator: repair install (in memory here), test and commit, restart; then queue exactly the action file's swaps
            if (!action.draft) throw new Error("the note names no draft");
            const un = await installDraft(w, action.draft.path, LAMBDA_V2, action.draft.sha256);
            w.cleanups.push(un);
            for (const a of action.actions) await send(w.a, ROLE.owner, "queueReaderSwap", [a.gpuId, a.slot, { url: a.url, parserVersion: a.parserVersion }, a.reason], w.dep.index);
            queuedAt = w.now;
            const a0 = action.actions[0]!;
            eta = Number(await read<bigint>(w.a, w.dep.index, "queuedEta", [repairSwapId(a0.gpuId, a0.slot, a0.url, a0.parserVersion)]));
            w.note(`queued the note's swap, eta ${eta}`);
          } else if (!executedAt && w.now >= eta) {
            for (const a of action.actions) await send(w.a, ROLE.owner, "executeReaderSwap", [a.gpuId, a.slot, { url: a.url, parserVersion: a.parserVersion }], w.dep.index);
            executedAt = w.now;
            const a0 = action.actions[0]!;
            const h = await read<{ fromDay: number }[]>(w.a, w.dep.index, "readerHistory", [a0.gpuId, a0.slot]);
            fromDay = Number(h.at(-1)?.fromDay ?? 0);
            const rel = fromDay - w.dep.epochDay;
            w.truth.readsRedesign = (id, gpu, replayDay) => id === "p_lambda" && gpu === "H100" && replayDay >= rel;
          }
        } catch (e) {
          errs.push(`${w.now}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
        }
      },
    );
  },
};

// ------------------------------------------------------------------ two indexes side by side (13.7)

const PLACEHOLDER = /__([A-Z0-9_]+)__/g;

/** Fills a launchd template the way the operator does (every placeholder), for one index and role. */
function renderPlist(file: string, v: Record<string, string>): string {
  return readFileSync(join(ROOT, file), "utf8").replace(PLACEHOLDER, (_m, k: string) => v[k] ?? `x-${k.toLowerCase()}`);
}

function plistField(xml: string, key: string): string | undefined {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1];
}

const twoIndexes: Scenario = {
  name: "two-indexes",
  what: "a DEMO index and a TEST index on one chain and one AGATE_WALL_HOME with the same seven keys, stepped together (each index's writers down for one day, so each keeper closes and carries): both indexes' days final, the shared attester, keeper and writer keys used for both with no nonce reuse (the per-key send lock), separate decisions files and guardian logs, writer alerts stamped with their index, distinct launchd Labels and log paths per index",
  run: async () => {
    const t0 = Date.now();
    const a = await World.create({ name: "two-indexes-demo", profile: PROFILES.DEMO, startTs: T0, epochDay: NOV1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World({ 2: [{ from: { day: 3 }, ...p("3.50") }] }) }, primary: {}, standby: {}, guardian: guard(PROFILES.DEMO.day) });
    let b: World | null = null;
    try {
      b = await World.create({ name: "two-indexes-test", profile: PROFILES.TEST, startTs: T0, epochDay: OCT1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World({ 2: [{ from: { day: 1 }, ...p("3.50") }] }) }, primary: {}, standby: {}, guardian: guard(PROFILES.TEST.day), chain: { a: a.a, proxies: a.proxies }, home: a.home });
      const B = b;
      // both writers of each index are down for one whole day, so each index's keeper must close and carry (the
      // keeper key then serves both indexes too)
      for (const [w, k] of [[a, 4], [B, 1]] as const) {
        const from = w.dayStart(relDay(w, k));
        const to = w.dayEnd(relDay(w, k));
        w.down = (pp, t) => (pp === "primary" || pp === "standby") && t >= from && t < to;
      }
      const looked = new Set<string>();
      const until = B.dayEnd(relDay(B, 3)) + 900;
      await World.runTogether([a, B], until, async () => {
        // the operator takes one look per index (its own guardian log)
        for (const w of [a, B]) {
          if (looked.has(w.dep.index) || w.now < w.dayStart(relDay(w, 1)) + w.wc.slice) continue;
          looked.add(w.dep.index);
          await w.guardian!.cli(["look", "H100", "--region", "writer"]);
        }
      });
      const ra = await judge(a, {});
      const rb = await judge(B, {});
      const checks: Check[] = [...ra.checks.map((c) => ({ ...c, name: `DEMO ${c.name}` })), ...rb.checks.map((c) => ({ ...c, name: `TEST ${c.name}` }))];
      // keys: the attester and the keeper sent to both indexes; every nonce mined once, none left pending
      const latest = await a.a.pub.getBlockNumber();
      const sent = new Map<string, { to: Set<string>; nonces: number[] }>();
      for (let n = a.dep.fromBlock; n <= latest; n++) {
        const blk = await a.a.pub.getBlock({ blockNumber: n, includeTransactions: true });
        for (const tx of blk.transactions) {
          const s = sent.get(lc(tx.from)) ?? { to: new Set(), nonces: [] };
          s.to.add(lc(tx.to ?? ""));
          s.nonces.push(Number(tx.nonce));
          sent.set(lc(tx.from), s);
        }
      }
      const keyRows: string[] = [];
      let keysOk = true;
      for (const [name, r] of [["attester", ROLE.attester], ["keeper", ROLE.keeper], ["primary", ROLE.primary], ["standby", ROLE.standby]] as const) {
        const s = sent.get(lc(ADDR[r]!));
        const both = Boolean(s?.to.has(lc(a.dep.index)) && s?.to.has(lc(B.dep.index)));
        const sorted = [...(s?.nonces ?? [])].sort((x, y) => x - y);
        const unique = new Set(sorted).size === sorted.length;
        const pending = await a.a.pub.getTransactionCount({ address: ADDR[r]!, blockTag: "pending" });
        const mined = await a.a.pub.getTransactionCount({ address: ADDR[r]! });
        if (!both || !unique || pending !== mined) keysOk = false;
        keyRows.push(`${name}: ${sorted.length} txs to ${both ? "both indexes" : "ONE index"}, nonces ${unique ? "unique" : "REUSED"}, pending ${pending - mined}`);
      }
      const nonceAlerts = [...readAlerts(a)].filter((x) => x.code === AlertCode.NONCE_STUCK || /nonce/i.test(x.message));
      const timelineNonce = [...a.timeline, ...B.timeline].filter((x) => /nonce too low|replacement transaction underpriced|already known/i.test(x.what));
      checks.push(ok("the shared keys served both indexes, no nonce reused or left pending", keysOk && nonceAlerts.length === 0 && timelineNonce.length === 0, `${keyRows.join("; ")}; ${nonceAlerts.length} nonce alert(s), ${timelineNonce.length} nonce error(s)`));
      // 13.7: per-index decisions and guardian logs, nothing in the old shared files
      const da = decisionsPath(a.home, a.dep.index);
      const db = decisionsPath(B.home, B.dep.index);
      const daDays = jsonLines<{ day: number }>(join(a.home, "attester")).length;
      const linesOf = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { day: number }) : []);
      const la = linesOf(da);
      const lb = linesOf(db);
      const inA = la.every((x) => x.day >= NOV1 && x.day < NOV1 + 40);
      const inB = lb.every((x) => x.day >= OCT1 && x.day < OCT1 + 10);
      checks.push(ok("decisions per index (decisions-<index8>.jsonl), each holding only its own days", la.length > 0 && lb.length > 0 && inA && inB && !existsSync(join(a.home, "attester", "decisions.jsonl")) && da !== db, `${da.split("/").pop()} ${la.length} lines (days ${Math.min(...la.map((x) => x.day))} to ${Math.max(...la.map((x) => x.day))}), ${db.split("/").pop()} ${lb.length} lines (days ${Math.min(...lb.map((x) => x.day))} to ${Math.max(...lb.map((x) => x.day))}); ${daDays} lines in all attester files`));
      const ga = join(guardianLogDir(a.home, a.dep.index), "looks.jsonl");
      const gb = join(guardianLogDir(B.home, B.dep.index), "looks.jsonl");
      const lookA = linesOf(ga).length;
      const lookB = linesOf(gb).length;
      checks.push(ok("guardian logs per index (guardian/<index>/), none in the old shared folder", lookA > 0 && lookB > 0 && !existsSync(join(a.home, "guardian", "looks.jsonl")), `${ga.replace(a.home, "~home")}: ${lookA} looks; ${gb.replace(a.home, "~home")}: ${lookB} looks`));
      // writer alerts carry their index (two writers of one role share the file)
      const wAlerts = readAlerts(a).filter((x) => (x as { writer?: string }).writer !== undefined && ["WRITER_GAP", "KEY_MISMATCH", "KEY_UNVERIFIED", "READER_MISSING", "CLOCK_JUMP", "RPC_FAILOVER"].includes(x.code));
      const stamped = wAlerts.filter((x) => [lc(a.dep.index), lc(B.dep.index)].includes(lc((x as { index?: string }).index ?? "")));
      checks.push(ok("writer alerts stamped with their index", stamped.length === wAlerts.length, `${stamped.length} of ${wAlerts.length} writer alert lines carry an index`));
      // launchd: every per-index template gives distinct Labels and log paths per index
      const plists: string[] = [];
      const labels = new Map<string, string>();
      const logs = new Set<string>();
      let dup = 0;
      const outDir = join(a.home, "launchd-rendered");
      mkdirSync(outDir, { recursive: true });
      for (const w of [a, B]) {
        const v = { INDEX8: index8(w.dep.index), INDEX: w.dep.index, HOME: "/Users/operator" };
        const files: [string, Record<string, string>][] = [
          ...["log", "attest", "keep", "health"].map((role) => ["wall/apps/watcher/launchd/xyz.s0nderlabs.agate-watcher.plist.template", { ...v, ROLE: role }] as [string, Record<string, string>]),
          ["wall/apps/writer-standby/launchd/xyz.s0nderlabs.agate-writer-standby.plist.template", v],
          ["wall/apps/writer-cre/launchd/xyz.s0nderlabs.agate-writer-primary.plist.template", v],
          ["wall/apps/pagecheck/launchd/xyz.s0nderlabs.agate-pagecheck.plist.template", v],
        ];
        for (const [f, vals] of files) {
          const xml = renderPlist(f, vals);
          const label = plistField(xml, "Label") ?? "";
          if (labels.has(label)) dup++;
          labels.set(label, f);
          for (const k of ["StandardOutPath", "StandardErrorPath"]) {
            const pth = plistField(xml, k) ?? "";
            if (logs.has(pth)) dup++;
            logs.add(pth);
          }
          if (!label.endsWith(index8(w.dep.index)) && !label.includes(`-${index8(w.dep.index)}`)) dup++;
          const out = join(outDir, `${label}.plist`);
          writeFileSync(out, xml);
          plists.push(out);
        }
      }
      const lint = Bun.spawnSync(["plutil", "-lint", ...plists]);
      checks.push(ok("launchd: Labels and log paths distinct per index and role, every rendered plist valid", dup === 0 && lint.exitCode === 0 && labels.size === 14, `${labels.size} Labels (e.g. ${[...labels.keys()].slice(0, 2).join(", ")}), ${logs.size} log paths, ${dup} clash(es); plutil -lint exit ${lint.exitCode}`));
      const report: RunReport = {
        name: "two-indexes",
        profile: "DEMO+TEST",
        ok: checks.every((c) => c.ok),
        checks,
        days: [...ra.days, ...rb.days],
        alertCounts: ra.alertCounts,
        guardianActs: [...ra.guardianActs, ...rb.guardianActs],
        timeline: [...ra.timeline, ...rb.timeline].slice(-80),
        errors: [...ra.errors, ...rb.errors],
        stats: { demoDays: ra.days.length, testDays: rb.days.length, demoComputed: ra.stats.computedFinal!, testComputed: rb.stats.computedFinal!, wallMs: Date.now() - t0, home: a.home },
      };
      return report;
    } finally {
      b?.stop();
      a.stop();
    }
  },
};

// ------------------------------------------------------------------ CoreWeave in the launch panel (7.10)

const coreweave: Scenario = {
  name: "coreweave-launch-panel",
  what: "FAST, the launch panel (panels/launch.json, --include-over-cap) on the Oct 2 00 to 17 UTC archive hours, six GPUs: H100 5 live with CoreWeave and Hyperstack the reserve, H200 and B200 5 live each, B300 3 live with Hyperstack the reserve, A100 3 live (CoreWeave among them) with Hyperstack the reserve, L40S 3 live (CoreWeave among them); both writers and the watcher read CoreWeave's real archived page; every fix equals the honest reference; the page check runs beside it on the archived GPUTable file (GPU Economy is not archived: the fallback by design), its alerts reported, not judged",
  needsArchive: true,
  run: async () => {
    // Oct 2 00 to 17 UTC: no real price change inside the window (Verda moved at 18 UTC). On FAST one index day
    // replays a whole archive day, so a real change can fall between a writer's and the watcher's read of one slice
    // (a replay artifact, reported in integration.md); this run keeps to a window without one
    const view = archiveView((date, hour) => date === "2026-10-02" && Number(hour) <= 17);
    return runWorld(
      { name: "coreweave-launch-panel", profile: PROFILES.FAST, startTs: T0, epochDay: NOV1, gpus: GPUS.map((gpu) => ({ gpu })), scenario: demoScenario(), rawDir: view.rawDir, primary: { viaForwarder: true }, standby: {}, guardian: GUARD, panelsFile: LAUNCH_PANELS_FILE, pagecheck: true },
      (w) => w.dayEnd(relDay(w, 10)) + 30,
      {
        forbidAlerts: [AlertCode.R1_NO_CANDIDATE, AlertCode.GAS_CAP, AlertCode.NONCE_STUCK, AlertCode.CLOCK_SKEW, AlertCode.RPC_DOWN],
        extra: async (w, ev, days) => {
          const out: Check[] = [];
          const NEVER = 0xffffffff;
          const want: Record<string, { live: number; reserve: string[] }> = {
            H100: { live: 5, reserve: ["p_hyperstack"] },
            H200: { live: 5, reserve: [] },
            B200: { live: 5, reserve: [] },
            B300: { live: 3, reserve: ["p_hyperstack"] }, // no CoreWeave slot: its B300 is "Contact sales"
            A100: { live: 3, reserve: ["p_hyperstack"] },
            L40S: { live: 3, reserve: [] },
          };
          const rows: string[] = [];
          let shapeOk = true;
          for (const pnl of w.panels) {
            let live = 0;
            const reserve: string[] = [];
            for (let i = 0; i < pnl.sources.length; i++) {
              const [lf] = await read<[number, number]>(w.a, w.dep.index, "slotWindow", [pnl.gpuId, i]);
              if (Number(lf) === NEVER) reserve.push(pnl.sources[i]!);
              else live++;
            }
            const cw = pnl.sources.indexOf("p_coreweave");
            const posted = ev.filter((e): e is Extract<WallEvent, { name: "ReadingsPosted" }> => e.name === "ReadingsPosted" && lc(e.gpuId) === lc(pnl.gpuId));
            const withCw = posted.filter((e) => (e.values[cw] ?? 0) > 0);
            const byRole = new Set(withCw.map((e) => lc(e.writer)));
            const g = want[pnl.gpu]!;
            const cwWanted = pnl.gpu !== "B300";
            if (live !== g.live || json(reserve) !== json(g.reserve) || (cw >= 0) !== cwWanted || (cwWanted && (byRole.size !== 2 || withCw.length < posted.length / 2)) || posted.length === 0) shapeOk = false;
            rows.push(`${pnl.gpu}: ${live} live (${pnl.sources.filter((s) => !reserve.includes(s)).join(", ")}), reserve ${reserve.join(", ") || "none"}; ${cw >= 0 ? `CoreWeave slot ${cw} in ${withCw.length}/${posted.length} posts from ${byRole.size} writer(s), e.g. ${(withCw[0]?.values[cw] ?? 0) / 1e6}` : `no CoreWeave slot, ${posted.length} posts`}`);
          }
          out.push(ok("the launch panel onchain and CoreWeave read by both writers", shapeOk, rows.join("; ")));
          const wl = jsonLines<WatchLine>(join(w.watcherDir, "log")).filter((l) => l.sourceId === "p_coreweave" && l.attempts > 0);
          const priced: GpuModel[] = ["H100", "H200", "B200", "A100", "L40S"];
          const valid = wl.filter((l) => priced.every((g) => l.gpus[g]?.state === "VALID") && l.gpus.B300?.state === "NOT_RENTABLE");
          out.push(ok("the watcher reads CoreWeave's page for all six GPUs", wl.length > 0 && valid.length === wl.length, `${valid.length}/${wl.length} intervals VALID for H100, H200, B200, A100 and L40S, B300 NOT_RENTABLE ("Contact sales")`));
          const meds = GPUS.map((g) => {
            const xs = days.filter((x) => x.gpu === g && x.final && x.status !== "CARRIED");
            return `${g} ${xs.length} computed days, last ${((xs.at(-1)?.value ?? 0) / 1e6).toFixed(2)}`;
          });
          const perGpu = GPUS.every((g) => days.filter((x) => x.gpu === g && x.final && x.status !== "CARRIED").length >= 8);
          out.push(ok("fixes computed on the launch sets of all six GPUs", perGpu, meds.join("; ")));
          const al = readAlerts(w);
          const cmp = jsonLines<{ sourceId: string; gpu: string; gap: boolean; gapBps: number; tracker: string }>(join(w.home, "pagecheck", index8(w.dep.index)));
          const gaps = cmp.filter((c) => c.gap);
          const pairs = [...new Set(gaps.map((c) => `${c.sourceId} ${c.gpu}`))];
          out.push(ok("page check on the archive (reported, not judged)", true, `${cmp.length} comparisons, all ${[...new Set(cmp.map((c) => c.tracker))].join("/") || "-"}; ${gaps.length} gapped (${pairs.join(", ") || "none"}); alerts REVIEW ${al.filter((a) => a.code === AlertCode.PAGECHECK_REVIEW).length}, FAULT ${al.filter((a) => a.code === AlertCode.PAGECHECK_FAULT).length}, TRACKERS_DOWN ${al.filter((a) => a.code === AlertCode.PAGECHECK_TRACKERS_DOWN).length}`));
          return out;
        },
      },
    );
  },
};

export const UPGRADE_SCENARIOS: Scenario[] = [readerSwap, ownerExpired, repostOutage, repostOutageProduction, keyMismatch, pagecheckScenario, repairLoop, twoIndexes, coreweave];
