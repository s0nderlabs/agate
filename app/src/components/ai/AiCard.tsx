"use client";
// One AI (/ai/[id], wallet spec 10.3, screen 10): its pocket and limits on the left; on the right a request waiting
// for the person, "Keep my hedge going" per GPU, what it did (trades, refusals with the rule in plain words, rolls,
// autopilot events, approvals) and the positions its pocket holds, which keep paying the person's account.
import Link from "next/link";
import { useState } from "react";
import { useFlow } from "@/components/markets/Flow";
import { NavBar, Notice } from "@/components/shell/Shell";
import { BottomDock } from "@/components/shell/Dock";
import { Num } from "@/components/num/Num";
import { CopyButton } from "@/components/flow/Copy";
import { PositionCards } from "@/components/trade/ProParts";
import { useAccount } from "@/lib/account";
import { ROLL_GPUS, useActivity, useAiBackend, useAiRefresh, useApprovals, useGrants, usePocket, useStandingOrders } from "@/lib/account/ai";
import { activityLine, approvalWhat, clock, explorerAddress, explorerTx, grantState, limitsOf, shortAddress, spentOf, tradesIn24h, disconnectedAt } from "@/lib/account/aiView";
import type { ApprovalView, Grant, StandingOrder } from "@/lib/account/api";
import { autopilotText } from "@/lib/account/errors";
import { approvalOpen } from "@/lib/account/machine";
import { useLastFor } from "@/lib/data/hooks";
import { timeText, whenText } from "@/lib/data/derive";
import { usd0 } from "@/lib/format";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { useNow } from "@/lib/ui/useNow";
import { Invite, OFFLINE_LINE, useScreenTheme } from "./AisScreen";
import { AppMark, appForLabel } from "./apps";
import t from "@/components/trade/trade.module.css";
import s from "./ai.module.css";

function Back() {
  const q = useLinkQuery();
  return (
    <Link className={s.back} href={`/app/ai${q}`}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
      </svg>
      Connected AIs
    </Link>
  );
}

export function AiCardScreen({ id }: { id: string }) {
  const { config } = useMock();
  const tone = useScreenTheme();
  const account = useAccount();
  const flow = useFlow();
  const grants = useGrants({ poll: true });
  const g = grants.data?.find((x) => x.id === id);

  // every state but the card itself: one panel under the strip, its words in the middle
  const alone = (node: React.ReactNode, busy = false) => (
    <div className={s.frameOne} aria-busy={busy || undefined}>
      <section className={`${t.panel} ${s.listPanel}`}>{node}</section>
    </div>
  );
  let body: React.ReactNode;
  if (!account.ready) {
    body = alone(
      <Invite title="Sign in to see this AI" text="Each AI you connect has its own page: its pocket, its trades and your limits.">
        <button className="ag-btn ag-btn--primary" type="button" onClick={flow.openSignIn}>
          Sign in
        </button>
      </Invite>,
    );
  } else if (grants.isPending) {
    body = alone(
      <div className={s.invite}>
        <span className={`${s.inviteTitle} ag-skel ag-skel-on`}>Loading this AI</span>
      </div>,
      true,
    );
  } else if (!g) {
    body = alone(
      <Invite title={grants.isError ? "Can't load this AI" : "We can't find this AI"} text={grants.isError ? OFFLINE_LINE : "It may belong to another account, or the link is from before it was disconnected."}>
        {grants.isError ? (
          <button className="ag-btn ag-btn--primary" type="button" onClick={() => void grants.refetch()}>
            Try now
          </button>
        ) : (
          <BackButton />
        )}
      </Invite>,
    );
  } else body = <Card g={g} />;

  return (
    <div className={`${t.screen} ${s.screen} ${tone}`} data-phone={config.phone}>
      <Notice />
      <NavBar active={null} />
      <div className={s.strip}>
        <Back />
        {g && <span className={s.stripName}>{g.label}</span>}
      </div>
      <main className={t.main}>{body}</main>
      {config.phone === "new" && <BottomDock active={null} />}
    </div>
  );
}

