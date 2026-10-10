"use client";
// The Allow page (/connect, wallet spec 9, screens 7 and 8): an AI app asks to trade (OAuth, ?request=<id>), or the
// person connects one from inside the app. They set the pocket's money and limits, read what the AI can and can never
// do, and tap Allow once. The steps then run in place, driven by machine.ts connectReducer: the trading key (first AI
// only), letting Agate use it (with a fresh code only if that lapsed), the limits written into the pocket, the money
// moved in, and Agate told. Done goes back to the AI app, or shows the connector link once.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFlow } from "@/components/markets/Flow";
import { NavBar } from "@/components/shell/Shell";
import { CopyButton } from "@/components/flow/Copy";
import { Check, Steps, type StepRow } from "@/components/flow/Steps";
import { useScreenTheme } from "@/components/ai/AisScreen";
import { useAccount } from "@/lib/account";
import { useAiBackend, useAiRefresh } from "@/lib/account/ai";
import { clock, safeReturn } from "@/lib/account/aiView";
import { ServerError } from "@/lib/account/api";
import { CONNECT_COPY, codeProblemOf, codeProblemText, connectFailure, connectProblemOf, passkeyConfirmText, sendCodeProblemOf, SIGNIN_COPY } from "@/lib/account/errors";
import {
  BUDGET_CHIPS,
  checkTerms,
  cleanCode,
  connectDismissable,
  connectFunded,
  connectMarks,
  connectReducer,
  connectStart,
  defaultTerms,
  DAYS_CHIPS,
  MAX_DAYS,
  NOT_YET_EVERY_MS,
  PER_TRADE_CHIPS,
  termsWire,
  TRADES_PER_DAY,
  type ConnectEvent,
  type ConnectState,
  type ConnectStep,
} from "@/lib/account/machine";
import { DRIP } from "@/lib/account/types";
import { whenText } from "@/lib/data/derive";
import { int, usd0 } from "@/lib/format";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { parseAmount } from "@/lib/size";
import { useModalFocus, usePasskeySupport } from "@/lib/ui/hooks";
import { useHydrated, useNow } from "@/lib/ui/useNow";
import c from "./connect.module.css";

const WHICH = ["Claude", "ChatGPT", "Cursor"] as const;
/** A step running longer than this says so. */
const SLOW_MS = 15_000;

/** A step that stopped says why in the console; the screen says it in plain words. */
const logStep = (step: string, e: unknown) => console.warn(`[connect] ${step} failed`, e);

