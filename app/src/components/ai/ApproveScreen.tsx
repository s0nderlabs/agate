"use client";
// An over-cap request (/approve?request=<id>, wallet spec 10.6, screen 6): an AI asked for a trade above its limit
// and sent the person here. The card says what, how much, and why it needs them; Approve runs the trade from the
// person's own account (not the AI's pocket) through the trade machine, then tells Agate how it went; Decline tells
// Agate no. Driven by machine.ts approvalReducer (the card) and tradeReducer (the trade).
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFlow } from "@/components/markets/Flow";
import { NavBar } from "@/components/shell/Shell";
import { DripButton } from "@/components/flow/DripButton";
import { Check, Steps } from "@/components/flow/Steps";
import { Num } from "@/components/num/Num";
import { useAccount } from "@/lib/account";
import { useAiBackend, useAiRefresh, useApprovals, useGrants } from "@/lib/account/ai";
import { approvalWhat, clock, grantState, limitsOf, shortAddress } from "@/lib/account/aiView";
import type { ApprovalView } from "@/lib/account/api";
import { refusalOfOrder, sendRefusal } from "@/lib/account/errors";
import {
  APPROVAL_ENDED_BY,
  approvalOrder,
  approvalReducer,
  approvalStart,
  placingMarks,
  TRADE_IDLE,
  tradeReducer,
  type ApprovalEvent,
  type ApprovalState,
  type TradeEvent,
  type TradeState,
} from "@/lib/account/machine";
import type { TicketShown } from "@/lib/account/types";
import { useSeriesFor } from "@/lib/data/hooks";
import { bandNow, monthLong, timeText } from "@/lib/data/derive";
import { usd, usd0 } from "@/lib/format";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { fmtHours } from "@/lib/size";
import { useNow } from "@/lib/ui/useNow";
import { useScreenTheme } from "./AisScreen";
import c from "@/components/connect/connect.module.css";

type Trade = TradeState<ApprovalView>;

