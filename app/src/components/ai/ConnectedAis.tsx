"use client";
// Connected AIs (/app/ai), in the market frame: the figures across the top, the AIs under them, the column on the right
// with the way to add one. The AIs' grants, pockets and activity, plus the over-cap requests the AI's own page already
// reads, so a row can say when one waits. Each AI shows its pocket as a gauge of what is left, its trades in the last
// 24 hours as a tally, and its time left as a gauge to the end date; under the AIs, what they did lately; on the right,
// adding one as three numbered steps. Nothing connected (or signed out): what each AI gets, under the way in.
import Link from "next/link";
import { useFlow } from "@/components/markets/Flow";
import { NavBar, Notice } from "@/components/shell/Shell";
import { BottomDock } from "@/components/shell/Dock";
import { Num } from "@/components/num/Num";
import { useAccount } from "@/lib/account";
import { useActivity, useApprovals, useGrants, usePocket, usePockets } from "@/lib/account/ai";
import { activityLine, explorerTx, givenOf, grantState, limitsOf, spentOf, statusText, timeLeftShare, timeLeftText, tradesIn24h, tradesLeftText } from "@/lib/account/aiView";
import type { ActivityEvent, ApprovalView, Grant } from "@/lib/account/api";
import { approvalOpen } from "@/lib/account/machine";
import { dateText, whenText } from "@/lib/data/derive";
import { usd0 } from "@/lib/format";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { useNow } from "@/lib/ui/useNow";
import { AppMark, appForLabel } from "./apps";
import { AddLink, AppPicker, ConnectInstead, UntriedNote, connectHref, useAddAi } from "./HowTo";
import { Invite, Meter, OFFLINE_LINE, Tally, useScreenTheme } from "./shared";
import t from "@/components/trade/trade.module.css";
import s from "./ai.module.css";
import x from "./connectedAis.module.css";

// ===== the page =====

type State = "out" | "loading" | "offline" | "ready";

export function ConnectedAis() {
  const { config } = useMock();
  const tone = useScreenTheme();
  const account = useAccount();
  const flow = useFlow();
  const grants = useGrants({ poll: true });
  const activity = useActivity(undefined, { poll: true });
  const approvals = useApprovals({ poll: true });
  const now = useNow(60_000);
  const list = grants.data ?? [];
  const live = list.filter((g) => grantState(g, now) === "active");
  const ended = list.filter((g) => grantState(g, now) !== "active");
  const offline = grants.isError;
  const q = useLinkQuery();
  const state: State = !account.ready ? "out" : grants.isPending ? "loading" : offline && !grants.data ? "offline" : "ready";
  // a request waits only while its AI is connected (as on the AI's own page)
  const waitingFor = (g: Grant) => (approvals.data ?? []).filter((a: ApprovalView) => a.grantId === g.id && approvalOpen(a, now)).length;

  let body: React.ReactNode;
  if (!account.ready) {
    body = (
      <div className={x.empty}>
        <Invite title="See your AIs" text="Sign in to see the AIs you've connected: what's in their pockets, what they traded and when they end.">
          <button className="ag-btn ag-btn--primary" type="button" onClick={flow.openSignIn}>
            Sign in
          </button>
        </Invite>
        <WhatEachGets />
      </div>
    );
  } else if (grants.isPending) {
    body = (
      <section className={s.section} aria-busy="true" aria-label="Loading your AIs">
        <span className={`${s.panelH2} ag-skel ag-skel-on`} style={{ justifySelf: "start" }}>
          Connected
        </span>
        <ul className={x.ais}>
          {[0, 1].map((i) => (
            <li key={i} className={x.skel}>
              <span className="ag-skel ag-skel-on" />
              <span className="ag-skel ag-skel-on" />
            </li>
          ))}
        </ul>
      </section>
    );
  } else if (list.length === 0 && !offline) {
    body = (
      <div className={x.empty}>
        <Invite title="No AI connected yet" text="Pick your AI app on the right and add Agate's link, or connect one from here. Each trades only from its own pocket, inside the limits you set.">
          <Link className="ag-btn ag-btn--primary" href={connectHref(null, q)}>
            Connect from here
          </Link>
        </Invite>
        <WhatEachGets />
      </div>
    );
  } else {
    body = (
      <>
        {offline && (
          <div className={s.banner} role="status">
            <span>{OFFLINE_LINE}</span>
            <button className="ag-btn ag-btn--ghost" type="button" onClick={() => void grants.refetch()}>
              Try now
            </button>
          </div>
        )}
        {live.length > 0 && (
          <section className={s.section} aria-labelledby="ais-live-h">
            <h2 id="ais-live-h" className={s.panelH2}>
              Connected
            </h2>
            <ul className={x.ais}>
              {live.map((g) => (
                <AiRow key={g.id} g={g} events={activity.data} now={now} waiting={waitingFor(g)} />
              ))}
            </ul>
          </section>
        )}
        {ended.length > 0 && (
          <section className={s.section} aria-labelledby="ais-ended-h">
            <h2 id="ais-ended-h" className={s.panelH2}>
              Ended
            </h2>
            <ul className={x.ais}>
              {ended.map((g) => (
                <EndedRow key={g.id} g={g} events={activity.data} now={now} />
              ))}
            </ul>
          </section>
        )}
        {list.length > 0 && <Recent grants={list} events={activity.data} pending={activity.isPending} failed={activity.isError} />}
      </>
    );
  }

  return (
    <div className={`${t.screen} ${s.screen} ${tone}`} data-phone={config.phone}>
      <Notice />
      <NavBar active={null} />
      <main className={t.main}>
        <div className={s.frame}>
          <Figures live={live} events={activity.data} now={now} state={state} />
          <section className={`${t.panel} ${s.listPanel}`} aria-label="Your AIs">
            {body}
          </section>
          <aside className={`${t.panel} ${s.rail}`} aria-labelledby="ais-add-h">
            <h2 id="ais-add-h" className={s.panelH2}>
              {list.length ? "Add another AI" : "Add an AI"}
            </h2>
            <AddSteps />
            <div className={s.railNote}>
              <h3>What an AI can do here</h3>
              <ul className={x.can}>
                <li>
                  <Mark yes />
                  <span>Go Long or Short, and close what it opened.</span>
                </li>
                <li>
                  <Mark yes />
                  <span>Trade only from its own pocket, inside your limits.</span>
                </li>
                <li>
                  <Mark />
                  <span>Never send your money anywhere else. Payouts always come to your account.</span>
                </li>
              </ul>
            </div>
          </aside>
        </div>
      </main>
      {config.phone === "new" && <BottomDock active={null} />}
    </div>
  );
}

