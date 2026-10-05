// ZeroDev pays the network fee of every agate smart-account operation on Monad testnet, under the project's chain
// policy (set Oct 5 2026: at most 2 MON a user operation, 1,000 user operations a day). When the paymaster refuses,
// the bundler's error is RPC text no person should read; these words go on screen instead. Nothing has moved when it
// refuses: the operation was never sent.

/** The paymaster refused to pay this operation (a sponsorship policy or its limits), as opposed to the trade failing.
 *  Reads only what the server said (viem's `details`, or a plain error's message), never viem's full message: that
 *  one carries the request body, whose paymaster fields would match any failed user operation. A timeout or a broken
 *  connection is never a refusal: the operation may have reached the bundler. */
export function isSponsorRefusal(e: unknown): boolean {
  let x = e as { name?: string; message?: string; shortMessage?: string; details?: string; cause?: unknown } | undefined;
  for (let i = 0; x && i < 8; i++, x = x.cause as typeof x) {
    if (x.name === "TimeoutError" || x.name === "HttpRequestError" || x.name === "WebSocketRequestError") return false;
    const said = x.shortMessage !== undefined ? (x.details ?? "") : (x.message ?? "");
    // paymaster words only: an RPC's own "rate limited" is not a fee refusal
    if (/paymaster|sponsor|gas polic(?:y|ies)/i.test(said)) return true;
  }
  return false;
}

/** The sentence the app shows when isSponsorRefusal: what happened, that nothing moved, what to do. */
export const SPONSOR_REFUSAL_TEXT =
  "agate could not cover the network fee for this right now (a daily safety limit on free fees). Nothing was sent and your money has not moved. Try again later.";
