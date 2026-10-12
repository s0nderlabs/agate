"use client";
// The sign-in sheet (wallet spec 4, screens 1 to 3): an email for a 6-digit code (or Google, or a passkey: with
// passkey-first on, "Continue with a passkey" signs in or makes a new account; otherwise the passkey added from the
// account), the code, then, once per new person, "Setting up your account" with the first 10,000 test dollars. Every
// step is the account's sign-in machine (machine.ts) as useAccount() reports it; this sheet only shows it and sends
// the person's taps back.
import { useEffect, useRef, useState } from "react";
import { useAccount } from "@/lib/account";
import { codeProblemText, SIGNIN_COPY } from "@/lib/account/errors";
import { cleanCode, creatingSlow, isBackupCode, isEmail, resendWait } from "@/lib/account/machine";
import { DRIP, type PasskeyFailure, type SignInStep } from "@/lib/account/types";
import { int, usd0 } from "@/lib/format";
import { useLinkQuery, useMock } from "@/lib/mock/store";
import { finePointer, usePasskeySupport } from "@/lib/ui/hooks";
import { useNow } from "@/lib/ui/useNow";
import { PasskeyCodeForm, usePasskeyAdd } from "./AccountSheet";
import { BackupCodes } from "./BackupCodes";
import bc from "./backupCodes.module.css";
import { DripButton } from "./DripButton";
import { GoogleG, PasskeyMark } from "./Marks";
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
  // "Lost your passkey? Use a backup code": the code step, until Back (its failures stay on it). The typed code lives
  // here, so it is still in the field after the browser's dialog (the step is off screen meanwhile)
  const [backup, setBackup] = useState(false);
  const [backupCode, setBackupCode] = useState("");
  // into or out of the code step: a failure from the other side is not this side's to show
  const toBackup = (on: boolean) => {
    if (step.status === "error") account.cancelSignIn();
    setBackup(on);
  };
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
    // the browser's own dialog is up: saving a new passkey (a new account, or one a backup code gets back), or
    // picking one saved before
    const mode = step.passkeyMode;
    body = (
      <div className="grid justify-items-center gap-4 py-6 text-center">
        <span className="ag-spinner" />
        <h2 tabIndex={-1}>{mode === "recover" ? "Make your new passkey" : mode === "create" ? "Make your passkey" : "Use your passkey"}</h2>
        <p>
          {mode === "recover"
            ? "Agate checks your code, then your browser asks to save a new passkey for your account. Use your fingerprint, face or device PIN."
            : mode === "create"
              ? "Your browser asks to save a passkey for Agate. Use your fingerprint, face or device PIN."
              : "Your browser asks for the passkey you saved for Agate."}
        </p>
      </div>
    );
  } else if (backup && (step.status === "signedOut" || step.status === "error")) {
    body = (
      <BackupCodeStep
        step={step}
        code={backupCode}
        setCode={setBackupCode}
        onBack={() => toBackup(false)}
        // the new passkey (or one this device has already) signs in like "I already have a passkey", its failures
        // said on the first step
        onPasskey={() => {
          setBackup(false);
          account.continuePasskey("signin");
        }}
      />
    );
  } else if (step.status === "codeSent" || step.status === "verifying" || (step.status === "sendingCode" && step.resend)) {
    // a new code on its way keeps the code step on screen, its resend control busy
    body = <CodeStep step={step} />;
  } else body = <EmailStep step={step} from={from} ai={ai} onClose={onClose} onBackup={() => toBackup(true)} />;
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