/** A check (it can) or a cross (it never can), in the second ink. */
function Mark({ yes = false }: { yes?: boolean }) {
  return (
    <svg className={x.canMark} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {yes ? <path d="M3 8.5l3.2 3L13 4.5" /> : <path d="M4 4l8 8M12 4l-8 8" />}
    </svg>
  );
}

/** The page's figures, the market page's header: what the connected AIs hold in their pockets, then how many, their
 *  trades in the last 24 hours against what they may make, what they spent and the next end date in days. Masked
 *  while they load; a dash and the reason when they can't be known, never a guessed 0. */
function Figures({ live, events, now, state }: { live: Grant[]; events: ActivityEvent[] | undefined; now: number; state: State }) {
  const pockets = usePockets(live.map((g) => g.pocket));
  const known = state === "ready";
  const pocketsWait = known && pockets.some((p) => p.isPending);
  const pocketFailed = known && pockets.some((p) => p.isError);
  const held = pockets.reduce((a, p) => a + (p.data?.balance ?? 0), 0);
  const tradesAll = live.map((g) => tradesIn24h(g.id, events, now));
  const trades = tradesAll.some((v) => v === null) ? null : tradesAll.reduce<number>((a, v) => a + (v ?? 0), 0);
  const allowed = live.reduce((a, g) => a + g.tradesPerDay, 0);
  const spentAll = live.map((g) => spentOf(g.id, events));
  const spent = spentAll.some((v) => v === null) ? null : spentAll.reduce<number>((a, v) => a + (v ?? 0), 0);
  const next = [...live].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))[0];
  const sk = state === "loading" ? "ag-skel ag-skel-on" : "";
  const dash = <small>–</small>;
  const sub =
    state === "out"
      ? "Sign in to see them"
      : state === "offline"
        ? "Can't reach Agate's server right now"
        : state === "loading"
          ? null
          : pocketFailed
            ? "A pocket can't be read right now"
            : live.length
              ? `Across ${live.length} connected ${live.length === 1 ? "AI" : "AIs"}`
              : "No AI connected yet";
  return (
    <section className={`${t.panel} ${t.headPanel} ${s.figs}`} aria-label="Your AIs in figures" aria-busy={state === "loading" || pocketsWait || undefined}>
      <div className={`${t.hsRow} ${s.wideHead}`}>
        <div className={t.priceBlock}>
          <span className={t.pLabel}>In your AIs' pockets</span>
          <span className={`${t.bigPrice} font-display ${sk || (pocketsWait ? "ag-skel ag-skel-on" : "")}`}>{!known || pocketFailed ? "–" : pocketsWait ? "$0,000" : usd0(held)}</span>
          <span className={t.pSub}>{sub === null ? <em className="ag-skel ag-skel-on">across 0 AIs</em> : sub}</span>
        </div>
        <dl className={`${t.hsGrid} ${s.stats} ${x.stats}`}>
          <div>
            <dt>Connected</dt>
            <dd className={sk}>{known ? <Num>{String(live.length)}</Num> : state === "loading" ? "0" : dash}</dd>
          </div>
          <div>
            <dt>Trades in the last 24 hours</dt>
            <dd className={sk}>
              {known && trades === null ? (
                <small>Not yet shown</small>
              ) : known ? (
                <>
                  <Num>{String(trades)}</Num>
                  {allowed > 0 && <small> of {allowed}</small>}
                </>
              ) : state === "loading" ? (
                "0"
              ) : (
                dash
              )}
            </dd>
          </div>
          <div>
            <dt>Spent</dt>
            <dd className={sk}>{!known ? (state === "loading" ? "$0" : dash) : spent === null ? <small>Not yet shown</small> : <Num>{usd0(spent)}</Num>}</dd>
          </div>
          <div>
            <dt>Next to end</dt>
            <dd className={sk}>
              {!known ? (
                state === "loading" ? (
                  "0 days left"
                ) : (
                  dash
                )
              ) : next ? (
                <>
                  <span>{timeLeftText(next.expiresAt, now) ?? whenText(next.expiresAt)}</span>
                  <span className={x.ddSub}>
                    {live.length > 1 ? `${next.label}, ` : ""}
                    {whenText(next.expiresAt)}
                  </span>
                </>
              ) : (
                <small>None</small>
              )}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

/** Under the way in, while nothing is connected (or signed out): the three things every AI here gets, each with the
 *  picture its row carries once one is connected. */
function WhatEachGets() {
  return (
    <section className={x.gets} aria-labelledby="ais-gets-h">
      <h2 id="ais-gets-h" className={s.panelH2}>
        What each AI gets
      </h2>
      <div className={x.cells}>
        <div className={x.cell}>
          <span className={x.getK}>Its own pocket</span>
          <Meter f={1} />
          <p className={x.cellSub}>You move in the test dollars it may use. It can't touch the rest of your account.</p>
        </div>
        <div className={x.cell}>
          <span className={x.getK}>Your limits</span>
          <Tally used={0} of={5} />
          <p className={x.cellSub}>The most it may put on one trade, and how many trades it may make in 24 hours.</p>
        </div>
        <div className={x.cell}>
          <span className={x.getK}>An end date</span>
          <Meter f={0.6} />
          <p className={x.cellSub}>It stops trading on the day you pick, or as soon as you disconnect it.</p>
        </div>
      </div>
    </section>
  );
}

function AiRow({ g, events, now, waiting }: { g: Grant; events: ActivityEvent[] | undefined; now: number; waiting: number }) {
  const q = useLinkQuery();
  const flow = useFlow();
  const pocket = usePocket(g.pocket);
  const lim = limitsOf(g);
  const left = pocket.data?.balance;
  const spent = spentOf(g.id, events);
  const trades = tradesIn24h(g.id, events, now);
  const given = givenOf(g, left);
  const href = `/app/ai/${encodeURIComponent(g.id)}${q}`;
  const timeLeft = timeLeftText(g.expiresAt, now);
  return (
    <li className={x.ai}>
      <div className={x.who}>
        <AppMark app={appForLabel(g.label)} name={g.label} size={44} />
        <Link className={x.name} href={href}>
          {g.label}
        </Link>
        {waiting > 0 ? (
          <span className={x.asks}>{waiting === 1 ? "Wants your OK on one trade" : `Wants your OK on ${waiting} trades`}</span>
        ) : (
          <span className={s.status}>Connected since {dateText(g.createdAt)}</span>
        )}
        <svg className={x.chev} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M4.5 2.5l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        </svg>
      </div>
      <div className={x.acts}>
        <Link className={`ag-btn ${waiting > 0 ? "ag-btn--primary" : "ag-btn--ghost"}`} href={href} aria-label={waiting > 0 ? `Review ${g.label}'s request` : `Open ${g.label}`}>
          {waiting > 0 ? "Review" : "Open"}
        </Link>
        <button type="button" className={`ag-textbtn ${s.textDown}`} onClick={() => flow.openDisconnect(g.id)} aria-label={`Disconnect ${g.label}`}>
          Disconnect
        </button>
      </div>
      <div className={x.cells}>
        <div className={x.cell}>
          <span className={x.cellK}>Left in its pocket</span>
          {pocket.isPending ? (
            <span className={`${x.cellV} ag-skel ag-skel-on`}>$0,000 of $0,000</span>
          ) : pocket.isError ? (
            <span className={x.cellV}>
              <small>Can't read it right now</small>
            </span>
          ) : (
            <span className={x.cellV}>
              <Num>{usd0(left ?? 0)}</Num>
              {given !== null && <small> of {usd0(given)}</small>}
            </span>
          )}
          {given !== null && left !== undefined && <Meter f={given > 0 ? left / given : 0} />}
          <span className={x.cellSub}>
            {spent !== null ? `Spent ${usd0(spent)}. ` : ""}Up to {usd0(lim.perTradeCap)} a trade.
          </span>
        </div>
        <div className={x.cell}>
          <span className={x.cellK}>Trades in the last 24 hours</span>
          {trades === null ? (
            <span className={x.cellV}>
              <small>Not yet shown</small>
            </span>
          ) : (
            <>
              <span className={x.cellV}>
                <Num>{String(trades)}</Num>
                <small> of {lim.tradesPerDay}</small>
              </span>
              <Tally used={trades} of={lim.tradesPerDay} />
              <span className={x.cellSub}>{tradesLeftText(trades, lim.tradesPerDay)}</span>
            </>
          )}
        </div>
        <div className={x.cell}>
          <span className={x.cellK}>Time left</span>
          <span className={x.cellV}>{timeLeft ?? "Ending now"}</span>
          <Meter f={timeLeftShare(g, now)} />
          <span className={x.cellSub}>Ends {whenText(g.expiresAt)}</span>
        </div>
      </div>
    </li>
  );
}

function EndedRow({ g, events, now }: { g: Grant; events: ActivityEvent[] | undefined; now: number }) {
  const q = useLinkQuery();
  const flow = useFlow();
  const pocket = usePocket(g.pocket);
  const left = pocket.data?.balance ?? 0;
  const leftLine = pocket.isPending ? "" : pocket.isError ? "Can't read its pocket right now." : left > 0 ? `${usd0(left)} still in its pocket.` : "Its pocket is empty.";
  return (
    <li className={`${x.ai} ${x.ended}`}>
      <div className={x.who}>
        <AppMark app={appForLabel(g.label)} name={g.label} size={44} />
        <Link className={x.name} href={`/app/ai/${encodeURIComponent(g.id)}${q}`}>
          {g.label}
        </Link>
        <span className={s.status}>{statusText(g, events, now)}</span>
        <svg className={x.chev} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M4.5 2.5l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
        </svg>
      </div>
      <p className={x.endedLine}>{pocket.isPending ? <span className="ag-skel ag-skel-on">$000 still in its pocket.</span> : leftLine}</p>
      <div className={x.acts}>
        {left > 0 && (
          <button data-keep className="ag-btn ag-btn--ghost" type="button" onClick={() => flow.openPocket({ pocket: g.pocket, ai: g.label, ended: true }, "takeBack")}>
            Take back {usd0(left)}
          </button>
        )}
        <Link className="ag-btn ag-btn--ghost" href={`/app/ai/${encodeURIComponent(g.id)}${q}`} aria-label={`Open ${g.label}`}>
          Open
        </Link>
      </div>
    </li>
  );
}

/** What the AIs did lately, newest first, across all of them: the same sentences as each AI's own page, with its mark
 *  and name. Only what the server logged; a calm line when there is nothing yet. */
const RECENT = 8;
function Recent({ grants, events, pending, failed }: { grants: Grant[]; events: ActivityEvent[] | undefined; pending: boolean; failed: boolean }) {
  const q = useLinkQuery();
  const byId = new Map(grants.map((g) => [g.id, g]));
  const lines = (events ?? [])
    .map((e) => {
      const g = e.grantId ? byId.get(e.grantId) : undefined;
      const line = g ? activityLine(e, g.label) : null;
      return line && g ? { e, g, line } : null;
    })
    .filter((v) => v !== null)
    .sort((a, b) => b.e.at - a.e.at);
  const shown = lines.slice(0, RECENT);
  return (
    <section className={s.section} aria-labelledby="ais-recent-h">
      <h2 id="ais-recent-h" className={s.panelH2}>
        Recent activity
      </h2>
      {failed && <p className={s.err}>Can't load the activity right now. Trying again.</p>}
      {pending ? (
        <ul className={x.recent} aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <span className="ag-skel ag-skel-on" style={{ width: 28, height: 28 }} />
              <span className="ag-skel ag-skel-on">Loading the activity</span>
            </li>
          ))}
        </ul>
      ) : shown.length === 0 ? (
        !failed && <p className={s.quiet}>Nothing yet. Your AIs' trades show here as they make them.</p>
      ) : (
        <>
          <ul className={x.recent}>
            {shown.map(({ e, g, line }, i) => (
              <li key={`${e.at}-${e.name}-${i}`} data-quiet={line.quiet || undefined}>
                <AppMark app={appForLabel(g.label)} name={g.label} size={28} />
                <div className={s.actBody}>
                  <span className={s.actText}>{line.text}</span>
                  {line.amount ? (
                    <span className={s.actAmt}>
                      <Num>{usd0(line.amount)}</Num>
                    </span>
                  ) : null}
                  <span className={`${s.actMeta} ${x.recentMeta}`}>
                    <Link href={`/app/ai/${encodeURIComponent(g.id)}${q}`}>{g.label}</Link>
                    <span>{whenText(new Date(e.at).toISOString())}</span>
                    {line.txHash && (
                      <a href={explorerTx(line.txHash)} target="_blank" rel="noreferrer">
                        Explorer
                      </a>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {lines.length > RECENT && <p className={s.quiet}>Each AI's page has all of what it did.</p>}
        </>
      )}
    </section>
  );
}

// ===== adding an AI: three numbered steps =====

/** One numbered step: its number, its heading, and what to do. */
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className={x.step}>
      <span className={x.stepN} aria-hidden="true">
        {n}
      </span>
      <div className={x.stepBody}>
        <h3 className={x.stepH}>{title}</h3>
        {children}
      </div>
    </li>
  );
}

/** "Then type /mcp ..." reads as its own step: the leading "Then" goes. */
const asStep = (line: string) => line.replace(/^Then\s+(\w)/, (_, c: string) => c.toUpperCase());

function AddSteps() {
  const { id, setId, app, q, text, notPublic, loading } = useAddAi();
  // one polite region over the steps: picking another app reads out what changed (its steps, its line, the note)
  return (
    <div className={x.add} aria-live="polite">
      <ol className={x.steps}>
        <Step n={1} title="Pick your AI app">
          <AppPicker picked={id} onPick={(a) => setId(a.id)} />
        </Step>
        {app.oauth ? (
          <>
            <Step n={2} title={app.line ? `Add Agate to ${app.name}` : "Paste Agate's link"}>
              <p className={x.stepP}>
                {app.paste}
              </p>
              <AddLink app={app} text={text} notPublic={notPublic} loading={loading} field={{ box: x.field, text: x.fieldText, copy: x.fieldCopy }} />
            </Step>
            <Step n={3} title="Say OK in Agate">
              <p className={x.stepP}>{app.then ? `${asStep(app.then)} There you set its pocket and limits.` : "Agate asks for your OK, and you set its pocket and limits."}</p>
            </Step>
          </>
        ) : (
          <>
            <Step n={2} title={`Connect ${app.name} from here`}>
              <p className={x.stepP}>
                {app.name} can't sign in to Agate by itself yet. Set its pocket and limits here, and Agate makes a link for it.
              </p>
              <Link className={`ag-btn ag-btn--primary ${x.stepBtn}`} href={connectHref(app, q)}>
                Connect {app.name}
              </Link>
            </Step>
            <Step n={3} title="Add the link Agate gives you">
              <p className={x.stepP}>When it's connected, Agate shows the line to add to {app.name}, ready to copy. It shows only once.</p>
            </Step>
          </>
        )}
      </ol>
      <UntriedNote app={app} />
      <ConnectInstead app={app} q={q} />
    </div>
  );
}