export function ConnectScreen({ requestId }: { requestId: string | null }) {
  const { config } = useMock();
  const tone = useScreenTheme();
  const account = useAccount();
  const flow = useFlow();
  const q = useLinkQuery();
  const { backend } = useAiBackend();
  const refresh = useAiRefresh();
  const lane = requestId ? "oauth" : "inapp";

  // the machine, with a ref the running steps read so a late answer always meets the current state
  const [s, setS] = useState<ConnectState>(() => connectStart(lane, lane === "oauth" ? "your AI" : "Claude"));
  const ref = useRef(s);
  const dispatch = useCallback((e: ConnectEvent) => {
    const next = connectReducer(ref.current, e);
    ref.current = next;
    setS(next);
  }, []);

  // the OAuth request: which app, from which host, until when (needs a session)
  const req = useQuery({
    queryKey: ["server", "oauthRequest", backend.key, requestId ?? ""],
    queryFn: () => backend.api.oauthRequest(requestId!),
    enabled: account.ready && !!requestId,
    // a request that is gone answers at once; anything else (offline, a server error) gets one more try
    retry: (n, e) => n < 1 && !(e instanceof ServerError && e.problem.kind === "notFound"),
    staleTime: Infinity,
  });
  useEffect(() => {
    if (req.data && ref.current.step === "form" && ref.current.terms.label !== req.data.clientName) dispatch({ type: "edit", patch: { label: req.data.clientName } });
  }, [req.data, dispatch]);
  useEffect(() => {
    if (req.error instanceof ServerError && req.error.problem.kind === "notFound") dispatch({ type: "requestExpired" });
  }, [req.error, dispatch]);

  const now = useNow(1_000);
  const hydrated = useHydrated();
  const expiresAt = req.data ? Date.parse(req.data.expiresAt) : null;
  const endsIn = expiresAt !== null ? clock(expiresAt, now) : null;
  useEffect(() => {
    if (expiresAt !== null && now >= expiresAt && (ref.current.step === "form" || ref.current.step === "confirming")) dispatch({ type: "requestExpired" });
  }, [now, expiresAt, dispatch]);

  // leaving while a step runs would strand it: the browser asks first
  const running = !connectDismissable(s);
  useEffect(() => {
    if (!running) return;
    const hold = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [running]);

  // ===== the steps =====
  const assistant = useRef<string | null>(null);
  const code = useRef("");
  // example: "not delegated yet" answers count as minutes passing, so the 30 s patience shows in a few seconds
  const virtual = useRef(0);
  const handled = useRef<ConnectState | null>(null);
  const ai = s.step === "form" || s.step === "confirming" || s.step === "running" || s.step === "failed" || s.step === "done" || s.step === "stepUp" || s.step === "denying" ? s.terms.label : (req.data?.clientName ?? "your AI");

  // what the steps read when they run, never what they started with: a balance refresh or a Mock row changing
  // mid-run neither restarts a step nor stalls one (the runner below is keyed on the state alone)
  const deps = useRef({ backend, account, refresh, requestId, lane, outcome: config.connect });
  useEffect(() => {
    deps.current = { backend, account, refresh, requestId, lane, outcome: config.connect };
  });

  const runStep = useCallback(
    async (s: ConnectState) => {
      const { backend, requestId, lane } = deps.current;
      const at = () => Date.now() + virtual.current;
      if (s.step === "confirming") {
        try {
          await backend.api.health();
        } catch {
          return dispatch({ type: "offline" });
        }
        try {
          const [me, cfg] = await Promise.all([backend.api.me(), backend.api.config()]);
          const key = backend.tradingKey.state();
          // /api/me lists only delegated keys: an Assistant made but never delegated comes from the key itself, and a
          // known address is never wiped by a missing row
          assistant.current = me.delegations.find((d) => d.status === "active")?.address ?? key.address ?? assistant.current;
          virtual.current = 0;
          dispatch({ type: "checked", delegated: me.delegations.some((d) => d.status === "active"), hasAssistant: key.hasAssistant, canDelegate: key.canDelegate, pocketIndex: me.nextPocketIndex, routers: cfg.routers, at: Date.now() });
        } catch {
          dispatch({ type: "offline" });
        }
        return;
      }
      if (s.step === "stepUp") {
        if (s.code === "sending") {
          let via: "code" | "passkey";
          try {
            via = await backend.tradingKey.stepUpSend();
          } catch (e) {
            // the code never went out: back to the form with why, so the person can Allow again or leave
            const p = sendCodeProblemOf(e, "send");
            return dispatch({ type: "cancel", banner: `${p === "rateLimited" ? SIGNIN_COPY.rateLimited : SIGNIN_COPY.service} ${CONNECT_COPY.stepUpCancelled}` });
          }
          dispatch(via === "passkey" ? { type: "passkeyAsk" } : { type: "codeSent", at: Date.now() });
        } else if (s.code === "verifying") {
          try {
            if (s.via === "passkey") await backend.tradingKey.stepUpPasskey();
            else await backend.tradingKey.stepUpVerify(code.current);
            dispatch({ type: "codeOk", at: Date.now() });
          } catch (e) {
            dispatch(s.via === "passkey" ? { type: "passkeyRejected", message: passkeyConfirmText(e) } : { type: "codeRejected", problem: codeProblemOf(e) });
          }
        }
        return;
      }
      if (s.step === "denying") {
        try {
          const r = await backend.api.oauthDeny(requestId!);
          dispatch({ type: "deniedDone", redirect: r.redirect });
        } catch (e) {
          if (e instanceof ServerError && e.problem.kind === "offline") dispatch({ type: "offline" });
          else dispatch({ type: "deniedDone" });
        }
        return;
      }
      if (s.step === "done") {
        deps.current.refresh();
        return;
      }
      if (s.step !== "running") return;
      const step: ConnectStep = s.at;
      try {
        if (step === "assistant") {
          const a = await backend.tradingKey.ensureAssistant();
          assistant.current = a;
          dispatch({ type: "assistantReady", address: a, at: Date.now() });
        } else if (step === "delegate") {
          try {
            await backend.tradingKey.delegate();
          } catch (e) {
            if ((e as Error).name === "StepUpNeeded") return dispatch({ type: "needStepUp" });
            throw e;
          }
          dispatch({ type: "delegated", at: Date.now() });
        } else if (step === "permission") {
          try {
            const { validUntil } = termsWire(s.terms, Date.now());
            const r = await backend.tradingKey.signPermission(s.run.pocketIndex, { routers: s.run.routers, perTradeCap: s.terms.perTradeCap, tradesPerDay: s.terms.tradesPerDay, validUntil });
            dispatch({ type: "permissionSigned", pocket: r.pocket, approval: r.approval, pocketBalance: r.pocketBalance, at: Date.now(), validUntil });
          } catch (e) {
            logStep(step, e);
            dispatch({ type: "stepFailed", problem: "sign" });
          }
        } else if (step === "funding") {
          try {
            // re-read the pocket first, so a resumed run never moves the money twice
            const pocket = s.run.pocket!;
            const have = (await backend.pocket(pocket)).balance;
            const need = Math.max(0, Math.round((s.terms.budget - have) * 100) / 100);
            // the free test dollars only when the account, read now, still needs them and may take them: a retry
            // after a drip that already landed never drips again
            const fresh = deps.current.account;
            if (s.run.withDrip && need > 0 && fresh.balance < need && fresh.canDrip) await fresh.drip();
            if (need > 0) await backend.fund(pocket, need);
            dispatch({ type: "funded", at: Date.now() });
            if (backend.example && deps.current.outcome === "expired" && lane === "oauth" && requestId) {
              backend.expireRequest(requestId);
              dispatch({ type: "requestExpired" });
            }
          } catch (e) {
            logStep(step, e);
            dispatch({ type: "stepFailed", problem: "funding" });
          }
        } else if (step === "registering") {
          if (!s.run.grantId) {
            // an Assistant that exists but was never delegated is not in /api/me: the key gives its address
            if (!assistant.current) assistant.current = await backend.tradingKey.ensureAssistant();
            const wire = { ...termsWire(s.terms, Date.now()), ...(s.run.validUntil ? { validUntil: s.run.validUntil } : {}) };
            const who = deps.current.account;
            try {
              const grant = await backend.api.createGrant({ ...wire, mainOwner: who.owner ?? who.address ?? "", assistantAddress: assistant.current, pocketIndex: s.run.pocketIndex, approval: s.run.approval ?? "" });
              // in-app: keep the connection first, then ask for its link (the next pass), so a link that fails
              // never makes a second connection
              if (lane === "inapp") return dispatch({ type: "created", grantId: grant.id });
              dispatch({ type: "registered", grantId: grant.id, at: Date.now() });
            } catch (e) {
              if (e instanceof ServerError && e.problem.kind === "notYet") {
                if (backend.example) virtual.current += 8_000;
                dispatch({ type: "notYet", at: at() });
                return;
              }
              dispatch({ type: "stepFailed", problem: e instanceof ServerError ? connectProblemOf(e.problem) : "offline" });
            }
            return;
          }
          // the connection is live: its link, shown once. If it doesn't come, it still finishes; done asks again.
          try {
            const connector = await backend.api.connector(s.run.grantId);
            dispatch({ type: "registered", grantId: s.run.grantId, connector, at: Date.now() });
          } catch {
            dispatch({ type: "registered", grantId: s.run.grantId, linkFailed: true, at: Date.now() });
          }
        } else if (step === "approving") {
          try {
            const r = await backend.api.oauthApprove(requestId!, s.run.grantId!);
            dispatch({ type: "approved", redirect: r.redirect });
          } catch (e) {
            if (e instanceof ServerError && e.problem.kind === "notFound") dispatch({ type: "requestExpired" });
            else dispatch({ type: "stepFailed", problem: "approve" });
          }
        }
      } catch (e) {
        logStep(step, e);
        dispatch({ type: "stepFailed", problem: "key" });
      }
    },
    [dispatch],
  );

  useEffect(() => {
    // a 409 "not delegated yet" asks again every 2 s, quietly. The timer is set again whenever this runs for the same
    // waiting state (a remount), and cleared only when the state moves on, so the wait never stalls.
    if (s.step === "running" && s.at === "registering" && s.waitingSince !== undefined) {
      const id = window.setTimeout(() => {
        if (ref.current === s) void runStep(s);
      }, NOT_YET_EVERY_MS);
      return () => window.clearTimeout(id);
    }
    if (handled.current === s) return;
    handled.current = s;
    void runStep(s);
  }, [s, runStep]);

  // back on the form with why (the code step was cancelled, or its code never went out): the step-up sheet's opener
  // left with the running steps, so focus would sit on the page itself; it goes to the line that says what happened
  const banner = useRef<HTMLParagraphElement>(null);
  const bannerText = s.step === "form" ? s.banner : undefined;
  useEffect(() => {
    if (!bannerText) return;
    const at = document.activeElement;
    if (!at || at === document.body) banner.current?.focus({ preventScroll: true });
  }, [bannerText]);

  /** Done in-app, but the link didn't come: ask for it again (it shows once; asking again replaces it). */
  const getLink = useCallback(async () => {
    const st = ref.current;
    if (st.step !== "done" || !st.linkFailed) return;
    const connector = await deps.current.backend.api.connector(st.grantId);
    dispatch({ type: "linkReady", connector });
  }, [dispatch]);

  // ===== page-level answers =====
  if (s.step === "ended" || s.step === "denied") {
    return (
      <Frame tone={tone} phone={config.phone}>
        <div className={c.whole}>
          {s.step === "ended" ? (
            <>
              <h1 className={c.h1}>{CONNECT_COPY.requestEnded}</h1>
              <p className={c.lead}>{CONNECT_COPY.requestEndedBody(ai === "your AI" ? "your AI app" : ai)}</p>
            </>
          ) : (
            <>
              <h1 className={c.h1}>{ai === "your AI" ? "Your AI" : ai} won't trade for you</h1>
              <p className={c.lead}>Nothing was set up. You can close this page.</p>
              <ExampleRedirect example={backend.fake} to={s.redirect} />
            </>
          )}
          <Link className="ag-btn ag-btn--ghost" href={`/app/ai${q}`}>
            Connected AIs
          </Link>
        </div>
      </Frame>
    );
  }

  const signedOut = !account.ready;
  const loadingReq = account.ready && lane === "oauth" && req.isPending;
  const reqFailed = account.ready && lane === "oauth" && req.isError && !(req.error instanceof ServerError && req.error.problem.kind === "notFound");
  const t = "terms" in s ? s.terms : defaultTerms(ai);
  const check = checkTerms(t, { balance: account.balance, canDrip: account.canDrip });
  const labelOk = t.label.trim().length > 0 && t.label !== "your AI";
  const name = signedOut && lane === "oauth" ? "your AI" : t.label || "your AI";
  const Name = name === "your AI" ? "Your AI" : name;
  const form = s.step === "form" || s.step === "confirming" || s.step === "denying";
  const edit = (patch: Partial<typeof t>) => dispatch({ type: "edit", patch });
  // the end date to the minute only once hydrated: the server's render and the browser's first one show the day alone
  // (a minute boundary between them would otherwise not match)
  const untilFull = whenText(new Date(now + t.days * 86_400_000).toISOString());
  const untilDay = untilFull.split(",")[0];
  const until = hydrated ? untilFull : untilDay;

  return (
    <Frame tone={tone} phone={config.phone}>
      <div className={c.grid}>
        <header className={`${c.panel} ${c.head}`}>
          <h1 className={`${c.h1} ${loadingReq ? "ag-skel ag-skel-on" : ""}`}>Let {name} trade for you</h1>
          <p className={c.lead}>
            {lane === "oauth"
              ? signedOut
                ? "An AI app is asking to trade on Agate for you. Sign in to see which one and set what it may use. It trades only from its own pocket, with test dollars you move into it."
                : `${Name} is asking to trade on Agate for you. It trades only from its own pocket, with test dollars you move into it now. When you answer, you go back to ${name}.`
              : "Choose how much your AI may use. It trades only from its own pocket, with test dollars you move into it now."}
          </p>
          {reqFailed && (
            <p className={c.err} role="alert">
              Can't reach Agate's server to read this request.{" "}
              <button className="ag-textbtn" type="button" onClick={() => void req.refetch()}>
                Try again
              </button>
            </p>
          )}
          {lane === "oauth" && req.data && <p className={c.fine}>Request from {req.data.redirectHost}</p>}
          {lane === "oauth" && form && endsIn && expiresAt !== null && expiresAt - now < 120_000 && <p className={c.err}>This request ends in {endsIn}. Allow before then.</p>}
          {s.step === "form" && s.banner && (
            <p ref={banner} className={c.err} role="status" tabIndex={-1}>
              {s.banner}
            </p>
          )}
        </header>

        <section className={`${c.panel} ${c.form}`} aria-label={form ? "Its pocket" : "Connecting"}>
          {form ? (
            <Fields s={s} t={t} lane={lane} check={check} signedOut={signedOut} name={name} until={until} edit={edit} />
          ) : (
            <Progress s={s} name={name} onGetLink={getLink} />
          )}
        </section>

        <aside className={`${c.panel} ${c.lists}`} aria-label="What it can and can never do">
          <div className={c.listBlock}>
            <h2 className={c.h2}>What {name} can do</h2>
            <ul>
              {["Go Long, Long with pay me daily, or Short on Agate's monthly markets", "Close the positions it opened", `Take the free ${int(DRIP)} test dollars a day for its pocket, from the same faucet you use`].map((x) => (
                <li key={x}>
                  <Yes />
                  {x}
                </li>
              ))}
            </ul>
          </div>
          <div className={c.listBlock}>
            <h2 className={c.h2}>What it can never do</h2>
            <ul>
              {[
                "Send your money anywhere else. Payouts always come to your account.",
                "Touch your account or anything outside its pocket",
                `Spend more than ${usd0(t.perTradeCap)} on a trade, trade more than ${t.tradesPerDay} ${t.tradesPerDay === 1 ? "time" : "times"} a day, or trade after ${untilDay}`,
                "Change where payouts go",
              ].map((x) => (
                <li key={x}>
                  <No />
                  {x}
                </li>
              ))}
            </ul>
          </div>
          <div className={c.listBlock}>
            <h2 className={c.h2}>How it's kept to this</h2>
            <p className={c.lead}>The limits are written into the pocket on Monad, so they hold even if Agate's server makes a mistake. Agate checks every trade again before Dynamic lets the key sign it.</p>
          </div>
        </aside>

        <div className={`${c.panel} ${c.actions}`}>
          <Actions s={s} name={name} lane={lane} signedOut={signedOut} loading={loadingReq} ok={check.ok && labelOk} check={check} dispatch={dispatch} example={backend.example} fake={backend.fake} />
        </div>
      </div>
      {s.step === "stepUp" && (
        <StepUp
          s={s}
          email={account.email ?? ""}
          dark={tone === "tone-dark"}
          phone={config.phone}
          onVerify={(v) => {
            code.current = v;
            dispatch({ type: "verify", code: v });
          }}
          onResend={() => dispatch({ type: "resend" })}
          onCancel={() => dispatch({ type: "cancel" })}
        />
      )}
    </Frame>
  );
}

function Actions(p: { s: ConnectState; name: string; lane: "oauth" | "inapp"; signedOut: boolean; loading: boolean; ok: boolean; check: ReturnType<typeof checkTerms>; dispatch: (e: ConnectEvent) => void; example: boolean; fake: boolean }) {
  const flow = useFlow();
  const q = useLinkQuery();
  const check = p.check;
  const backend = { example: p.example, fake: p.fake };
  const { s: st, name: n } = p;
  if (p.signedOut) {
    return (
      <>
        <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={() => flow.signInFor({ from: "connect", ai: p.lane === "oauth" ? undefined : n })}>
          {p.lane === "oauth" ? "Sign in to continue" : `Sign in to allow ${n}`}
        </button>
      </>
    );
  }
  if (st.step === "form" || st.step === "confirming" || st.step === "denying") {
    const busy = st.step !== "form";
    return (
      <>
        <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" disabled={busy || p.loading || !p.ok} onClick={() => p.dispatch({ type: "allow", check })}>
          {p.loading ? (
            "Loading"
          ) : st.step === "confirming" ? (
            <>
              <span className="ag-spinner" aria-hidden="true" />
              Checking
            </>
          ) : (
            `Allow ${n}`
          )}
        </button>
        <div className={c.actionsRow}>
          {p.lane === "oauth" ? (
            <button className="ag-textbtn" type="button" disabled={busy || p.loading} onClick={() => p.dispatch({ type: "deny" })}>
              {st.step === "denying" ? "Declining" : "Don't allow"}
            </button>
          ) : (
            <Link className="ag-textbtn" href={`/app/ai${q}`}>
              Not now
            </Link>
          )}
        </div>
      </>
    );
  }
  if (st.step === "running" || st.step === "stepUp") {
    return (
      <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" disabled>
        <span className="ag-spinner" aria-hidden="true" />
        Connecting
      </button>
    );
  }
  if (st.step === "failed") {
    const funded = connectFunded(st);
    const f = connectFailure(st.problem, { ai: n, budget: st.terms.budget, funded, tookBack: st.run.tookBack });
    return (
      <>
        {f.actions.includes("retry") && (
          <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={() => p.dispatch({ type: "retry", at: Date.now() })}>
            Try again
          </button>
        )}
        {f.actions.includes("startAgain") && (
          <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={() => p.dispatch({ type: "startAgain" })}>
            Start again
          </button>
        )}
        {f.actions.includes("takeBack") && st.run.pocket && (
          <button
            className={`ag-btn ${f.actions.includes("retry") ? "ag-btn--ghost" : "ag-btn--primary"} ag-btn--lg`}
            type="button"
            // the run hears the money came back, so this panel stops offering a pocket that is now empty
            onClick={() => flow.openPocket({ pocket: st.run.pocket!, ai: n, ended: true }, "takeBack", (moved) => p.dispatch({ type: "tookBack", moved }))}
          >
            Take back {usd0(st.terms.budget)}
          </button>
        )}
        {f.actions.includes("back") && (
          <Link className="ag-btn ag-btn--ghost ag-btn--lg" href={`/app/ai${q}`}>
            Connected AIs
          </Link>
        )}
      </>
    );
  }
  if (st.step === "done") {
    return st.lane === "oauth" ? (
      <BackTo name={n} redirect={st.redirect} example={backend.fake} pocketHref={`/app/ai/${encodeURIComponent(st.grantId)}${q}`} />
    ) : (
      <>
        <Link className="ag-btn ag-btn--primary ag-btn--lg" href={`/app/ai/${encodeURIComponent(st.grantId)}${q}`} onClick={() => p.dispatch({ type: "hideLink" })}>
          See {n}'s pocket
        </Link>
        {st.connector && (
          <div className={c.actionsRow}>
            <button className="ag-textbtn" type="button" onClick={() => p.dispatch({ type: "hideLink" })}>
              I've added the link
            </button>
          </div>
        )}
      </>
    );
  }
  return null;
}

function Frame({ tone, phone, children }: { tone: string; phone: string; children: React.ReactNode }) {
  return (
    <div className={`${c.screen} ${tone}`} data-phone={phone}>
      <NavBar active={null} />
      <main className={c.main}>{children}</main>
    </div>
  );
}

function Yes() {
  return (
    <svg className={c.yes} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
    </svg>
  );
}
function No() {
  return (
    <svg className={c.no} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
    </svg>
  );
}

type Terms = Extract<ConnectState, { step: "form" }>["terms"];

/** The four limits, their checks, and the plain summary (spec 9.4, 9.5). */
function Fields(p: { s: ConnectState; t: Terms; lane: "oauth" | "inapp"; check: ReturnType<typeof checkTerms>; signedOut: boolean; name: string; until: string; edit: (patch: Partial<Terms>) => void }) {
  const account = useAccount();
  const { t, check, edit } = p;
  const locked = p.s.step !== "form";
  const [budgetText, setBudgetText] = useState(String(t.budget));
  const [capText, setCapText] = useState(String(t.perTradeCap));
  const [other, setOther] = useState(false);
  const setBudget = (v: number) => {
    setBudgetText(String(v));
    edit({ budget: v });
  };
  const setCap = (v: number) => {
    setCapText(String(v));
    edit({ perTradeCap: v });
  };
  const balance = account.balance;
  return (
    <>
      {p.lane === "inapp" && (
        <div className={c.field}>
          <span className={c.fieldLabel} id="which-l">
            Which AI?
          </span>
          <div className={`ag-seg ag-seg--tall ${c.which}`} role="group" aria-labelledby="which-l">
            {WHICH.map((w) => (
              <button
                key={w}
                type="button"
                disabled={locked}
                aria-pressed={!other && t.label === w}
                onClick={() => {
                  setOther(false);
                  edit({ label: w });
                }}
              >
                {w}
              </button>
            ))}
            <button
              type="button"
              disabled={locked}
              aria-pressed={other}
              onClick={() => {
                setOther(true);
                edit({ label: "" });
              }}
            >
              Other
            </button>
          </div>
          {other && <input className="ag-input" aria-label="Its name" placeholder="Its name" enterKeyHint="done" maxLength={40} value={t.label} disabled={locked} onChange={(e) => edit({ label: e.target.value })} />}
        </div>
      )}
      <h2 className={c.h2}>Its pocket</h2>
      <div className={c.field}>
        <label className={c.fieldLabel} htmlFor="f-budget">
          Move into its pocket
        </label>
        <div className={c.fieldRow}>
          <input
            id="f-budget"
            className={`ag-input ${c.amount}`}
            inputMode="decimal"
            enterKeyHint="done"
            disabled={locked}
            aria-invalid={!!check.budget || undefined}
            aria-describedby="f-budget-h"
            value={`$${budgetText}`}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, "");
              setBudgetText(v);
              edit({ budget: parseAmount(v) ?? 0 });
            }}
          />
          <div className="ag-chips" role="group" aria-label="Pocket amount">
            {BUDGET_CHIPS.map((v) => (
              <button key={v} type="button" disabled={locked} aria-pressed={t.budget === v} onClick={() => setBudget(v)}>
                {usd0(v)}
              </button>
            ))}
          </div>
        </div>
        <p id="f-budget-h" className={check.budget && !p.signedOut ? c.err : c.helper} aria-live="polite">
          {p.signedOut ? (
            "You can take back what's left at any time."
          ) : check.budget === "over" ? (
            <>
              More than your {usd0(balance)} test dollars.
              {balance > 0 && (
                <button className="ag-textbtn" type="button" onClick={() => setBudget(Math.floor(balance))}>
                  Use {usd0(Math.floor(balance))}
                </button>
              )}
            </>
          ) : check.budget === "zero" ? (
            "Enter an amount above 0."
          ) : check.withDrip ? (
            `You have ${usd0(balance)}. Allowing also gets your free ${int(DRIP)} test dollars first.`
          ) : (
            `You have ${usd0(balance)}. You can take back what's left at any time.`
          )}
        </p>
      </div>
      <div className={c.field}>
        <label className={c.fieldLabel} htmlFor="f-cap">
          Most it can spend on one trade
        </label>
        <div className={c.fieldRow}>
          <input
            id="f-cap"
            className={`ag-input ${c.amount}`}
            inputMode="decimal"
            enterKeyHint="done"
            disabled={locked}
            aria-invalid={!!check.perTradeCap || undefined}
            aria-describedby="f-cap-h"
            value={`$${capText}`}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, "");
              setCapText(v);
              edit({ perTradeCap: parseAmount(v) ?? 0 });
            }}
          />
          <div className="ag-chips" role="group" aria-label="Most on one trade">
            {PER_TRADE_CHIPS.map((v) => (
              <button key={v} type="button" disabled={locked} aria-pressed={t.perTradeCap === v} onClick={() => setCap(v)}>
                {usd0(v)}
              </button>
            ))}
          </div>
        </div>
        <p id="f-cap-h" className={check.perTradeCap ? c.err : c.helper} aria-live="polite">
          {check.perTradeCap === "overBudget" ? `Can't be more than the pocket's ${usd0(t.budget)}.` : check.perTradeCap === "zero" ? "Enter an amount above 0." : "Shorts are sized so they never tie up more than this."}
        </p>
      </div>
      <div className={c.field}>
        <span className={c.fieldLabel} id="f-trades-l">
          Trades a day
        </span>
        <div className={c.stepper} role="group" aria-labelledby="f-trades-l">
          <button type="button" aria-label="One fewer" disabled={locked || t.tradesPerDay <= TRADES_PER_DAY.min} onClick={() => edit({ tradesPerDay: t.tradesPerDay - 1 })}>
            −
          </button>
          <output aria-live="polite">{t.tradesPerDay}</output>
          <button type="button" aria-label="One more" disabled={locked || t.tradesPerDay >= TRADES_PER_DAY.max} onClick={() => edit({ tradesPerDay: t.tradesPerDay + 1 })}>
            +
          </button>
        </div>
        <p className={c.helper}>Counted over the last 24 hours.</p>
      </div>
      <div className={c.field}>
        <span className={c.fieldLabel} id="f-ends-l">
          Ends
        </span>
        <div className={c.fieldRow}>
          <div className="ag-chips" role="group" aria-labelledby="f-ends-l">
            {DAYS_CHIPS.map((d) => (
              <button key={d} type="button" disabled={locked} aria-pressed={t.days === d} onClick={() => edit({ days: d })}>
                {d} {d === 1 ? "day" : "days"}
              </button>
            ))}
          </div>
          <span className={c.ends}>{p.until}</span>
        </div>
        <p className={c.helper}>Up to {MAX_DAYS} days. After that it can't trade, and what's left stays in the pocket for you.</p>
      </div>
      <p className="ag-well">
        {p.name === "your AI" ? "Your AI" : p.name} can spend up to {usd0(t.perTradeCap)} a trade, up to {t.tradesPerDay} {t.tradesPerDay === 1 ? "trade" : "trades"} a day, until {p.until}, from a pocket that starts with {usd0(t.budget)}.
      </p>
      <p className={c.fine}>You can disconnect {p.name === "your AI" ? "it" : p.name} at any time in Connected AIs.</p>
    </>
  );
}

