"use client";
// The sign-in sheet (wallet spec 4, screens 1 to 3): an email for a 6-digit code (or Google, or a passkey added from the
// account), the code, then, once per new person, "Setting up your account" with the first 10,000 test dollars. Every
// step is the account's sign-in machine (machine.ts) as useAccount() reports it; this sheet only shows it and sends
// the person's taps back.
import { useEffect, useRef, useState } from "react";
import { useAccount } from "@/lib/account";
import { codeProblemText, SIGNIN_COPY } from "@/lib/account/errors";
import { cleanCode, creatingSlow, isEmail, resendWait } from "@/lib/account/machine";
import { DRIP, type SignInStep } from "@/lib/account/types";
import { int, usd0 } from "@/lib/format";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { finePointer, usePasskeySupport } from "@/lib/ui/hooks";
import { useNow } from "@/lib/ui/useNow";
import { DripButton } from "./DripButton";
import { Check, Steps } from "./Steps";

/** Where the sheet was opened from: it sets the heading and the last button. */
export type SignInFrom = "trade" | "nav" | "connect" | "approve";

/** Google shows on the pretend account (the round trip is pretended) and once the Google client is set up. */
const GOOGLE = process.env.NEXT_PUBLIC_GOOGLE_SIGNIN === "on";

/** The pretend account outside example data (live, until the real account lands): no email is ever sent, so the
 *  sheet says so instead of promising a code. Example data shows the real copy, as the screens being judged. */
function usePractice() {
  const account = useAccount();
  const example = useMock().config.source === "example";
  return account.kind === "pretend" && !example;
}

/** Whether the sheet must stay open: checking a code, the way back from Google, setting up, or a setup that failed. */
export function signInLocked(s: SignInStep) {
  return s.status === "verifying" || s.status === "creating" || (s.status === "error" && s.at === "wallet");
}

export function SignInSheet({ from, ai, onFinished, onClose }: { from: SignInFrom; ai?: string; onFinished: () => void; onClose: () => void }) {
  const account = useAccount();
  const step = account.signIn;
  // set up during this sheet: the finish shows "You're set" with a button instead of moving on by itself
  const [setUp, setSetUp] = useState(false);
  useEffect(() => {
    if (step.status === "creating") setSetUp(true);
  }, [step.status]);
  // a returning person: on to where they were going as soon as the code signs in
  const finished = useRef(false);
  useEffect(() => {
    if (account.ready && !setUp && !finished.current) {
      finished.current = true;
      onFinished();
    }
  }, [account.ready, setUp, onFinished]);

  // every step change: when the control that held focus left with the last step (or was switched off while it
  // works), focus moves to the new step's heading, so a screen reader hears the step and Tab starts inside the sheet
  const box = useRef<HTMLDivElement>(null);
  useStepFocus(box);

  let body: React.ReactNode;
  if (step.status === "creating" || (step.status === "error" && step.at === "wallet") || (account.ready && setUp)) {
    body = <Creating step={step} from={from} onFinished={onFinished} />;
  } else if (step.status === "verifying" && step.via === "google") {
    body = (
      <div className="grid justify-items-center gap-4 py-6 text-center">
        <span className="ag-spinner" />
        <h2 tabIndex={-1}>Signing you in</h2>
        <p>Back from Google. This takes a moment.</p>
      </div>
    );
  } else if (step.status === "verifying" && step.via === "passkey") {
    body = (
      <div className="grid justify-items-center gap-4 py-6 text-center">
        <span className="ag-spinner" />
        <h2 tabIndex={-1}>Use your passkey</h2>
        <p>Your browser asks for the passkey you saved for Agate.</p>
      </div>
    );
  } else if (step.status === "codeSent" || step.status === "verifying" || (step.status === "sendingCode" && step.resend)) {
    // a new code on its way keeps the code step on screen, its resend control busy
    body = <CodeStep step={step} />;
  } else body = <EmailStep step={step} from={from} ai={ai} onClose={onClose} />;
  // no box of its own: the steps stay the sheet's grid items
  return (
    <div ref={box} style={{ display: "contents" }}>
      {body}
    </div>
  );
}

/** After the first render, each render checks focus: lost to the page, outside the sheet, or on a control that was
 *  just switched off, it goes to the step's heading (or the sheet). The first render is left to the sheet's own
 *  focus, which also remembers the opener to return to. */
function useStepFocus(box: React.RefObject<HTMLDivElement | null>) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const b = box.current;
    const sheet = b?.closest<HTMLElement>('[role="dialog"]');
    if (!b || !sheet) return;
    const at = document.activeElement as HTMLElement | null;
    const inside = !!at && at !== document.body && sheet.contains(at) && !(at as HTMLButtonElement).disabled;
    if (inside) return;
    // focus another dialog holds (the Mock controls) is not this sheet's to take
    if (at && at !== document.body && !sheet.contains(at) && at.closest('[role="dialog"]')) return;
    (b.querySelector<HTMLElement>("h2[tabindex]") ?? sheet).focus({ preventScroll: true });
  });
}

