"use client";
// Connected AIs (/ai, wallet spec 10.1, screen 9): every AI the person let trade, each with its pocket's dollars, what
// it spent, its trades in the last 24 hours and its end date; the ended ones below with what is left in their
// pockets. Empty: how to connect one. Rows on desktop, cards on narrower screens, the dock on phones.
import Link from "next/link";
import { useEffect } from "react";
import { useFlow } from "@/components/markets/Flow";
import { NavBar, Notice } from "@/components/shell/Shell";
import { BottomDock } from "@/components/shell/Dock";
import { Num } from "@/components/num/Num";
import { useAccount } from "@/lib/account";
import { useActivity, useGrants, usePocket, usePockets } from "@/lib/account/ai";
import { grantState, limitsOf, spentOf, statusText, tradesIn24h } from "@/lib/account/aiView";
import type { ActivityEvent, Grant } from "@/lib/account/api";
import { whenText } from "@/lib/data/derive";
import { usd0 } from "@/lib/format";
import { groundFor } from "@/lib/mock/config";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { useThemeColor } from "@/lib/ui/hooks";
import { useNow } from "@/lib/ui/useNow";
import { AppMark, appForLabel, appOf } from "./apps";
import { connectHref, HowTo } from "./HowTo";
import t from "@/components/trade/trade.module.css";
import s from "./ai.module.css";

/** The page ground and the browser chrome follow the in-app theme. */
export function useScreenTheme() {
  const { config } = useMock();
  useEffect(() => {
    document.documentElement.style.background = groundFor(config);
  }, [config]);
  useThemeColor(config.theme);
  return config.theme === "dark" ? "tone-dark" : "tone-light";
}

export const OFFLINE_LINE = "Can't reach Agate's server right now. Your AIs' limits still hold on Monad.";

export function AisScreen() {
  const { config } = useMock();
  const tone = useScreenTheme();
  const account = useAccount();
  const flow = useFlow();
  const grants = useGrants({ poll: true });
  const activity = useActivity(undefined, { poll: true });
  const now = useNow(60_000);
  const list = grants.data ?? [];
  const live = list.filter((g) => grantState(g, now) === "active");
  const ended = list.filter((g) => grantState(g, now) !== "active");
  const offline = grants.isError;
  const q = useLinkQuery();

  let body: React.ReactNode;
  if (!account.ready) {
    body = (
      <Invite title="See your AIs" text="Sign in to see the AIs you've connected: what's in their pockets, what they traded and when they end.">
        <button className="ag-btn ag-btn--primary" type="button" onClick={flow.openSignIn}>
          Sign in
        </button>
      </Invite>
    );
  } else if (grants.isPending) {
    body = (
      <ul className={s.list} aria-busy="true" aria-label="Loading your AIs">
        {[0, 1].map((i) => (
          <li key={i} className={s.skelRow}>
            <span className="ag-skel ag-skel-on" />
          </li>
        ))}
      </ul>
    );
  } else if (list.length === 0 && !offline) {
    body = (
      <Invite title="No AI connected yet" text="Pick your AI app on the right and add Agate's link, or connect one from here. Each trades only from its own pocket, inside the limits you set.">
        <Link className="ag-btn ag-btn--primary" href={connectHref(null, q)}>
          Connect from here
        </Link>
      </Invite>
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
            <div className={s.cols} aria-hidden="true">
              <span>AI</span>
              <span>Left in its pocket</span>
              <span>Spent</span>
              <span>Trades in the last 24 hours</span>
              <span>Ends</span>
              <span />
            </div>
            <ul className={s.list}>
              {live.map((g) => (
                <AiRow key={g.id} g={g} events={activity.data} now={now} />
              ))}
            </ul>
          </section>
        )}
        {ended.length > 0 && (
          <section className={s.section} aria-labelledby="ais-ended-h">
            <h2 id="ais-ended-h" className={s.panelH2}>
              Ended
            </h2>
            <ul className={s.list}>
              {ended.map((g) => (
                <EndedRow key={g.id} g={g} events={activity.data} now={now} />
              ))}
            </ul>
          </section>
        )}
      </>
    );
  }

  return (
    <div className={`${t.screen} ${s.screen} ${tone}`} data-phone={config.phone}>
      <Notice />
      <NavBar active={null} />
      <main className={t.main}>
        <div className={s.frame}>
          <Figures live={live} events={activity.data} now={now} state={!account.ready ? "out" : grants.isPending ? "loading" : offline && !grants.data ? "offline" : "ready"} />
          <section className={`${t.panel} ${s.listPanel}`} aria-label="Your AIs">
            {body}
          </section>
          <aside className={`${t.panel} ${s.rail}`} aria-labelledby="ais-add-h">
            <h2 id="ais-add-h" className={s.panelH2}>
              {list.length ? "Add another AI" : "Add an AI"}
            </h2>
            <HowTo intro={false} />
            <div className={s.railNote}>
              <h3>What an AI can do here</h3>
              <p>Go Long or Short and close what it opened, only from its pocket. It can never send your money anywhere else: payouts always come to your account.</p>
            </div>
          </aside>
        </div>
      </main>
      {config.phone === "new" && <BottomDock active={null} />}
    </div>
  );
}