const STEP_TEXT = (step: ConnectStep, name: string, budget: number, lane: "oauth" | "inapp", withDrip: boolean): { label: string; hint?: string } => {
  switch (step) {
    case "assistant":
      return { label: "Making a trading key for your AIs", hint: "About 6 seconds, only the first time you connect an AI." };
    case "delegate":
      return { label: "Letting Agate use that key, only inside pockets", hint: "About 6 seconds, through Dynamic." };
    case "permission":
      return { label: `Writing the limits into ${name}'s pocket`, hint: "Your wallet signs once." };
    case "funding":
      return { label: `Moving ${usd0(budget)} into the pocket`, hint: withDrip ? `Your free ${int(DRIP)} test dollars come first, in the same step. About 6 seconds on Monad.` : "About 6 seconds on Monad." };
    default:
      return { label: lane === "oauth" ? `Telling ${name} it's allowed` : "Telling Agate" };
  }
};

/** The steps after Allow, in place of the form; then the result. */
function Progress({ s, name, onGetLink }: { s: ConnectState; name: string; onGetLink: () => Promise<void> }) {
  const now = useNow(1_000, s.step === "running");
  if (s.step === "done") {
    const { budget, perTradeCap } = s.terms;
    return (
      <>
        <Check size={44} />
        <h2 className={c.h2big}>{name} is connected</h2>
        <p className={c.lead}>
          It can spend up to {usd0(perTradeCap)} a trade from a {usd0(budget)} pocket until {whenText(new Date(Date.now() + s.terms.days * 86_400_000).toISOString())}.
          {s.lane === "oauth" ? ` Taking you back to ${name}.` : ""}
        </p>
        {s.lane === "inapp" &&
          (s.connector ? (
            <div className={c.link}>
              <p className={c.lead}>Add this link to your AI app.</p>
              <input className="ag-input" readOnly aria-label="Your AI's link" value={s.connector.url} onFocus={(e) => e.currentTarget.select()} />
              <div className={c.linkActs}>
                <CopyButton text={s.connector.url} what="the link" />
                {s.connector.claudeCode && <CopyButton text={s.connector.claudeCode} label="Copy the Claude Code line" what="the Claude Code line" />}
              </div>
              <p className={c.fine}>Treat this link like a password: anyone with it can use this AI connection. It shows only once.</p>
            </div>
          ) : s.linkFailed ? (
            <LinkAgain name={name} onGetLink={onGetLink} />
          ) : (
            <p className={c.fine}>The link showed once. To get a new one, disconnect {name} and connect it again.</p>
          ))}
      </>
    );
  }
  if (!("run" in s)) return null;
  const marks = connectMarks(s);
  const withDrip = s.run.withDrip;
  // registering and approving share the last row
  const rows: StepRow[] = [];
  for (const m of marks) {
    if (m.step === "approving") {
      const last = rows[rows.length - 1];
      if (last && (m.mark === "current" || m.mark === "failed" || (m.mark === "waiting" && last.mark === "done"))) last.mark = m.mark === "waiting" ? "current" : m.mark;
      continue;
    }
    rows.push({ key: m.step, ...STEP_TEXT(m.step, name, s.terms.budget, s.lane, withDrip), mark: m.mark });
  }
  const slow = s.step === "running" && s.waitingSince === undefined && now - s.startedAt > SLOW_MS;
  const fail = s.step === "failed" ? connectFailure(s.problem, { ai: name, budget: s.terms.budget, funded: connectFunded(s), tookBack: s.run.tookBack }) : null;
  return (
    <>
      <h2 className={c.h2big}>{s.step === "failed" ? `${name} isn't connected yet` : `Connecting ${name}`}</h2>
      <p className={c.lead}>{s.step === "failed" ? "Here is where it stopped." : "Keep this page open. This takes about 20 seconds."}</p>
      <Steps rows={rows} label={`Connecting ${name}`} />
      {slow && <p className={c.fine}>{CONNECT_COPY.slow}</p>}
      {fail && (
        <p className={c.err} role="alert">
          {fail.message}
        </p>
      )}
    </>
  );
}

