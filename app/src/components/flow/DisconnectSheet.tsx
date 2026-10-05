"use client";
// Disconnect an AI (wallet spec 10.5, screen 12), driven by machine.ts disconnectReducer: stop it on Agate's server,
// switch the trading key off only when no other AI is still connected (one key serves every pocket), and by default
// take the pocket's dollars home in the same go. Its positions stay in the pocket and keep paying the person.
import { useEffect, useReducer, useRef } from "react";
import { useAiBackend, useAiRefresh, useGrants, usePocket } from "@/lib/account/ai";
import { isLive } from "@/lib/account/aiView";
import { disconnectDoneText, disconnectFailure } from "@/lib/account/errors";
import { disconnectDismissable, disconnectReducer, disconnectStart, disconnectSteps, type DisconnectState } from "@/lib/account/machine";
import { usd0 } from "@/lib/format";
import { Check, Steps, type StepRow } from "./Steps";

const BEFORE: Record<string, number> = { stopping: 0, revoking: 1, takingBack: 2 };

export function DisconnectSheet({ grantId, onClose, onLock }: { grantId: string; onClose: () => void; onLock: (locked: boolean) => void }) {
  const grants = useGrants();
  const g = grants.data?.find((x) => x.id === grantId);
  const pocket = usePocket(g?.pocket);
  // a pocket read that failed has no data and is not pending either: never run on a made-up balance of 0
  if (!g || !pocket.data) {
    return (
      <>
        <h2>{g ? `Disconnect ${g.label}?` : "Disconnect"}</h2>
        {grants.isError || pocket.isError ? (
          <>
            <p className="ag-err">Can't reach Agate's server right now. Try again in a moment.</p>
            <button
              className="ag-btn ag-btn--ghost"
              type="button"
              onClick={() => {
                void grants.refetch();
                void pocket.refetch();
              }}
            >
              Try again
            </button>
          </>
        ) : (
          <span className="ag-spinner" aria-label="Loading" />
        )}
        <button className="ag-btn ag-btn--quiet" type="button" onClick={onClose}>
          Close
        </button>
      </>
    );
  }
  const others = (grants.data ?? []).filter((x) => x.id !== g.id && isLive(x)).length;
  return <Run key={g.id} ai={g.label} grantId={g.id} pocket={g.pocket} lastActive={others === 0} balance={pocket.data.balance} positions={pocket.data.positions.length} onClose={onClose} onLock={onLock} />;
}

function Run(p: { ai: string; grantId: string; pocket: string; lastActive: boolean; balance: number; positions: number; onClose: () => void; onLock: (locked: boolean) => void }) {
  const { backend } = useAiBackend();
  const refresh = useAiRefresh();
  const [s, dispatch] = useReducer(disconnectReducer, undefined, () => disconnectStart(p.lastActive, p.balance));
  const { onLock, onClose } = p;
  useEffect(() => onLock(!disconnectDismissable(s)), [s, onLock]);
  useEffect(() => {
    if (s.step === "closed") onClose();
  }, [s.step, onClose]);

  // run the step the machine is on, once per state it enters
  const ran = useRef<DisconnectState | null>(null);
  useEffect(() => {
    if (ran.current === s) return;
    ran.current = s;
    if (s.step === "stopping") {
      backend.api.disconnect(p.grantId).then(
        () => dispatch({ type: "stopped" }),
        () => dispatch({ type: "stopFailed" }),
      );
    } else if (s.step === "revoking") {
      backend.tradingKey.revoke().then(
        () => dispatch({ type: "revoked" }),
        () => dispatch({ type: "revokeFailed" }),
      );
    } else if (s.step === "takingBack") {
      backend.takeBack(p.pocket).then(
        () => dispatch({ type: "tookBack" }),
        () => dispatch({ type: "takeBackFailed" }),
      );
    } else if (s.step === "done" || s.step === "failed") refresh();
  }, [s, backend, p.grantId, p.pocket, refresh]);

  if (s.step === "closed") return null;
  if (s.step === "done") {
    return (
      <>
        <Check size={44} />
        <h2>{p.ai} is disconnected</h2>
        <p>{disconnectDoneText({ ai: p.ai, amount: s.amount, tookBack: s.tookBack, serverMissed: s.serverMissed }) || `${p.ai} can't trade any more.`}</p>
        <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={() => dispatch({ type: "close" })}>
          Done
        </button>
      </>
    );
  }

  if (s.step === "confirm") {
    return (
      <>
        <h2>Disconnect {p.ai}?</h2>
        <p>{p.positions > 0 ? `${p.ai} stops trading at once. Its ${p.positions === 1 ? "open position stays" : `${p.positions} open positions stay`} in its pocket, and their payouts still come to you.` : `${p.ai} stops trading at once.`}</p>
        {p.balance > 0 && (
          <label className="ag-toggle">
            <input type="checkbox" checked={s.takeBack} onChange={() => dispatch({ type: "toggleTakeBack" })} />
            <span className="ag-switch" aria-hidden="true" />
            <span className="grid gap-0.5">
              <span>Take back the {usd0(p.balance)} left in its pocket</span>
              <span className="ag-fine">Moves it to your account in the same step.</span>
            </span>
          </label>
        )}
        <button className="ag-btn ag-btn--danger ag-btn--lg" type="button" onClick={() => dispatch({ type: "confirm" })}>
          Disconnect {p.ai}
        </button>
        <button className="ag-btn ag-btn--ghost" type="button" onClick={() => dispatch({ type: "keep" })}>
          Keep connected
        </button>
      </>
    );
  }

  // the steps: running, or stopped at one
  const ctx = { takeBack: s.takeBack, lastActive: s.lastActive, balance: s.balance };
  const at = s.step === "failed" ? s.at : s.step;
  const labels: Record<string, string> = { stopping: `Stopping ${p.ai}`, revoking: "Switching off the trading key", takingBack: `Moving ${usd0(s.balance)} to your account` };
  // the server missed the stop: that row stays stopped, and says what stops the AI instead (the key switched off)
  const missed = "serverMissed" in s && s.serverMissed;
  const rows: StepRow[] = disconnectSteps(ctx).map((k) =>
    k === "stopping" && missed
      ? { key: k, label: labels[k], hint: "Agate's server didn't answer. Switching off the trading key stops it instead.", mark: "failed" }
      : {
          key: k,
          label: labels[k],
          mark: BEFORE[k] < BEFORE[at] ? "done" : k === at ? (s.step === "failed" ? "failed" : "current") : "waiting",
        },
  );
  const fail = s.step === "failed" ? disconnectFailure(s.at, { ai: p.ai, amount: s.balance }) : null;
  return (
    <>
      <h2>{s.step === "failed" ? `Disconnect ${p.ai}` : `Disconnecting ${p.ai}`}</h2>
      <Steps rows={rows} label="Disconnecting" />
      <div className="ag-slot">
        {fail && (
          <>
            <p className="ag-err" aria-live="polite">
              {fail.message}
            </p>
            {fail.actions.includes("retry") && (
              <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={() => dispatch({ type: "retry" })}>
                Try again
              </button>
            )}
            {fail.actions.includes("takeBack") && (
              <button className="ag-btn ag-btn--primary ag-btn--lg" type="button" onClick={() => dispatch({ type: "retry" })}>
                Take back {usd0(s.balance)}
              </button>
            )}
            <button className="ag-btn ag-btn--quiet" type="button" onClick={() => dispatch({ type: "close" })}>
              Close
            </button>
          </>
        )}
      </div>
    </>
  );
}
