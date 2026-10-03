// AgateToken (dynamic, registered by SeriesListed): balances and supply from Transfer; a transfer from 0 is a mint,
// to 0 a burn (BOTS-SPEC 5.5).
import { indexer } from "envio";
import { isZero, low, pairId } from "../lib/ids.ts";
import { account, seen } from "../lib/store.ts";

indexer.onEvent({ contract: "AgateToken", event: "Transfer" }, async ({ event, context }) => {
  seen(event, context);
  const token = await context.Token.get(low(event.srcAddress));
  if (!token) return;
  const t = BigInt(event.block.timestamp);
  const { from, to, value } = event.params;
  for (const [who, sign] of [[from, -1n], [to, 1n]] as const) {
    const a = await account(context, who, t);
    if (a === undefined) continue;
    const id = pairId(token.id, a);
    const b = await context.TokenBalance.get(id);
    context.TokenBalance.set({ id, token_id: token.id, series_id: token.series_id, account_id: a, balance: (b?.balance ?? 0n) + sign * value });
  }
  const dSupply = (isZero(from) ? value : 0n) - (isZero(to) ? value : 0n);
  if (dSupply !== 0n) {
    context.Token.set({ ...token, supply: token.supply + dSupply });
    const s = await context.Series.get(token.series_id);
    if (s) context.Series.set({ ...s, tokenSupply: s.tokenSupply + dSupply });
  }
});
