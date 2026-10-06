// The clock's two steps (BOTS-SPEC 5.6), kept apart from the block handler so tests drive them directly.
import { FACTORIES } from "./deployments.ts";
import { refreshForward } from "./market.ts";
import type { Ctx } from "./store.ts";

export const CLOCK_EVERY = 200;

/** The PENDING days that are final at t. */
export function dueFinal<F extends { state: string; finalAt: bigint | undefined }>(fixes: readonly F[], t: bigint): F[] {
  return fixes.filter((f) => f.state === "PENDING" && f.finalAt !== undefined && f.finalAt <= t);
}

/** One clock step at chain time t: PENDING days past finalAt become FINAL; every forward curve moves to its month. */
export async function clockStep(context: Ctx, t: bigint): Promise<void> {
  for (const f of dueFinal(await context.DailyFix.getWhere({ state: { _eq: "PENDING" } }), t)) {
    context.DailyFix.set({ ...f, state: "FINAL", updatedAt: t });
  }
  for (const factory of Object.keys(FACTORIES)) {
    for (const f of await context.MarketForward.getWhere({ factory_id: { _eq: factory } })) {
      await refreshForward(context, f.id, t);
    }
  }
}