/** Connected, but its link didn't come: ask again here (never by connecting a second time). */
function LinkAgain({ name, onGetLink }: { name: string; onGetLink: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className={c.link}>
      <p className={c.lead}>{name} is connected, but its link didn't come through. Get it now to add it to your AI app.</p>
      <div className={c.linkActs}>
        <button
          className="ag-btn ag-btn--ghost"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(false);
            try {
              await onGetLink();
            } catch {
              setError(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <>
              <span className="ag-spinner" aria-hidden="true" />
              Getting the link
            </>
          ) : (
            "Get the link"
          )}
        </button>
      </div>
      <p className={c.err} aria-live="polite">
        {error ? "Can't reach Agate right now. Try again in a moment." : ""}
      </p>
    </div>
  );
}

/** OAuth done: back to the AI app after 3 s unless the person does anything first. The pretend server's redirect is
 *  made up, so it never leaves (example data, and live until the real server lands). */
function BackTo({ name, redirect, example, pocketHref }: { name: string; redirect?: string; example: boolean; pocketHref: string }) {
  const [auto, setAuto] = useState(true);
  const [note, setNote] = useState(false);
  // a return address that could run script in this page is never opened (the person goes back to the app themselves)
  const target = safeReturn(redirect);
  const go = useCallback(() => {
    if (!redirect) return;
    if (example) setNote(true);
    else if (target) window.location.assign(target);
    else setNote(true);
  }, [redirect, example, target]);
  useEffect(() => {
    if (!auto) return;
    const stop = () => setAuto(false);
    window.addEventListener("pointerdown", stop);
    window.addEventListener("keydown", stop);
    const id = window.setTimeout(go, 3_000);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", stop);
    };
  }, [auto, go]);
  return (
    <>
      <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={go}>
        Back to {name}
      </button>
      <div className={c.actionsRow}>
        <Link className="ag-textbtn" href={pocketHref}>
          See {name}'s pocket
        </Link>
      </div>
      {note && (
        <p className={c.fine} role="status" style={{ textAlign: "center" }}>
          {example ? `Practice: this is where the page returns to ${name}.` : `${name}'s return address can't be opened from here. Go back to ${name} yourself; it is connected.`}
        </p>
      )}
    </>
  );
}

