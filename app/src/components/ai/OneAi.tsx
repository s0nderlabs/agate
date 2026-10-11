"use client";
// One AI's page (/app/ai/<id>), in the market frame: the strip with the way back, the figures across the top, what it
// did under them, its pocket and limits in the column on the right. Its pocket shows
// as a gauge of what is left of what moved in, its trades as a tally of what it may make, its time as a gauge to the
// end date; what it did reads as a timeline by day; with no positions yet, the next step; "Keep my hedge going" is a
// switch per GPU with one line each; the payouts and the pocket's address sit in one tidy card.
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
import { activityLine, approvalWhat, clock, disconnectedAt, explorerAddress, explorerTx, givenOf, grantState, limitsOf, shortAddress, spentOf, timeLeftShare, timeLeftText, tradesIn24h, tradesLeftText } from "@/lib/account/aiView";
import type { ActivityEvent, ApprovalView, Grant, StandingOrder } from "@/lib/account/api";
import { autopilotText } from "@/lib/account/errors";
import { approvalOpen } from "@/lib/account/machine";
import { useLastFor } from "@/lib/data/hooks";
import { dateText, timeText, whenText } from "@/lib/data/derive";
import { usd0 } from "@/lib/format";
import { PLACES } from "@/lib/places";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { useNow } from "@/lib/ui/useNow";
import { Invite, Meter, OFFLINE_LINE, Tally, useScreenTheme } from "./shared";
import { AppMark, appForLabel } from "./apps";
import t from "@/components/trade/trade.module.css";
import s from "./ai.module.css";
import c from "./oneAi.module.css";

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

/** "Connected AIs" as a button, for a page with nothing else to show. */
function BackButton() {
  const q = useLinkQuery();
  return (
    <Link className="ag-btn ag-btn--ghost" href={`/app/ai${q}`}>
      Connected AIs
    </Link>
  );
}

export function OneAi({ id }: { id: string }) {
  const { config } = useMock();
  const tone = useScreenTheme();
  const account = useAccount();
  const flow = useFlow();
  const grants = useGrants({ poll: true });
  const g = grants.data?.find((v) => v.id === id);

  // every state but the page itself: one panel under the strip, its words in the middle
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
  } else body = <Page g={g} />;

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

