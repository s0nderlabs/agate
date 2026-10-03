// AgateSeries (dynamic, registered by SeriesListed). Series.ledger follows every dollar move of MS 4.4, so it equals
// the series' state().ledger after every event (BOTS-SPEC 5.5).
import { indexer } from "envio";
import { eventId, low, pairId, positionKey, seriesDayId } from "../lib/ids.ts";
import { CLOSE_STATUS, FIX_STATUS, SIDE, enumOf, splitFlags } from "../lib/labels.ts";
import { account, seen, type Ctx } from "../lib/store.ts";

async function seriesOf(context: Ctx, src: string) {
  const s = await context.Series.get(low(src));
  if (!s) context.log.warn("event from a series that was never listed", { series: src });
  return s;
}

indexer.onEvent({ contract: "AgateSeries", event: "Minted" }, async ({ event, context }) => {
  seen(event, context);
  const s = await seriesOf(context, event.srcAddress);
  if (!s) return;
  const t = BigInt(event.block.timestamp);
  const p = event.params;
  const payer = (await account(context, p.payer, t))!;
  await account(context, p.to, t);
  context.Mint.set({
    id: eventId(event.block.number, event.logIndex),
    series_id: s.id,
    payer_id: payer,
    to: low(p.to),
    q: p.q,
    cost: p.cost,
    timestamp: t,
    txHash: event.transaction.hash,
  });
  context.Series.set({ ...s, ledger: s.ledger + p.cost });
});

indexer.onEvent({ contract: "AgateSeries", event: "Redeemed" }, async ({ event, context }) => {
  seen(event, context);
  const s = await seriesOf(context, event.srcAddress);
  if (!s) return;
  const t = BigInt(event.block.timestamp);
  const p = event.params;
  const holder = (await account(context, p.holder, t))!;
  await account(context, p.to, t);
  context.Redeem.set({
    id: eventId(event.block.number, event.logIndex),
    series_id: s.id,
    holder_id: holder,
    to: low(p.to),
    q: p.q,
    paid: p.paid,
    timestamp: t,
    txHash: event.transaction.hash,
  });
  context.Series.set({ ...s, ledger: s.ledger - p.paid });
});

// Shorts never move between accounts (MS 8.2, I29): each event carries the account's new balance.
async function shortMoved(context: Ctx, ev: { srcAddress: string; block: { timestamp: number } }, account_: string, q: bigint, balance: bigint, sign: 1n | -1n) {
  const s = await seriesOf(context, ev.srcAddress);
  if (!s) return;
  const t = BigInt(ev.block.timestamp);
  const a = (await account(context, account_, t))!;
  context.ShortBalance.set({ id: pairId(s.id, a), series_id: s.id, account_id: a, balance });
  context.Series.set({ ...s, shortSupply: s.shortSupply + sign * q });
}

indexer.onEvent({ contract: "AgateSeries", event: "ShortCredited" }, async ({ event, context }) => {
  seen(event, context);
  await shortMoved(context, event, event.params.account, event.params.q, event.params.balance, 1n);
});

indexer.onEvent({ contract: "AgateSeries", event: "ShortDebited" }, async ({ event, context }) => {
  seen(event, context);
  await shortMoved(context, event, event.params.account, event.params.q, event.params.balance, -1n);
});

indexer.onEvent({ contract: "AgateSeries", event: "PositionOpened" }, async ({ event, context }) => {
  seen(event, context);
  const s = await seriesOf(context, event.srcAddress);
  if (!s) return;
  const t = BigInt(event.block.timestamp);
  const p = event.params;
  const side = enumOf(SIDE, p.side, "side");
  const owner = (await account(context, p.owner, t))!;
  const payee = (await account(context, p.payee, t))!;
  const operator = await account(context, p.operator, t);
  await account(context, p.to, t);
  context.Position.set({
    id: positionKey(s.id, p.id),
    series_id: s.id,
    positionId: p.id,
    owner_id: owner,
    payee_id: payee,
    operator_id: operator,
    side,
    q: p.q,
    paid: p.paidNow,
    daily: p.daily,
    openedK: Number(p.k),
    openedAt: t,
    openTo: low(p.to),
    status: "OPEN",
    lastClaimAt: undefined,
    closedAmount: undefined,
    closedTo: undefined,
    closedBy: undefined,
    closedAt: undefined,
  });
  context.Series.set({
    ...s,
    ledger: s.ledger - p.paidNow,
    openPositions: s.openPositions + 1,
    qInPositionsLong: s.qInPositionsLong + (side === "LONG" ? p.q : 0n),
    qInPositionsShort: s.qInPositionsShort + (side === "SHORT" ? p.q : 0n),
  });
});