/** "Connected AIs" as a button, for a page with nothing else to show. */
function BackButton() {
  const q = useLinkQuery();
  return (
    <Link className="ag-btn ag-btn--ghost" href={`/app/ai${q}`}>
      Connected AIs
    </Link>
  );
}

function Card({ g }: { g: Grant }) {
  const account = useAccount();
  const flow = useFlow();
  const now = useNow(30_000);
  const pocket = usePocket(g.pocket);
  const activity = useActivity(g.id, { poll: true });
  const approvals = useApprovals({ poll: true });
  const lastFor = useLastFor();
  const [tab, setTab] = useState<"activity" | "positions">("activity");
  const st = grantState(g, now);
  const lim = limitsOf(g);
  const left = pocket.data?.balance;
  const positions = pocket.data?.positions ?? [];
  const spent = spentOf(g.id, activity.data);
  const trades = tradesIn24h(g.id, activity.data, now);
  const offAt = st === "disconnected" ? disconnectedAt(g, activity.data) : null;
  // a request waits only while the AI is connected: one left from before a disconnect or the end date has ended
  const waiting = st === "active" ? (approvals.data ?? []).filter((a) => a.grantId === g.id && approvalOpen(a, now)) : [];
  const target = { pocket: g.pocket, ai: g.label, ended: st !== "active" };

  // the end date is the header's last figure; the line under the name says only how it stands
  const connectedLine = `Connected ${whenText(g.createdAt)}.${st === "ended" ? " Its permission has ended." : st === "disconnected" ? " Disconnected." : ""}`;
  const sk = left === undefined && !pocket.isError ? "ag-skel ag-skel-on" : "";

  return (
    <div className={s.frame}>
      <section className={`${t.panel} ${t.headPanel} ${s.figs}`} aria-label={`${g.label}'s pocket`}>
        <div className={t.hsRow}>
          <div className={s.ident}>
            <AppMark app={appForLabel(g.label)} name={g.label} size={48} />
            <div className={s.pocketHead}>
              <h1 className={s.cardH1}>{g.label}</h1>
              <p className={s.quiet}>{connectedLine}</p>
            </div>
          </div>
          <div className={t.priceBlock}>
            <span className={t.pLabel}>In {g.label}'s pocket</span>
            {pocket.isError ? (
              <span className={s.err}>Can't read the pocket right now. Trying again.</span>
            ) : (
              <span className={`${t.bigPrice} font-display ${sk}`}>{left === undefined ? "$000" : usd0(left)}</span>
            )}
            <span className={t.pSub}>{`Moved in when connected: ${usd0(lim.budget)}`}</span>
          </div>
          <dl className={`${t.hsGrid} ${s.stats}`}>
            <div>
              <dt>Spent</dt>
              <dd>{spent === null ? <small>Not yet shown</small> : <Num>{usd0(spent)}</Num>}</dd>
            </div>
            <div>
              <dt>Most on one trade</dt>
              <dd>
                <Num>{usd0(lim.perTradeCap)}</Num>
              </dd>
            </div>
            <div>
              <dt>Trades in the last 24 hours</dt>
              <dd>
                <Num>{`${trades} of ${lim.tradesPerDay}`}</Num>
              </dd>
            </div>
            <div>
              <dt>{st === "active" ? "Ends" : "Ended"}</dt>
              <dd>{whenText(st === "disconnected" && offAt ? offAt : g.expiresAt)}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className={`${t.panel} ${s.listPanel}`} aria-label={`What ${g.label} did`}>
        {waiting.length > 0 && (
          <section className={s.section} aria-labelledby="wait-h">
            <h2 id="wait-h" className={s.panelH2}>
              Waiting for you
            </h2>
            {waiting.map((a) => (
              <Waiting key={a.id} a={a} ai={g.label} now={now} />
            ))}
          </section>
        )}
        <div className={s.tabs} role="tablist" aria-label={`${g.label}'s activity and positions`}>
          <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>
            Activity
          </button>
          <button type="button" role="tab" aria-selected={tab === "positions"} onClick={() => setTab("positions")}>
            Positions ({positions.length})
          </button>
        </div>
        <section className={s.section} data-tab="activity" data-shown={tab === "activity"} aria-labelledby="act-h">
          <h2 id="act-h" className={`${s.h2} ${s.panelH2}`}>
            Activity
          </h2>
          {activity.isError && <p className={s.err}>Can't load the activity right now. Trying again.</p>}
          {activity.isPending ? (
            <span className="ag-skel ag-skel-on">Loading the activity</span>
          ) : (
            <Feed g={g} events={activity.data ?? []} />
          )}
        </section>
        <section className={s.section} data-tab="positions" data-shown={tab === "positions"} aria-labelledby="pos-h">
          <h2 id="pos-h" className={`${s.h2} ${s.panelH2}`}>
            Its positions
          </h2>
          {pocket.isPending ? (
            <span className="ag-skel ag-skel-on">Loading its positions</span>
          ) : positions.length ? (
            <>
              <p className={s.line}>Held by {g.label}, paying your account.</p>
              <PositionCards positions={positions} lastFor={lastFor} closable={false} />
            </>
          ) : (
            <p className={s.line}>{g.label} hasn't opened any positions yet.</p>
          )}
        </section>
      </section>

      <aside className={`${t.panel} ${s.rail}`} aria-label={`${g.label}'s pocket and limits`}>
        {st !== "active" && left !== undefined && (
          <div className={s.banner}>
            <span>
              {st === "ended" ? `${g.label}'s permission ended ${whenText(g.expiresAt)}.` : `Disconnected${offAt ? ` ${whenText(offAt)}` : ""}.`}{" "}
              {left > 0 ? `${usd0(left)} is still in its pocket.` : "Its pocket is empty."}
              {positions.length > 0 && " Its positions stay in the pocket and keep paying your account."}
            </span>
            {left > 0 && (
              <button className="ag-btn ag-btn--ghost" type="button" onClick={() => flow.openPocket(target, "takeBack")}>
                Take back {usd0(left)}
              </button>
            )}
          </div>
        )}
        {st === "active" && (
          <div className={s.stack}>
            <h2 className={s.panelH2}>Its pocket</h2>
            {left !== undefined && left <= 0 && <p className={s.line}>The pocket is empty. Add test dollars to let {g.label} trade again.</p>}
            <div className={s.pair}>
              <button className="ag-btn ag-btn--ghost" type="button" onClick={() => flow.openPocket(target, "add")}>
                Add test dollars
              </button>
              {left !== undefined && left > 0 && (
                <button className="ag-btn ag-btn--ghost" type="button" onClick={() => flow.openPocket(target, "takeBack")}>
                  Take back {usd0(left)}
                </button>
              )}
            </div>
          </div>
        )}
        <div className="ag-rows">
          <div>
            <span>Payouts go to</span>
            <span>Your account, {shortAddress(account.address)}</span>
          </div>
          <div>
            <span>Pocket address</span>
            <span className="ag-val">
              <Num>{shortAddress(g.pocket)}</Num>
              <CopyButton text={g.pocket} what={`${g.label}'s pocket address`} />
              <a href={explorerAddress(g.pocket)} target="_blank" rel="noreferrer">
                Explorer
              </a>
            </span>
          </div>
        </div>
        <Autopilot g={g} active={st === "active"} />
        {st === "active" && (
          <button type="button" className={`ag-textbtn ${s.textDown}`} style={{ minHeight: 44, justifySelf: "start" }} onClick={() => flow.openDisconnect(g.id)}>
            Disconnect {g.label}
          </button>
        )}
      </aside>
    </div>
  );
}

function Waiting({ a, ai, now }: { a: ApprovalView; ai: string; now: number }) {
  const q = useLinkQuery();
  const { backend } = useAiBackend();
  const refresh = useAiRefresh();
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const w = approvalWhat(a);
  const left = clock(a.expiresAt, now);
  return (
    <div className={s.wait}>
      <p>
        {ai} wants to go over its limit: {w.what}.
      </p>
      <p className={s.quiet}>
        Answer by {timeText(new Date(a.expiresAt).toISOString())}
        {left ? `, ${left} left` : ""}. {a.summary.runFrom === "pocket" ? `It would run from ${ai}'s pocket.` : "It would run from your own account."}
      </p>
      {error && <p className={s.err}>{error}</p>}
      <div className={s.actions}>
        <Link className="ag-btn ag-btn--primary" href={`/app/approve?request=${encodeURIComponent(a.id)}${q.replace(/^\?/, "&")}`}>
          Review
        </Link>
        <button
          className="ag-btn ag-btn--ghost"
          type="button"
          disabled={declining}
          onClick={async () => {
            setDeclining(true);
            setError(null);
            try {
              await backend.api.approvalDeny(a.id);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setDeclining(false);
              refresh();
            }
          }}
        >
          {declining ? "Declining" : "Decline"}
        </button>
      </div>
    </div>
  );
}

/** "1 hour", "3 hours", "45 minutes", "2 days". */
function leadText(min: number) {
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? "" : "s"}`;
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? "" : "s"}`;
  return `${min} minutes`;
}