export function ApproveScreen({ id }: { id: string }) {
  const { config } = useMock();
  const tone = useScreenTheme();
  const account = useAccount();
  const flow = useFlow();
  const q = useLinkQuery();
  const { backend } = useAiBackend();
  const refresh = useAiRefresh();
  const approvals = useApprovals({ poll: true });
  const grants = useGrants({ poll: true });
  const seriesFor = useSeriesFor();
  const now = useNow(1_000);

  // the two machines, each with a ref the async steps read
  const [a, setA] = useState<ApprovalState>(() => approvalStart(id));
  const aRef = useRef(a);
  const ad = useCallback((e: ApprovalEvent) => {
    aRef.current = approvalReducer(aRef.current, e);
    setA(aRef.current);
  }, []);
  const [t, setT] = useState<Trade>(TRADE_IDLE);
  const tRef = useRef(t);
  const td = useCallback((e: TradeEvent<ApprovalView>) => {
    tRef.current = tradeReducer(tRef.current, e);
    setT(tRef.current);
  }, []);

  useEffect(() => {
    if (approvals.data) ad({ type: "loaded", approvals: approvals.data, now: Date.now() });
    else if (approvals.error) ad({ type: "loadFailed", message: (approvals.error as Error).message });
  }, [approvals.data, approvals.error, ad]);
  useEffect(() => ad({ type: "tick", now }), [now, ad]);

  const ap = "approval" in a ? a.approval : null;
  const grant = ap ? grants.data?.find((g) => g.id === ap.grantId) : undefined;
  const ai = grant?.label ?? "Your AI";
  // the AI was disconnected or its permission ended: a request still waiting ended with it, and never runs
  const grantOff = grant ? grantState(grant, now) : "active";
  useEffect(() => {
    if (grantOff !== "active") ad({ type: "grantEnded" });
  }, [grantOff, a.step, ad]);
  const w = ap ? approvalWhat(ap) : null;
  // a Short's collateral, a Long's dollars (the server's approval summary, approvalDollars)
  const need = w?.dollars ?? 0;
  const short = account.ready && need > account.balance;
  // a Long's request says dollars only: about how many GPU-hours they buy at the ask now
  const askNow = ap && typeof ap.params.gpu === "string" && typeof ap.params.month === "string" ? seriesFor(ap.params.gpu, ap.params.month)?.quote?.ask : undefined;
  const aboutHours = w?.gpuHours ?? (ap && ap.action !== "close_short" && askNow && need > 0 ? Math.floor((need / askNow) * 1e4) / 1e4 : null);

  /** Tells Agate how it ended. Only for a final outcome: a trade that ran, or one that landed and reverted. */
  const report = useCallback(
    async (ok: boolean, x: { txHash?: string; userOpHash?: string | null; reason?: string }) => {
      try {
        const answer = ok ? await backend.api.approvalDone(id, { txHash: x.txHash ?? "", userOpHash: x.userOpHash ?? "" }) : await backend.api.approvalFailed(id, x.reason ?? "");
        ad({ type: "reported", approval: answer });
      } catch {
        // the trade's outcome stands; Agate learns it on the AI's next approval_status
      } finally {
        refresh();
      }
    },
    [backend, id, ad, refresh],
  );

  const approve = async () => {
    // a disconnect seen only now (another tab, the AI's page): the request ends here, nothing runs
    const g = ap ? grants.data?.find((x) => x.id === ap.grantId) : undefined;
    if (g && grantState(g) !== "active") return ad({ type: "grantEnded" });
    ad({ type: "approve", now: Date.now() });
    const st = aRef.current;
    if (st.step !== "sending") return;
    const order = approvalOrder(st.approval);
    if (!order || order.kind === "drip") {
      ad({ type: "tradeFailed", message: "This request can't be run from here. Nothing was sent." });
      return;
    }
    setT(TRADE_IDLE);
    tRef.current = TRADE_IDLE;
    td({ type: "submit", ask: { n: st.approval, order, need }, ready: true, balance: account.balance });
    if (tRef.current.step === "funds") return ad({ type: "back" });
    // the pretend account plans from the market's numbers; the real one plans from the chain
    const series = "gpu" in order ? seriesFor(order.gpu, order.month) : undefined;
    const L = order.kind !== "openShort";
    const price = (L ? series?.quote?.ask : series?.quote?.bid) || (w?.gpuHours && w.dollars ? w.dollars / w.gpuHours : 0);
    const hours = order.kind === "openShort" ? Number(order.gpuHours) : (aboutHours ?? (price ? need / price : 0));
    const daily = order.kind === "openLongDaily" || (order.kind === "openShort" && order.daily);
    const band = series ? bandNow(series) : null;
    const shown: TicketShown = { side: L ? "long" : "short", gpuHours: hours, price, floor: series?.floor ?? 0, cap: series?.cap ?? 0, daily, backNow: daily && band ? (L ? band.longNow : band.shortNow) * hours : 0 };
    // a practice trade is priced from the market read: without it nothing runs (never a $0 Long or a Short that pays in)
    if (account.kind === "pretend" && !(series && price > 0 && hours > 0 && (L || series.cap > price))) {
      setT(TRADE_IDLE);
      tRef.current = TRADE_IDLE;
      return ad({ type: "back", message: "Can't read the market's price right now. Nothing was sent. Try again in a moment." });
    }
    let plan;
    try {
      plan = await account.plan(order, shown);
      td({ type: "planned", plan });
    } catch (e) {
      // a refused plan sent nothing (funds, a moved price, a thin book, the network): back to the card with why, and
      // the request stays open, so Approve can run it again
      const r = refusalOfOrder(e, order);
      td({ type: "refused", refusal: r });
      return ad({ type: "back", message: r.message });
    }
    td({ type: "confirm", at: Date.now() });
    try {
      const result = await account.send(plan, (step, hash) => step === "sending" && td({ type: "signed", userOpHash: hash ?? "pending", at: Date.now() }));
      td({ type: "landed", result });
      ad({ type: "traded", txHash: result.txHash ?? "", userOpHash: result.userOpHash });
      void report(true, { txHash: result.txHash ?? "", userOpHash: result.userOpHash });
    } catch (e) {
      const r = sendRefusal(e);
      td({ type: "sendFailed", refusal: r });
      if (r.reason === "reverted") {
        // it landed and reverted: final, so Agate hears it failed
        ad({ type: "tradeFailed", message: r.message, outcome: "final" });
        void report(false, { reason: r.reason });
      } else if (!r.nothingSent) {
        // sent, not seen landing: never send it twice, and never call it failed
        ad({ type: "tradeFailed", message: r.message, outcome: "unconfirmed" });
      } else {
        // nothing left the account (signing, the fee, the bundler's check, the network): try again from the card
        ad({ type: "back", message: r.message });
      }
    }
  };

  const decline = async () => {
    ad({ type: "decline" });
    try {
      await backend.api.approvalDeny(id);
      ad({ type: "declined" });
    } catch (e) {
      ad({ type: "declineFailed", message: (e as Error).message });
    } finally {
      refresh();
    }
  };

  const aiHref = grant ? `/ai/${encodeURIComponent(grant.id)}${q}` : `/ai${q}`;
  const whole = (h: string, p: string, more?: React.ReactNode, check = false) => (
    <Frame tone={tone} phone={config.phone}>
      <div className={c.whole}>
        {check && <Check size={44} />}
        <h1 className={c.h1}>{h}</h1>
        <p className={c.lead}>{p}</p>
        {more}
        <Link className="ag-btn ag-btn--ghost" href={aiHref}>
          {grant ? `See ${ai}'s card` : "Connected AIs"}
        </Link>
      </div>
    </Frame>
  );

  if (!account.ready) {
    return (
      <Frame tone={tone} phone={config.phone}>
        <div className={c.whole}>
          <h1 className={c.h1}>An AI asked to go over its limit</h1>
          <p className={c.lead}>Sign in to see what it asks for and answer it. Nothing runs until you do.</p>
          <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" style={{ justifySelf: "start" }} onClick={() => flow.signInFor({ from: "approve" })}>
            Sign in
          </button>
        </div>
      </Frame>
    );
  }
  if (a.step === "loading") {
    if (a.message) return whole("Can't load this request", `${a.message} Nothing was traded.`, <button className="ag-btn ag-btn--primary" type="button" style={{ justifySelf: "start" }} onClick={() => void approvals.refetch()}>Try again</button>);
    return (
      <Frame tone={tone} phone={config.phone}>
        <div className={c.whole} aria-busy="true">
          <h1 className={`${c.h1} ag-skel ag-skel-on`}>An AI wants to go over its limit</h1>
          <p className={`${c.lead} ag-skel ag-skel-on`}>Loading the request</p>
        </div>
      </Frame>
    );
  }
  // each end page: the heading says what happened, the line under it only what is new
  if (a.step === "notFound") return whole("We can't find this request", "It may belong to another account. Nothing was traded.");
  if (a.step === "expired") {
    // the server's reason first (it knows what ended it), then the AI's state as read here
    const reason = a.approval?.result?.reason;
    const off = reason === APPROVAL_ENDED_BY.disconnected ? "disconnected" : reason === APPROVAL_ENDED_BY.ended ? "ended" : grantOff;
    const why = off === "disconnected" ? `It ended when ${ai} was disconnected.` : off === "ended" ? `It ended when ${ai}'s permission ended.` : "It wasn't answered in time.";
    return whole("This request has ended", `${why} Nothing was traded.`);
  }
  if (a.step === "declined") return whole("Declined", `${ai} will see it. Nothing was traded.`);
  if (a.step === "answered") {
    const how = a.approval.status === "done" ? "It ran from your account." : a.approval.status === "denied" ? "You declined it." : "It didn't go through. Nothing changed.";
    return whole("This request was already answered", `${how} ${ai} can see the answer.`);
  }
  if (a.step === "done") {
    return whole(
      "Approved",
      `${w?.what ?? "The trade"} ran from your account. ${ai} will see it.`,
      <Link className="ag-btn ag-btn--primary" href={`/positions${q}`}>
        See your positions
      </Link>,
      true,
    );
  }

  const ap2 = a.approval;
  const lim = grant ? limitsOf(grant) : null;
  const left = clock(ap2.expiresAt, now);
  const sending = a.step === "sending";
  const marks = placingMarks(t);
  const later = a.step === "later";
  const declining = a.step === "declining";
  const message = "message" in a ? a.message : undefined;

  return (
    <Frame tone={tone} phone={config.phone}>
      <div className={`${c.grid} ${c.single}`}>
        <header className={`${c.panel} ${c.head}`}>
          <h1 className={c.h1}>{ai} wants to go over its limit</h1>
          <p className="ag-well">{w?.what}</p>
        </header>
        <section className={`${c.panel} ${c.form}`} aria-label="The request">
          {sending && marks ? (
            <>
              <h2 className={c.h2big}>Placing your order</h2>
              <p className={c.lead}>From your account on Monad. This takes about 6 seconds.</p>
              <Steps
                label="Placing"
                rows={[
                  { key: "check", label: "Checking the price", mark: marks[0] },
                  { key: "sign", label: "Signing with your wallet", hint: "About 3 seconds.", mark: marks[1] },
                  { key: "monad", label: "Waiting for Monad", hint: "About 3 seconds.", mark: marks[2] },
                ]}
              />
            </>
          ) : a.step === "failed" ? (
            <>
              <h2 className={c.h2big}>{a.outcome === "unconfirmed" ? "Sent, not confirmed yet" : "It didn't go through"}</h2>
              <p className={c.err} role="alert">
                {a.message}
              </p>
              {a.reported && <p className={c.lead}>Agate told {ai} it didn't go through. It can ask again.</p>}
            </>
          ) : (
            <>
              <div className="ag-rows">
                <div>
                  <span>Runs from</span>
                  {/* a buy-back runs from the pocket that holds the Short; the rest from the person's own account */}
                  <span>{ap2.summary.runFrom === "pocket" ? `${ai}'s pocket${grant ? `, ${shortAddress(grant.pocket)}` : ""}` : `Your account, ${shortAddress(account.address)}`}</span>
                </div>
                {lim && (
                  <div>
                    <span>Its limit</span>
                    <span>
                      <Num>{usd0(lim.perTradeCap)}</Num> a trade
                    </span>
                  </div>
                )}
                {aboutHours ? (
                  <div>
                    <span>About</span>
                    <span>
                      <Num>{fmtHours(aboutHours)}</Num> GPU-hours of {String(ap2.params.gpu)} {monthLong(String(ap2.params.month))}
                    </span>
                  </div>
                ) : null}
                {need > 0 && !later && (
                  <div>
                    <span>{ap2.action === "open_short" ? "Needs in your account" : "You pay"}</span>
                    <span>
                      <Num>{need < 100 ? usd(need) : usd0(need)}</Num>
                    </span>
                  </div>
                )}
                <div>
                  <span>Answer by</span>
                  <span>
                    {timeText(new Date(ap2.expiresAt).toISOString())}
                    {left ? `, ${left} left` : ""}
                  </span>
                </div>
              </div>
              {ap2.note && (
                <p className={c.lead}>
                  {ai} says: {ap2.note}
                </p>
              )}
              <p className={c.lead}>
                {later
                  ? `Close this Short from ${ai}'s pocket page later. For now you can decline it.`
                  : `This runs from your own account, not ${ai}'s pocket${lim ? `. Its limit is ${usd0(lim.perTradeCap)} a trade` : ""}. Network fees are on Agate.`}
              </p>
              {!later && short && (
                <div className="grid gap-2">
                  <p className={c.err}>
                    This needs {usd0(need)} and you have {usd0(account.balance)}.
                  </p>
                  <DripButton lg={false} />
                </div>
              )}
              {message && (
                <p className={c.err} role="alert">
                  {message}
                </p>
              )}
            </>
          )}
        </section>
        <div className={`${c.panel} ${c.actions}`}>
          {sending ? (
            <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" disabled>
              <span className="ag-spinner" aria-hidden="true" />
              Placing
            </button>
          ) : a.step === "failed" ? (
            a.outcome === "retry" && !a.reported ? (
              <>
                <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={() => ad({ type: "retry", now: Date.now() })}>
                  Try again
                </button>
                <div className={c.actionsRow}>
                  <Link className="ag-textbtn" href={aiHref}>
                    {grant ? `See ${ai}'s card` : "Connected AIs"}
                  </Link>
                </div>
              </>
            ) : (
              <>
                <Link className="ag-btn ag-btn--primary ag-btn--lg" href={a.outcome === "unconfirmed" ? `/positions${q}` : aiHref}>
                  {a.outcome === "unconfirmed" ? "See your positions" : grant ? `See ${ai}'s card` : "Connected AIs"}
                </Link>
                {a.outcome === "unconfirmed" && (
                  <div className={c.actionsRow}>
                    <Link className="ag-textbtn" href={aiHref}>
                      {grant ? `See ${ai}'s card` : "Connected AIs"}
                    </Link>
                  </div>
                )}
              </>
            )
          ) : (
            <>
              {!later && (
                <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" disabled={declining || short} onClick={() => void approve()}>
                  Approve
                </button>
              )}
              <div className={c.actionsRow}>
                <button className={later ? "ag-btn ag-btn--ghost ag-btn--lg" : "ag-textbtn"} type="button" disabled={declining} onClick={() => void decline()}>
                  {declining ? "Declining" : "Decline"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Frame>
  );
}

function Frame({ tone, phone, children }: { tone: string; phone: string; children: React.ReactNode }) {
  return (
    <div className={`${c.screen} ${tone}`} data-phone={phone}>
      <NavBar active={null} />
      <main className={c.main}>{children}</main>
    </div>
  );
}