indexer.onEvent({ contract: "AgateSeries", event: "Claimed" }, async ({ event, context }) => {
  seen(event, context);
  const s = await seriesOf(context, event.srcAddress);
  if (!s) return;
  const t = BigInt(event.block.timestamp);
  const p = event.params;
  const key = positionKey(s.id, p.id);
  const payee = (await account(context, p.payee, t))!;
  context.Claim.set({
    id: eventId(event.block.number, event.logIndex),
    position_id: key,
    series_id: s.id,
    payee_id: payee,
    amount: p.amount,
    paidTotal: p.paidTotal,
    k: Number(p.k),
    by: event.transaction.from === undefined ? undefined : low(event.transaction.from),
    timestamp: t,
    block: BigInt(event.block.number),
    txHash: event.transaction.hash,
  });
  const pos = await context.Position.get(key);
  if (pos) context.Position.set({ ...pos, paid: p.paidTotal, lastClaimAt: t });
  context.Series.set({ ...s, ledger: s.ledger - p.amount });
});

indexer.onEvent({ contract: "AgateSeries", event: "PositionClosed" }, async ({ event, context }) => {
  seen(event, context);
  const s = await seriesOf(context, event.srcAddress);
  if (!s) return;
  const t = BigInt(event.block.timestamp);
  const p = event.params;
  const status = enumOf(CLOSE_STATUS, p.kind, "close kind");
  await account(context, p.to, t);
  await account(context, p.by, t);
  const key = positionKey(s.id, p.id);
  const pos = await context.Position.get(key);
  let { openPositions, qInPositionsLong, qInPositionsShort } = s;
  if (pos && pos.status === "OPEN") {
    context.Position.set({ ...pos, status, closedAmount: p.amount, closedTo: low(p.to), closedBy: low(p.by), closedAt: t });
    openPositions -= 1;
    if (pos.side === "LONG") qInPositionsLong -= pos.q;
    else qInPositionsShort -= pos.q;
  }
  // WITH_TOKEN pays out, UNSTREAMED takes the paid amount back in; FINAL's money is the Claimed just before it (MS 4.5)
  const ledger = status === "CLOSED_WITH_TOKEN" ? s.ledger - p.amount : status === "UNSTREAMED" ? s.ledger + p.amount : s.ledger;
  context.Series.set({ ...s, ledger, openPositions, qInPositionsLong, qInPositionsShort });
});

indexer.onEvent({ contract: "AgateSeries", event: "PayoutChanged" }, async ({ event, context }) => {
  seen(event, context);
  const s = await seriesOf(context, event.srcAddress);
  if (!s) return;
  const t = BigInt(event.block.timestamp);
  const payee = (await account(context, event.params.payee, t))!;
  const pos = await context.Position.get(positionKey(s.id, event.params.id));
  if (pos) context.Position.set({ ...pos, payee_id: payee, daily: event.params.daily });
});

indexer.onEvent({ contract: "AgateSeries", event: "OperatorSet" }, async ({ event, context }) => {
  seen(event, context);
  const s = await seriesOf(context, event.srcAddress);
  if (!s) return;
  const t = BigInt(event.block.timestamp);
  const operator = await account(context, event.params.operator, t);
  const pos = await context.Position.get(positionKey(s.id, event.params.id));
  if (pos) context.Position.set({ ...pos, operator_id: operator });
});

indexer.onEvent({ contract: "AgateSeries", event: "Settled" }, async ({ event, context }) => {
  seen(event, context);
  const s = await seriesOf(context, event.srcAddress);
  if (!s) return;
  const t = BigInt(event.block.timestamp);
  const p = event.params;
  const holder = (await account(context, p.holder, t))!;
  await account(context, p.to, t);
  context.Settle.set({
    id: eventId(event.block.number, event.logIndex),
    series_id: s.id,
    holder_id: holder,
    side: enumOf(SIDE, p.side, "side"),
    q: p.q,
    paid: p.paid,
    to: low(p.to),
    timestamp: t,
    txHash: event.transaction.hash,
  });
  context.Series.set({ ...s, ledger: s.ledger - p.paid });
});

indexer.onEvent({ contract: "AgateSeries", event: "FixApplied" }, async ({ event, context }) => {
  seen(event, context);
  const s = await seriesOf(context, event.srcAddress);
  if (!s) return;
  const t = BigInt(event.block.timestamp);
  const p = event.params;
  const k = Number(p.k);
  const day = Number(p.day);
  const flags = Number(p.flags);
  context.SeriesDay.set({
    id: seriesDayId(s.id, k),
    series_id: s.id,
    k,
    day,
    x: p.x,
    c: p.c,
    status: enumOf(FIX_STATUS, p.status, "fix status"),
    flags,
    ...splitFlags(flags),
    sumAfter: p.sumAfter,
    appliedAt: t,
  });
  context.Series.set({ ...s, k, sum: p.sumAfter, lastFixDay: day, state: k === s.n ? "FINAL" : "ACCRUING" });
});
