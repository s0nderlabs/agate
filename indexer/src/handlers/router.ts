// AgateRouter (static, one per factory): one RouterFlow row per click; net = dollarsOut - dollarsIn (MS 8.4).
import { indexer } from "envio";
import { eventId, low } from "../lib/ids.ts";
import { FLOW, enumOf } from "../lib/labels.ts";
import { account, seen } from "../lib/store.ts";

indexer.onEvent({ contract: "AgateRouter", event: "Routed" }, async ({ event, context }) => {
  seen(event, context);
  const t = BigInt(event.block.timestamp);
  const p = event.params;
  const user = (await account(context, p.user, t))!;
  context.RouterFlow.set({
    id: eventId(event.block.number, event.logIndex),
    router: low(event.srcAddress),
    user_id: user,
    series_id: low(p.series),
    flow: enumOf(FLOW, p.flow, "flow"),
    tokens: p.tokens,
    dollarsIn: p.dollarsIn,
    dollarsOut: p.dollarsOut,
    refund: p.refund,
    tokensIn: p.tokensIn,
    tokensOut: p.tokensOut,
    net: p.dollarsOut - p.dollarsIn,
    positionIds: [...p.positionIds],
    timestamp: t,
    block: BigInt(event.block.number),
    txHash: event.transaction.hash,
  });
});