function ExampleRedirect({ example, to }: { example: boolean; to?: string }) {
  useEffect(() => {
    // never a return address that could run script in this page
    const target = safeReturn(to);
    if (!example && target) {
      const id = window.setTimeout(() => window.location.assign(target), 1_500);
      return () => window.clearTimeout(id);
    }
  }, [example, to]);
  return null;
}

/** "Confirm it's you": a fresh code, when letting Agate use the trading key needs one (the first Connect after a
 *  sign-in always does). An account with a
 *  passkey confirms with it instead: one tap opens the browser's dialog (a tap, so Safari lets it open). */
function StepUp(p: { s: Extract<ConnectState, { step: "stepUp" }>; email: string; dark: boolean; phone: string; onVerify: (code: string) => void; onResend: () => void; onCancel: () => void }) {
  const [v, setV] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const checking = p.s.code === "verifying";
  const sending = p.s.code === "sending";
  const passkey = p.s.via === "passkey";
  const canPasskey = usePasskeySupport();
  // the code field leaves when the sheet turns to the passkey: focus goes to its button, not the page
  useEffect(() => {
    if (passkey) box.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [passkey]);
  // like every Flow sheet: Tab stays inside, focus goes back where it was on close
  useModalFocus(box, true);
  useEffect(() => {
    box.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (p.s.problem === "wrong") setV("");
  }, [p.s.problem]);
  const { onCancel } = p;
  useEffect(() => {
    if (checking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checking, onCancel]);
  if (passkey)
    return (
      <div className={`ag-backdrop ${p.dark ? "tone-dark" : "tone-light"}`} data-phone={p.phone} data-kind="stepup">
        <div ref={box} className="ag-sheet" role="dialog" aria-modal="true" aria-labelledby="stepup-h" tabIndex={-1}>
          <div className="grid gap-[18px]">
            <h2 id="stepup-h">Confirm it's you</h2>
            <p>Letting an AI trade needs a fresh check. Your account has a passkey, so use it here.</p>
            <p className="ag-err" aria-live="polite">
              {!canPasskey ? passkeyConfirmText({ name: "NoWebAuthNSupportError" }) : (p.s.passkeyMessage ?? "")}
            </p>
            <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" disabled={checking || !canPasskey} onClick={() => p.onVerify("")}>
              {checking ? (
                <>
                  <span className="ag-spinner" aria-hidden="true" />
                  Checking
                </>
              ) : (
                "Use your passkey"
              )}
            </button>
            <button className="ag-btn ag-btn--quiet" type="button" disabled={checking} onClick={p.onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div className={`ag-backdrop ${p.dark ? "tone-dark" : "tone-light"}`} data-phone={p.phone} data-kind="stepup">
      <div ref={box} className="ag-sheet" role="dialog" aria-modal="true" aria-labelledby="stepup-h" tabIndex={-1}>
        <form
          className="grid gap-[18px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (!checking && !sending) p.onVerify(cleanCode(v));
          }}
        >
          <h2 id="stepup-h">Confirm it's you</h2>
          {/* while sending, it is not known yet whether a code goes out (an account with a passkey uses that instead) */}
          <p>{sending ? "Letting an AI trade needs a fresh check. Getting it ready." : `Letting an AI trade needs a fresh code. We sent one to ${p.email}.`}</p>
          <div className="grid gap-2">
            <input
              className="ag-input ag-code"
              aria-label="6-digit code"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              enterKeyHint="done"
              readOnly={checking || sending}
              aria-invalid={!!p.s.problem || undefined}
              aria-describedby="stepup-err"
              value={v}
              onChange={(e) => {
                const x = cleanCode(e.target.value).replace(/\D/g, "").slice(0, 6);
                setV(x);
                if (x.length === 6 && !checking && !sending) p.onVerify(x);
              }}
            />
            <p id="stepup-err" className="ag-err" aria-live="polite">
              {p.s.problem ? codeProblemText(p.s.problem) : ""}
            </p>
          </div>
          <button className="ag-btn ag-btn--primary ag-btn--lg" type="submit" disabled={checking || sending || v.length < 6}>
            {checking ? (
              <>
                <span className="ag-spinner" aria-hidden="true" />
                Checking
              </>
            ) : (
              "Confirm"
            )}
          </button>
          <div className="ag-textrow">
            <button className="ag-textbtn" type="button" disabled={checking || sending} onClick={p.onResend}>
              Send a new code
            </button>
            <button className="ag-textbtn" type="button" disabled={checking} onClick={p.onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
