// The clock (BOTS-SPEC 5.6): no event fires when a record becomes final or a month turns, so every 200 blocks
// (about a minute at 0.3 s blocks) PENDING days whose finalAt has passed become FINAL and every forward curve moves to
// its factory's current month. Envio's block handlers carry no timestamp: t is the newest event time at or before the
// block (lib/store.ts), so nothing is marked early; between events the clock waits. finalAt gives the exact second.
import { indexer } from "envio";
import { CLOCK_EVERY, clockStep } from "../lib/clock.ts";
import { CHAIN_ID } from "../lib/deployments.ts";
import { timeAt } from "../lib/store.ts";

indexer.onBlock(
  { name: "clock", where: ({ chain }) => (chain.id === CHAIN_ID ? { block: { number: { _every: CLOCK_EVERY } } } : false) },
  async ({ block, context }) => {
    const t = timeAt(block.number);
    if (t !== null) await clockStep(context, t);
  },
);