function EmailStep({ step, from, ai, onClose, onBackup }: { step: SignInStep; from: SignInFrom; ai?: string; onClose: () => void; onBackup: () => void }) {
  const linkQuery = useLinkQuery();
  const account = useAccount();
  const practice = usePractice();
  const passkeys = usePasskeySupport();
  const kept = "email" in step && step.email ? step.email : "";
  const [email, setEmail] = useState(kept);
  const [bad, setBad] = useState(false);
  const sending = step.status === "sendingCode";
  // a Google or passkey failure is said under those buttons; only the email's own failures go under its field
  const viaProvider = step.status === "error" && (step.at === "google" || step.at === "passkey");
  const failed = step.status === "error" && !viaProvider ? step.message : null;
  const title = from === "trade" ? "Sign in to trade" : from === "connect" ? `Sign in to connect ${ai ?? "your AI"}` : "Sign in";
  const google = account.kind === "pretend" || GOOGLE;
  // passkey-first: one button that signs in or makes a new account, its ceremonies fetched while the sheet is open
  const pkFirst = account.passkeyFirst && passkeys;
  const { preparePasskey } = account;
  useEffect(() => {
    if (!pkFirst) return;
    preparePasskey();
    // fetched again only once the last ones are old (they last 4 minutes)
    const id = window.setInterval(preparePasskey, 60_000);
    return () => window.clearInterval(id);
  }, [pkFirst, preparePasskey]);
  const pkFailed = step.status === "error" && step.at === "passkey" ? step.passkey : undefined;
  const emailField = useRef<HTMLInputElement>(null);
  const toEmail = () => emailField.current?.focus();
  // the way most apps lay it out: the one-tap ways first, each with its own mark, then "or" and the email
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
      <div className="grid gap-2">
        <h2 tabIndex={-1}>{title}</h2>
        <p>
          {practice
            ? "Practice sign-in for now: no email is sent, and any 6 digits work as the code. Nothing to install: we set up your account and pay the network fees."
            : "Nothing to install: we set up your account and pay the network fees."}
        </p>
      </div>
      {(google || passkeys) && (
        <>
          <div className="grid gap-[10px]">
            {google && (
              <button className="ag-btn ag-btn--ghost ag-btn--lg ag-provider" type="button" disabled={sending || !account.configured} onClick={() => account.startGoogle()}>
                <GoogleG />
                Continue with Google
              </button>
            )}
            {pkFirst ? (
              <button className="ag-btn ag-btn--ghost ag-btn--lg ag-provider" type="button" disabled={sending || !account.configured} onClick={() => account.continuePasskey()}>
                <PasskeyMark />
                Continue with a passkey
              </button>
            ) : (
              passkeys && (
                <button className="ag-btn ag-btn--ghost ag-btn--lg ag-provider" type="button" disabled={sending || !account.configured} onClick={() => account.startPasskey()}>
                  <PasskeyMark />
                  Sign in with a passkey
                </button>
              )
            )}
            {viaProvider &&
              (pkFailed ? (
                <PasskeyNext failure={pkFailed} message={step.message} onEmail={toEmail} />
              ) : (
                <p className="ag-err" role="alert">
                  {step.message}
                </p>
              ))}
            {/* a new browser with a passkey synced from another device: the button would make a new account here */}
            {pkFirst && !pkFailed && account.passkeyHint !== true && (
              <button type="button" className="ag-textbtn" style={{ justifySelf: "center" }} disabled={sending} onClick={() => account.continuePasskey("signin")}>
                I already have a passkey
              </button>
            )}
            {/* a passkey account whose passkey is gone: one of its backup codes makes a new one */}
            {pkFirst && account.backupCodesOn && (
              <button type="button" className="ag-textbtn" style={{ justifySelf: "center" }} disabled={sending} onClick={onBackup}>
                Lost your passkey? Use a backup code
              </button>
            )}
          </div>
          <div className="ag-or" role="separator" aria-label="or">
            <span>or</span>
          </div>
        </>
      )}
      <div className="grid gap-2">
        <label className="ag-label" htmlFor="email">
          Email
        </label>
        <input
          ref={emailField}
          id="email"
          className="ag-input"
          type="email"
          placeholder="you@example.com"
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
          "Email me a code"
        )}
      </button>
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
  // a passkey account's first backup codes: "I saved them" is the way on, unless no codes could be made
  const [codesFailed, setCodesFailed] = useState(false);

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
        {account.passkeyAccount ? (
          account.backupCodesOn ? (
            <>
              <PasskeyOnly codes />
              <BackupCodes primary onDone={onFinished} onFailedChange={setCodesFailed} />
            </>
          ) : (
            <PasskeyOnly />
          )
        ) : (
          <PasskeyOffer />
        )}
        {(!account.passkeyAccount || !account.backupCodesOn || codesFailed) && (
          <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={onFinished}>
            {from === "trade" ? "Review trade" : from === "connect" || from === "approve" ? "Continue" : "Start trading"}
          </button>
        )}
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
          { key: "in", label: email ? `Signed in as ${email}` : account.passkeyAccount ? "Signed in with your passkey" : "Signed in", mark: "done" },
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

