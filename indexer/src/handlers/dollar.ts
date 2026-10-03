// AgateDollar (static: the deployments file's top-level dollar, never the pilot's): balances and the faucet
// (BOTS-SPEC 5.5).
import { indexer } from "envio";
import { eventId, low, pairId } from "../lib/ids.ts";
import { account, seen } from "../lib/store.ts";

indexer.onEvent({ contract: "AgateDollar", event: "Transfer" }, async ({ event, context }) => {
  seen(event, context);
  const t = BigInt(event.block.timestamp);
  const dollar = low(event.srcAddress);
  const { from, to, value } = event.params;
  for (const [who, sign] of [[from, -1n], [to, 1n]] as const) {
    const a = await account(context, who, t);
    if (a === undefined) continue;
    const id = pairId(dollar, a);
    const b = await context.DollarBalance.get(id);
    context.DollarBalance.set({ id, dollar, account_id: a, balance: (b?.balance ?? 0n) + sign * value });
  }
});

indexer.onEvent({ contract: "AgateDollar", event: "Dripped" }, async ({ event, context }) => {
  seen(event, context);
  const t = BigInt(event.block.timestamp);
  const a = (await account(context, event.params.to, t))!;
  context.Drip.set({ id: eventId(event.block.number, event.logIndex), account_id: a, amount: event.params.amount, nextAt: event.params.nextAt, timestamp: t });
  const acc = await context.Account.get(a);
  if (acc) context.Account.set({ ...acc, nextDripAt: event.params.nextAt });
});