/** The page's figures, the market page's header: what the connected AIs hold in their pockets, then how many, their
 *  trades in the last 24 hours, what they spent and the next end date. Masked while they load; a dash and the reason
 *  when they can't be known (signed out, Agate's server unreachable, a pocket that can't be read), never a guessed 0. */
function Figures({ live, events, now, state }: { live: Grant[]; events: ActivityEvent[] | undefined; now: number; state: "out" | "loading" | "offline" | "ready" }) {
  const pockets = usePockets(live.map((g) => g.pocket));
  const known = state === "ready";
  const pocketsWait = known && pockets.some((p) => p.isPending);
  const pocketFailed = known && pockets.some((p) => p.isError);
  const held = pockets.reduce((a, p) => a + (p.data?.balance ?? 0), 0);
  const trades = live.reduce((a, g) => a + tradesIn24h(g.id, events, now), 0);
  const spentAll = live.map((g) => spentOf(g.id, events));
  const spent = spentAll.some((x) => x === null) ? null : spentAll.reduce<number>((a, x) => a + (x ?? 0), 0);
  const next = live.map((g) => g.expiresAt).sort()[0];
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
      <div className={t.hsRow}>
        <div className={t.priceBlock}>
          <span className={t.pLabel}>In your AIs' pockets</span>
          <span className={`${t.bigPrice} font-display ${sk || (pocketsWait ? "ag-skel ag-skel-on" : "")}`}>{!known || pocketFailed ? "–" : pocketsWait ? "$0,000" : usd0(held)}</span>
          <span className={t.pSub}>{sub === null ? <em className="ag-skel ag-skel-on">across 0 AIs</em> : sub}</span>
        </div>
        <dl className={`${t.hsGrid} ${s.stats}`}>
          <div>
            <dt>Connected</dt>
            <dd className={sk}>{known ? <Num>{String(live.length)}</Num> : state === "loading" ? "0" : dash}</dd>
          </div>
          <div>
            <dt>Trades in the last 24 hours</dt>
            <dd className={sk}>{known ? <Num>{String(trades)}</Num> : state === "loading" ? "0" : dash}</dd>
          </div>
          <div>
            <dt>Spent</dt>
            <dd className={sk}>{!known ? (state === "loading" ? "$0" : dash) : spent === null ? <small>Not yet shown</small> : <Num>{usd0(spent)}</Num>}</dd>
          </div>
          <div>
            <dt>Next to end</dt>
            <dd className={sk}>{!known ? (state === "loading" ? "Oct 0" : dash) : next ? whenText(next) : <small>None</small>}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

/** The list panel with nothing to list yet: one card that says what goes here and the way in. */
export function Invite({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <div className={s.invite}>
      <AppStack />
      <h2 className={`${s.inviteTitle} font-display`}>{title}</h2>
      <p className={s.lead}>{text}</p>
      <div className={s.actions}>{children}</div>
    </div>
  );
}

/** A few of the apps' marks, overlapping: the apps an AI here can be. */
function AppStack() {
  return (
    <span className={s.appStack} aria-hidden="true">
      {(["claude", "chatgpt", "cursor", "hermes"] as const).map((id) => (
        <AppMark key={id} app={appOf(id)} size={40} />
      ))}
    </span>
  );
}

function AiRow({ g, events, now }: { g: Grant; events: ActivityEvent[] | undefined; now: number }) {
  const q = useLinkQuery();
  const flow = useFlow();
  const pocket = usePocket(g.pocket);
  const lim = limitsOf(g);
  const left = pocket.data?.balance;
  const spent = spentOf(g.id, events);
  const trades = tradesIn24h(g.id, events, now);
  const ends = whenText(g.expiresAt);
  const leftText = pocket.isError ? "Can't read" : left === undefined ? "" : usd0(left);
  // what it was given, while that is what the pocket is measured against: once more is in it than the first move in
  // (dollars added, a refund, a sale back into the pocket) only what is left is said, never a guessed total
  const given = left !== undefined && left > lim.budget + 0.005 ? null : lim.budget;
  return (
    <li className={s.row}>
      <div className={s.who}>
        <AppMark app={appForLabel(g.label)} name={g.label} size={36} />
        <Link className={s.name} href={`/app/ai/${encodeURIComponent(g.id)}${q}`}>
          {g.label}
        </Link>
        <span className={s.status}>{statusText(g, events, now)}</span>
      </div>
      <div className={s.fig}>
        <span className={s.k}>Left in its pocket: </span>
        {pocket.isPending ? (
          <span className="ag-skel ag-skel-on">$000</span>
        ) : pocket.isError ? (
          <span className={s.status}>Can't read</span>
        ) : (
          <>
            <Num>{leftText}</Num>
            {given !== null && <small> of {usd0(given)}</small>}
          </>
        )}
      </div>
      <div className={s.fig}>
        <span className={s.k}>Spent: </span>
        {spent === null ? <span className={s.status}>Not yet shown</span> : <Num>{usd0(spent)}</Num>}
      </div>
      <div className={s.fig}>
        <span className={s.k}>Trades in the last 24 hours: </span>
        <Num>{`${trades} of ${lim.tradesPerDay}`}</Num>
      </div>
      <div className={s.fig} data-k="ends">
        <span className={s.k}>Ends: </span>
        {ends}
      </div>
      <div className={s.cardLines}>
        <span>
          {pocket.isError ? "Can't read its pocket right now." : left === undefined ? " " : `${usd0(left)} left${given !== null ? ` of ${usd0(given)}` : ""}.`}
          {spent !== null ? ` Spent ${usd0(spent)}.` : ""}
        </span>
        <span>
          {trades} of {lim.tradesPerDay} trades in the last 24 hours. Ends {ends}.
        </span>
      </div>
      <div className={s.rowActs}>
        <Link className="ag-btn ag-btn--ghost" href={`/app/ai/${encodeURIComponent(g.id)}${q}`} aria-label={`Open ${g.label}`}>
          Open
        </Link>
        <button type="button" className={`ag-textbtn ${s.textDown}`} onClick={() => flow.openDisconnect(g.id)} aria-label={`Disconnect ${g.label}`}>
          Disconnect
        </button>
      </div>
    </li>
  );
}

function EndedRow({ g, events, now }: { g: Grant; events: ActivityEvent[] | undefined; now: number }) {
  const q = useLinkQuery();
  const flow = useFlow();
  const pocket = usePocket(g.pocket);
  const left = pocket.data?.balance ?? 0;
  const leftLine = pocket.isPending ? "" : pocket.isError ? "Can't read its pocket right now." : left > 0 ? `${usd0(left)} still in its pocket` : "Its pocket is empty";
  return (
    <li className={`${s.row} ${s.ended}`}>
      <div className={s.who}>
        <AppMark app={appForLabel(g.label)} name={g.label} size={36} />
        <Link className={s.name} href={`/app/ai/${encodeURIComponent(g.id)}${q}`}>
          {g.label}
        </Link>
        <span className={s.status}>{statusText(g, events, now)}</span>
      </div>
      <div className={s.fig} style={{ gridColumn: "2 / 5" }}>
        {pocket.isPending ? <span className="ag-skel ag-skel-on">$000 still in its pocket</span> : leftLine}
      </div>
      <div className={s.fig} />
      <div className={s.cardLines}>
        <span>{leftLine ? `${leftLine}.` : " "}</span>
        <span />
      </div>
      <div className={s.rowActs}>
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