function EmailStep({ step, from, ai, onClose }: { step: SignInStep; from: SignInFrom; ai?: string; onClose: () => void }) {
  const linkQuery = useLinkQuery();
  const account = useAccount();
  const practice = usePractice();
  const passkeys = usePasskeySupport();
  const kept = "email" in step && step.email ? step.email : "";
  const [email, setEmail] = useState(kept);
  const [bad, setBad] = useState(false);
  const sending = step.status === "sendingCode";
  const failed = step.status === "error" ? step.message : null;
  const title = from === "trade" ? "Sign in to trade" : from === "connect" ? `Sign in to connect ${ai ?? "your AI"}` : "Sign in";
  return (
    <form
      className="grid gap-[18px]"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (sending) return;
        if (!isEmail(email)) return setBad(true);
        setBad(false);
        account.startSignIn(email);
      }}
    >
      <h2 tabIndex={-1}>{title}</h2>
      <p>
        {practice
          ? "Practice sign-in for now: no email is sent, and any 6 digits work as the code. We set up your account and pay the network fees, so there is nothing to install."
          : "Use your email. We send you a 6-digit code, set up your account and pay the network fees, so there is nothing to install."}
      </p>
      <div className="grid gap-2">
        <input
          id="email"
          className="ag-input"
          type="email"
          placeholder="you@example.com"
          aria-label="Email"
          autoComplete="email"
          inputMode="email"
          enterKeyHint="send"
          aria-invalid={bad || undefined}
          aria-describedby="email-msg"
          readOnly={sending}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setBad(false);
          }}
        />
        <p id="email-msg" className="ag-err" aria-live="polite">
          {!account.configured ? SIGNIN_COPY.notSetUp : bad ? SIGNIN_COPY.badEmail : failed}
        </p>
      </div>
      <button className="ag-btn ag-btn--primary ag-btn--lg" type="submit" disabled={sending || !account.configured}>
        {sending ? (
          <>
            <span className="ag-spinner" aria-hidden="true" />
            Sending code
          </>
        ) : (
          "Send code"
        )}
      </button>
      {(account.kind === "pretend" || GOOGLE) && (
        <button className="ag-btn ag-btn--ghost ag-btn--lg" type="button" disabled={sending || !account.configured} onClick={() => account.startGoogle()}>
          Continue with Google
        </button>
      )}
      {passkeys && (
        <button className="ag-btn ag-btn--ghost ag-btn--lg" type="button" disabled={sending || !account.configured} onClick={() => account.startPasskey()}>
          Sign in with a passkey
        </button>
      )}
      <button className="ag-btn ag-btn--quiet" type="button" onClick={onClose}>
        Not now
      </button>
      {/* Google's consent screen asks for the policy to be reachable where sign-in happens; a new tab keeps this step */}
      <p className="ag-fine">
        We use your email only to run your account.{" "}
        <a href={`/privacy${linkQuery}`} target="_blank" rel="noopener">
          Privacy
        </a>
      </p>
    </form>
  );
}