/** At "You're set", once per new person: make a passkey the way back in. A passkey can't create an account (Dynamic
 *  links one only to a person already signed in), so this is the first moment one can exist; from then on "Sign in
 *  with a passkey" is all it takes. Hidden where the browser has no passkeys or the account already has one. */
function PasskeyOffer() {
  const account = useAccount();
  const supported = usePasskeySupport();
  const adder = usePasskeyAdd();
  // latched: shown once the account is known to have none, and kept through adding one (the count then turns to 1)
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (account.passkeys === 0) setShown(true);
  }, [account.passkeys]);
  // an account made with a passkey has its way in already (and Dynamic's own passkeys are not for it)
  if (!supported || !shown || account.passkeyAccount) return null;
  if (adder.phase === "code" || adder.phase === "checking") return <PasskeyCodeForm adder={adder} />;
  const done = !!adder.note?.ok;
  return (
    <div className="ag-offer">
      <PasskeyMark />
      <div className="grid gap-1">
        <b>{done ? "Passkey added" : "Sign in with a passkey next time"}</b>
        <p className={adder.note && !adder.note.ok ? "ag-err" : undefined} role={adder.note ? "status" : undefined}>
          {adder.note ? adder.note.text.replace(/^Passkey added\. /, "") : "Your fingerprint, face or device PIN instead of a code. It stays on this device."}
        </p>
      </div>
      {!done && (
        <button className="ag-btn ag-btn--ghost" type="button" disabled={adder.busy} onClick={() => void adder.add()}>
          {adder.busy ? (
            <>
              <span className="ag-spinner" aria-hidden="true" />
              Adding
            </>
          ) : (
            "Add a passkey"
          )}
        </button>
      )}
    </div>
  );
}

/** "You're set" for an account made with a passkey: said plainly, since there is no email to fall back on. codes: its
 *  backup codes follow, the one way back in without it. */
function PasskeyOnly({ codes = false }: { codes?: boolean }) {
  return (
    <div className="ag-offer">
      <PasskeyMark />
      <div className="grid gap-1">
        <b>Your passkey is your way in</b>
        {codes ? (
          <p>A passkey saved to iCloud Keychain or Google Password Manager comes with you to your other devices. Save these backup codes as well: if you lose your passkey, one of them makes you a new one. Each code works once.</p>
        ) : (
          <p>It's the only way into this account, so keep it. A passkey saved to iCloud Keychain or Google Password Manager comes with you to your other devices. If you lose it, this account and its test dollars are gone.</p>
        )}
      </div>
    </div>
  );
}

/** "Use a backup code": one of the codes saved at sign-up. The browser then saves a new passkey for that account and
 *  signs in with it; the code is used up. Its failures stay here, under the field. */