/** "Keep my hedge going": per GPU, roll the pocket's Long into the next month before the month it holds closes. */
function Autopilot({ g, active }: { g: Grant; active: boolean }) {
  const orders = useStandingOrders(g.id);
  const { backend } = useAiBackend();
  const refresh = useAiRefresh();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = orders.data ?? [];
  const latest = (gpu: string): StandingOrder | undefined => list.filter((o) => o.gpu === gpu).sort((x, y) => y.createdAt - x.createdAt)[0];
  const act = async (gpu: string, o: StandingOrder | undefined) => {
    setBusy(gpu);
    setError(null);
    try {
      if (o && o.status === "active") await backend.api.stopStandingOrder(o.id);
      else await backend.api.startStandingOrder({ grantId: g.id, gpu });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  if (!active && !list.length) return null;
  return (
    <section className={s.section} aria-labelledby="auto-h">
      <h2 id="auto-h" className={s.panelH2}>
        Keep my hedge going
      </h2>
      <p className={s.line}>
        {active
          ? `When a month ${g.label} holds a Long in is about to close, Agate moves that Long into the next month for it. Each move counts as one of its trades.`
          : `Stopped when ${g.label}'s permission ended.`}
      </p>
      {error && <p className={s.err}>{error}</p>}
      <ul className={s.autos}>
        {ROLL_GPUS.map((gpu) => {
          const o = latest(gpu);
          const on = o?.status === "active";
          if (!active && !o) return null;
          return (
            <li key={gpu}>
              <div>
                <b>
                  {gpu}: {on ? "on" : "off"}
                </b>
                <span className={s.quiet}>
                  {on ? `Checks ${leadText(o!.leadMinutes)} before a month closes. ${autopilotText(o!.lastResult)}` : o ? "Stopped." : "Not on."}
                </span>
              </div>
              {active && (
                <button className="ag-btn ag-btn--ghost" type="button" disabled={busy === gpu || orders.isPending} onClick={() => act(gpu, o)}>
                  {busy === gpu ? (on ? "Stopping" : "Starting") : on ? "Stop" : "Start"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Feed({ g, events }: { g: Grant; events: import("@/lib/account/api").ActivityEvent[] }) {
  const lines = events.map((e) => ({ e, line: activityLine(e, g.label) })).filter((x) => x.line);
  if (!lines.length) return <p className={s.line}>Nothing yet. {g.label}'s trades show here as they happen.</p>;
  return (
    <ul className={s.feed}>
      {lines.map(({ e, line }, i) => (
        <li key={`${e.at}-${e.name}-${i}`} data-quiet={line!.quiet || undefined}>
          <span className={s.feedText}>{line!.text}</span>
          <span className={s.feedAmt}>{line!.amount ? <Num>{usd0(line!.amount)}</Num> : null}</span>
          <span className={s.feedWhen}>
            <span>{whenText(new Date(e.at).toISOString())}</span>
            {line!.txHash && (
              <a href={explorerTx(line!.txHash)} target="_blank" rel="noreferrer">
                Explorer
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