function CodeStep({ step }: { step: Extract<SignInStep, { status: "codeSent" | "verifying" | "sendingCode" }> }) {
  const account = useAccount();
  const practice = usePractice();
  const [code, setCode] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const checking = step.status === "verifying";
  // a new code on its way: the step stays, and the control that asked for it shows the wait
  const sending = step.status === "sendingCode";
  const problem = step.status === "codeSent" ? step.problem : undefined;
  const now = useNow(1_000, step.status === "codeSent");
  const wait = step.status === "codeSent" ? resendWait(step, now) : 0;
  // the code had to be replaced (expired, too many tries): "Send a new code" is the main button, also while it sends
  const [mainResend, setMainResend] = useState(false);
  useEffect(() => {
    if (step.status === "codeSent") setMainResend(problem === "expired" || problem === "tooMany");
  }, [step.status, problem]);
  const mustResend = problem === "expired" || problem === "tooMany" || (sending && mainResend);

  // a code that did not sign in stays in the field, selected, ready to type over; a new code empties it
  useEffect(() => {
    if (problem === "wrong") field.current?.select();
  }, [problem]);
  // checking a code reports no sentAt: only a code sent later than the one in the field clears it
  const sentAt = step.status === "codeSent" ? step.sentAt : null;
  const lastSent = useRef<number | null>(null);
  useEffect(() => {
    if (sentAt === null || sentAt === lastSent.current) return;
    lastSent.current = sentAt;
    setCode("");
    if (finePointer()) field.current?.focus();
  }, [sentAt]);

  const submit = (c: string) => {
    if (checking || sending || mustResend) return;
    account.verifyCode(cleanCode(c));
  };
  const busy = checking || sending;
  const message = problem ? codeProblemText(problem) : step.status === "codeSent" && step.resent ? SIGNIN_COPY.resent : "";
  const sendingNew = (
    <>
      <span className="ag-spinner" aria-hidden="true" />
      Sending a new code
    </>
  );
  return (
    <form
      className="grid gap-[18px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (sending) return;
        if (mustResend) account.resendCode();
        else submit(code);
      }}
    >
      <h2 tabIndex={-1}>Check your email</h2>
      <p>
        {practice ? (
          <>Practice sign-in: no email was sent. Enter any 6 digits.</>
        ) : (
          <>
            Enter the 6-digit code we sent to <b className="font-medium text-[var(--ink)]">{step.email}</b>.
          </>
        )}
      </p>
      <div className="grid gap-2">
        <input
          ref={field}
          className="ag-input ag-code"
          aria-label="6-digit code"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          enterKeyHint="done"
          readOnly={busy}
          aria-invalid={problem === "wrong" || undefined}
          aria-describedby="code-msg"
          value={code}
          onChange={(e) => {
            const v = cleanCode(e.target.value).replace(/\D/g, "").slice(0, 6);
            setCode(v);
            if (v.length === 6) submit(v);
          }}
        />
        <p id="code-msg" className={problem && problem !== "expired" ? "ag-err" : "ag-fine"} aria-live="polite">
          {/* the busy control says it on screen; this line says it to a screen reader */}
          {sending ? <span className="sr-only">Sending a new code.</span> : message}
        </p>
      </div>
      <button className="ag-btn ag-btn--primary ag-btn--lg" type="submit" disabled={busy || (!mustResend && code.length < 6) || (mustResend && wait > 0)}>
        {checking ? (
          <>
            <span className="ag-spinner" aria-hidden="true" />
            Checking
          </>
        ) : mustResend ? (
          sending ? sendingNew : "Send a new code"
        ) : (
          "Sign in"
        )}
      </button>
      <div className="ag-textrow">
        {/* an expired code already offers "Send a new code" as the main button */}
        {mustResend ? (
          <span />
        ) : (
          <button type="button" className="ag-textbtn" disabled={busy || wait > 0} onClick={() => account.resendCode()}>
            {sending ? sendingNew : wait > 0 ? `Send a new code in 0:${String(wait).padStart(2, "0")}` : "Send a new code"}
          </button>
        )}
        <button type="button" className="ag-textbtn" disabled={busy} onClick={() => account.otherEmail()}>
          Use a different email
        </button>
      </div>
    </form>
  );
}

function Creating({ step, from, onFinished }: { step: SignInStep; from: SignInFrom; onFinished: () => void }) {
  const account = useAccount();
  const now = useNow(1_000, step.status === "creating");
  const failed = step.status === "error" && step.at === "wallet";
  const email = "email" in step && step.email ? step.email : (account.email ?? "");

  if (account.ready) {
    const dripFailed = step.status === "ready" && step.firstDripFailed;
    if (dripFailed) {
      return (
        <>
          <h2 tabIndex={-1}>Your account is ready</h2>
          <p>{SIGNIN_COPY.dripFailed}</p>
          <DripButton />
          <button className="ag-btn ag-btn--quiet" type="button" onClick={onFinished}>
            Later
          </button>
        </>
      );
    }
    return (
      <>
        <Check size={44} />
        <h2 tabIndex={-1}>You're set</h2>
        <p>{usd0(account.balance)} in test dollars, ready to trade.</p>
        <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={onFinished}>
          {from === "trade" ? "Review trade" : from === "connect" || from === "approve" ? "Continue" : "Start trading"}
        </button>
      </>
    );
  }

  const part = step.status === "creating" ? step.part : "wallet";
  const slow = step.status === "creating" && creatingSlow(step, now);
  return (
    <>
      <h2 tabIndex={-1}>Setting up your account</h2>
      <p>This happens once and takes about 15 seconds.</p>
      <Steps
        label="Setting up"
        rows={[
          { key: "in", label: `Signed in as ${email}`, mark: "done" },
          { key: "wallet", label: "Making your wallet", hint: "About 10 seconds. Dynamic makes its key in parts, so no single party holds all of it.", mark: failed ? "failed" : part === "wallet" ? "current" : "done" },
          { key: "dollars", label: `Adding your ${int(DRIP)} free test dollars`, hint: "About 6 seconds on Monad's test network. Network fees are on Agate.", mark: failed || part === "wallet" ? "waiting" : "current" },
        ]}
      />
      <div className="ag-slot">
        {slow && <p className="ag-fine">{SIGNIN_COPY.slow}</p>}
        {failed && (
          <>
            <p className="ag-err" aria-live="polite">
              {step.message}
            </p>
            <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={() => account.retry()}>
              Try again
            </button>
            <button className="ag-btn ag-btn--ghost" type="button" onClick={() => void account.signOut()}>
              Sign out
            </button>
          </>
        )}
      </div>
    </>
  );
}
