"use client";
// One limit batch from a button (Pro, the real account): place a resting order, cancel one, or move what a filled
// order left at Kuru back to the account. Planned, then sent as one operation (machine.ts limitReducer), with the
// steps for the button; the caller shows the outcome's line. Like useDrip: refusals in plain words. One run at a time
// across the whole account: two batches planned against the same Kuru balance would trip over each other.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useReducer } from "react";
import { useAccount, type LimitDone, type LimitOrder } from "@/lib/account";
import { COPY, limitRefusal, limitSendRefusal } from "@/lib/account/errors";
import { LIMIT_IDLE, limitBusy, limitReducer, limitStepText } from "@/lib/account/machine";

/** How a run ended: what the batch did, or the line that says why it did not. */
export type LimitOutcome = { ok: true; result: LimitDone } | { ok: false; message: string | null };

// the one account's run on its way, shared by every button that starts one
let running = false;

export function useLimitRun() {
  const account = useAccount();
  const qc = useQueryClient();
  const [state, dispatch] = useReducer(limitReducer, LIMIT_IDLE);
  const run = useCallback(
    async (order: LimitOrder): Promise<LimitOutcome> => {
      const { planLimit, sendLimit } = account;
      if (!planLimit || !sendLimit) return { ok: false, message: null };
      if (running) return { ok: false, message: COPY.limitBusy };
      running = true;
      dispatch({ type: "start", order });
      try {
        let plan;
        try {
          plan = await planLimit(order);
        } catch (e) {
          const r = limitRefusal(e, order);
          // the order filled or went, or Kuru holds nothing: what the screen shows is behind, so read it again
          if (r.refresh) void qc.invalidateQueries({ queryKey: ["live"] });
          dispatch({ type: "refused", message: r.message });
          return { ok: false, message: r.message };
        }
        dispatch({ type: "planned", plan });
        try {
          const result = await sendLimit(plan, (step, userOpHash) => dispatch({ type: "step", step, userOpHash }));
          dispatch({ type: "landed", result });
          return { ok: true, result };
        } catch (e) {
          const r = limitSendRefusal(e, order);
          dispatch({ type: "sendFailed", message: r.message, nothingSent: r.nothingSent });
          return { ok: false, message: r.message };
        }
      } finally {
        running = false;
      }
    },
    [account, qc],
  );
  return { run, busy: limitBusy(state), stepText: limitStepText(state) };
}