function BackupCodeStep({ step, code, setCode, onBack, onPasskey }: { step: SignInStep; code: string; setCode: (c: string) => void; onBack: () => void; onPasskey: () => void }) {
  const account = useAccount();
  const [bad, setBad] = useState(false);
  const failed = step.status === "error" && step.at === "passkey" && step.passkey?.mode === "recover" ? step.passkey : null;
  const failure = step.status === "error" && failed ? step.message : null;
  // the code worked and the new passkey is saved, only the sign-in didn't finish; or this device holds the account's
  // passkey already: a passkey is the way in now
  const savedPasskey = failed?.code === "dynamic" || failed?.code === "exists";
  return (
    <form
      className="grid gap-[18px]"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!isBackupCode(code)) return setBad(true);
        setBad(false);
        account.recoverWithCode(code);
      }}
    >
      <div className="grid gap-2">
        <h2 tabIndex={-1}>Use a backup code</h2>
        <p>Type one of the backup codes you saved when you made your account. Your browser then saves a new passkey for it, and that code stops working.</p>
      </div>
      <div className="grid gap-2">
        <label className="ag-label" htmlFor="backup-code">
          Backup code
        </label>
        <input
          id="backup-code"
          className={`ag-input ${bc.input}`}
          type="text"
          placeholder="K7QD-9XMP"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-invalid={bad || !!failure || undefined}
          aria-describedby="backup-code-msg"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setBad(false);
          }}
        />
        <p id="backup-code-msg" className="ag-err" aria-live="polite">
          {bad ? "That isn't a backup code. They look like K7QD-9XMP: 8 letters and numbers." : failure}
        </p>
      </div>
      {savedPasskey ? (
        <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={onPasskey}>
          Sign in with your passkey
        </button>
      ) : (
        <button className="ag-btn ag-btn--primary ag-btn--lg" type="submit" disabled={!account.configured}>
          Continue
        </button>
      )}
      <button className="ag-btn ag-btn--quiet" type="button" onClick={onBack}>
        Back
      </button>
    </form>
  );
}

/** What can follow a passkey attempt that did not finish. A cancelled sign-in never makes an account by itself: the
 *  browser can't tell a closed dialog from "no passkey here", so the person chooses. */
function PasskeyNext({ failure, message, onEmail }: { failure: PasskeyFailure; message: string; onEmail: () => void }) {
  const account = useAccount();
  // (a backup code's failures stay on its own step, and leaving it clears them: here a passkey attempt is only ever
  // signin or create)
  const again = (mode: PasskeyFailure["mode"]) => () => account.continuePasskey(mode === "recover" ? "signin" : mode);
  const email = (
    <button type="button" className="ag-textbtn" onClick={onEmail}>
      Use your email instead
    </button>
  );
  let main: { label: string; run: () => void } | null = null;
  let more: React.ReactNode = null;
  switch (failure.code) {
    case "cancelled":
      if (failure.mode === "signin") {
        main = { label: "Try again or use my phone", run: again("signin") };
        more = (
          <>
            <button type="button" className="ag-textbtn" onClick={again("create")}>
              Make a new passkey
            </button>
            {email}
          </>
        );
      } else {
        main = { label: "Try again", run: again("create") };
        more = (
          <>
            <button type="button" className="ag-textbtn" onClick={again("signin")}>
              I already have a passkey
            </button>
            {email}
          </>
        );
      }
      break;
    case "exists":
      main = { label: "Sign in with it", run: again("signin") };
      break;
    case "unknown_passkey":
      // a passkey added to an email or Google account before: the older sign-in takes it, on a fresh tap
      main = { label: "Continue", run: () => account.startPasskey() };
      more = email;
      break;
    case "signups_paused":
    case "unsupported":
      more = email;
      break;
    case "rate_limited":
      // no new accounts from this network for an hour: the server refused after the device saved the new passkey, so
      // signing in with it would go nowhere; the email still works
      if (!failure.hourly) main = { label: "Try again", run: again(failure.mode) };
      more = email;
      break;
    default:
      // a passkey that worked before Dynamic finished made the account: the next tap signs in
      main = { label: "Try again", run: again(failure.code === "dynamic" ? "signin" : failure.mode) };
      more = email;
  }
  return (
    <div className="grid gap-[10px]">
      <p className="ag-err" role="alert">
        {message}
      </p>
      {main && (
        <button className="ag-btn ag-btn--ghost" type="button" onClick={main.run}>
          {main.label}
        </button>
      )}
      {more && <div className="ag-textrow">{more}</div>}
    </div>
  );
}