function Page({ g }: { g: Grant }) {
  const account = useAccount();
  const flow = useFlow();
  const q = useLinkQuery();
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
  const given = givenOf(g, left);
  const timeLeft = timeLeftText(g.expiresAt, now);

  // the end date is the header's last figure; the line under the name says only how it stands
  const connectedLine = `Connected ${whenText(g.createdAt)}.${st === "ended" ? " Its permission has ended." : st === "disconnected" ? " Disconnected." : ""}`;
  const sk = left === undefined && !pocket.isError ? "ag-skel ag-skel-on" : "";

  return (
    <div className={s.frame}>
      <section className={`${t.panel} ${t.headPanel} ${s.figs}`} aria-label={`${g.label}'s pocket`}>
        <div className={`${t.hsRow} ${s.wideHead}`}>
          <div className={s.ident}>
            <AppMark app={appForLabel(g.label)} name={g.label} size={56} />
            <div className={s.pocketHead}>
              <h1 className={s.cardH1}>{g.label}</h1>
              <p className={s.quiet}>{connectedLine}</p>
            </div>
          </div>
          <div className={`${t.priceBlock} ${c.pocketBlock}`}>
            <span className={t.pLabel}>In {g.label}'s pocket</span>
            {pocket.isError ? (
              <span className={s.err}>Can't read the pocket right now. Trying again.</span>
            ) : (
              <span className={`${t.bigPrice} font-display ${sk}`}>{left === undefined ? "$000" : usd0(left)}</span>
            )}
            {given !== null && left !== undefined && <Meter f={given > 0 ? left / given : 0} />}
            <span className={t.pSub}>{given !== null && left !== undefined ? `Left of the ${usd0(given)} moved in when connected` : `Moved in when connected: ${usd0(lim.budget)}`}</span>
          </div>
          <dl className={`${t.hsGrid} ${s.stats} ${c.stats}`}>
            <div>
              <dt>Spent</dt>
              <dd>
                {spent === null ? <small>Not yet shown</small> : <Num>{usd0(spent)}</Num>}
              </dd>
            </div>
            <div>
              <dt>Most on one trade</dt>
              <dd>
                <Num>{usd0(lim.perTradeCap)}</Num>
                <span className={c.ddSub}>The limit you set</span>
              </dd>
            </div>
            <div>
              <dt>Trades in the last 24 hours</dt>
              <dd>
                {trades === null ? (
                  <small>Not yet shown</small>
                ) : (
                  <>
                    <Num>{String(trades)}</Num>
                    <small> of {lim.tradesPerDay}</small>
                    <span className={c.ddPic}>
                      <Tally used={trades} of={lim.tradesPerDay} />
                    </span>
                    {st === "active" && <span className={c.ddSub}>{tradesLeftText(trades, lim.tradesPerDay)}</span>}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>{st === "active" ? "Time left" : "Ended"}</dt>
              <dd>
                {st === "active" ? (
                  <>
                    {timeLeft ?? "Ending now"}
                    <span className={c.ddPic}>
                      <Meter f={timeLeftShare(g, now)} />
                    </span>
                    <span className={c.ddSub}>Ends {whenText(g.expiresAt)}</span>
                  </>
                ) : (
                  whenText(st === "disconnected" && offAt ? offAt : g.expiresAt)
                )}
              </dd>
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
            Positions{pocket.data ? ` (${positions.length})` : ""}
          </button>
        </div>
        <section className={s.section} data-tab="activity" data-shown={tab === "activity"} aria-labelledby="act-h">
          <h2 id="act-h" className={`${s.h2} ${s.panelH2}`}>
            Activity
          </h2>
          {activity.isError && <p className={s.err}>Can't load the activity right now. Trying again.</p>}
          {activity.isPending ? <span className="ag-skel ag-skel-on">Loading the activity</span> : <Timeline g={g} events={activity.data ?? []} now={now} />}
        </section>
        <section className={s.section} data-tab="positions" data-shown={tab === "positions"} aria-labelledby="pos-h">
          <h2 id="pos-h" className={`${s.h2} ${s.panelH2}`}>
            Its positions
          </h2>
          {pocket.isPending ? (
            <span className="ag-skel ag-skel-on">Loading its positions</span>
          ) : !pocket.data ? (
            // the pocket could not be read: say so, never "no positions"
            <p className={s.err}>Can't read its positions right now. Trying again.</p>
          ) : positions.length ? (
            <>
              <p className={s.line}>Held by {g.label}, paying your account.</p>
              <PositionCards positions={positions} lastFor={lastFor} closable={false} />
            </>
          ) : st === "active" ? (
            <div className={c.next}>
              <p className={c.nextH}>{g.label} hasn't opened any positions yet.</p>
              <p className={s.line}>Ask {g.label} to go Long or Short on a GPU month. What it opens shows here, and its payouts come to your account.</p>
              <Link className={`ag-btn ag-btn--ghost ${c.nextBtn}`} href={`${PLACES.markets}${q}`}>
                See the markets
              </Link>
            </div>
          ) : (
            <p className={s.line}>{g.label} didn't open any positions.</p>
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
        <div className={c.where}>
          <div className={c.whereRow}>
            <span className={c.whereK}>Payouts go to</span>
            <span className={c.whereV}>
              Your account
              {account.address && (
                <>
                  {" "}
                  <Num>{shortAddress(account.address)}</Num>
                </>
              )}
            </span>
          </div>
          <div className={c.whereRow}>
            <span className={c.whereK}>Pocket address</span>
            <span className={c.whereV}>
              <Num>{shortAddress(g.pocket)}</Num>
            </span>
            <span className={c.whereActs}>
              <CopyButton text={g.pocket} what={`${g.label}'s pocket address`} />
              <a className="ag-textbtn" href={explorerAddress(g.pocket)} target="_blank" rel="noreferrer">
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

/** "Keep my hedge going": per GPU, roll the pocket's Long into the next month before the month it holds closes. A
 *  switch each, with one line: what it checks and its last result when on, what it would do when off. */
function Autopilot({ g, active }: { g: Grant; active: boolean }) {
  const orders = useStandingOrders(g.id);
  const { backend } = useAiBackend();
  const refresh = useAiRefresh();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = orders.data ?? [];
  const latest = (gpu: string): StandingOrder | undefined => list.filter((o) => o.gpu === gpu).sort((p, n) => n.createdAt - p.createdAt)[0];
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
      <ul className={c.autos}>
        {ROLL_GPUS.map((gpu) => {
          const o = latest(gpu);
          const on = o?.status === "active";
          if (!active && !o) return null;
          const line = on ? `Checks ${leadText(o!.leadMinutes)} before a month closes. ${autopilotText(o!.lastResult)}` : active ? `Moves its ${gpu} Long into the next month.` : "Stopped.";
          const word = busy === gpu ? (on ? "Stopping" : "Starting") : on ? "On" : "Off";
          return (
            <li key={gpu} data-on={on || undefined}>
              <span className={c.autoName}>{gpu}</span>
              {active ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`Keep the ${gpu} hedge going`}
                  aria-busy={busy === gpu || undefined}
                  className={c.switch}
                  disabled={busy === gpu || orders.isPending}
                  onClick={() => act(gpu, o)}
                >
                  <span className={c.switchWord}>{word}</span>
                  <i aria-hidden="true" />
                </button>
              ) : (
                <span className={c.switchWord}>{on ? "On" : "Off"}</span>
              )}
              <span className={`${s.quiet} ${c.autoLine}`}>{line}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A UTC day: "2026-10-11". */
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** "Today", "Yesterday", else "Oct 9" (UTC, as every time on the page). */
function dayText(day: string, now: number) {
  if (day === dayOf(now)) return "Today";
  if (day === dayOf(now - 86_400_000)) return "Yesterday";
  return dateText(day);
}

/** What it did as a timeline, newest first, by day: a mark per entry (filled for a trade, hollow for a refusal or a
 *  failure), the sentence, its dollars on the right, the time and the transaction under it. */
function Timeline({ g, events, now }: { g: Grant; events: ActivityEvent[]; now: number }) {
  const lines = events
    .map((e) => ({ e, line: activityLine(e, g.label) }))
    .filter((v) => v.line)
    .sort((p, n) => n.e.at - p.e.at);
  if (!lines.length) return <p className={s.line}>Nothing yet. {g.label}'s trades show here as they happen.</p>;
  const days: { day: string; items: typeof lines }[] = [];
  for (const it of lines) {
    const day = dayOf(it.e.at);
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push(it);
    else days.push({ day, items: [it] });
  }
  return (
    <div className={c.tl}>
      {days.map(({ day, items }) => (
        <section key={day} className={c.tlDay} aria-label={dayText(day, now)}>
          <h3 className={c.tlDayH}>{dayText(day, now)}</h3>
          <ol className={c.tlList}>
            {items.map(({ e, line }, i) => {
              const iso = new Date(e.at).toISOString();
              const kind = line!.quiet ? "quiet" : e.name === "pocket.trade" || e.name === "autopilot.rolled" ? "trade" : "note";
              return (
                <li key={`${e.at}-${e.name}-${i}`} data-kind={kind}>
                  <span className={c.tlDot} aria-hidden="true" />
                  <div className={s.actBody}>
                    <span className={s.actText}>{line!.text}</span>
                    {line!.amount ? (
                      <span className={s.actAmt}>
                        <Num>{usd0(line!.amount)}</Num>
                      </span>
                    ) : null}
                    <span className={s.actMeta}>
                      <time dateTime={iso}>{timeText(iso)}</time>
                      {line!.txHash && (
                        <a href={explorerTx(line!.txHash)} target="_blank" rel="noreferrer">
                          Explorer
                        </a>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
