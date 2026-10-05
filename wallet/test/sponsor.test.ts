import { describe, expect, test } from "bun:test";
import { RpcRequestError, TimeoutError } from "viem";
import { isSponsorRefusal } from "../src/sponsor.ts";

const body = { method: "eth_sendUserOperation", params: [{ sender: "0x01", paymaster: "0x777777777777AeC03fd955926DbF81597e66834C" }] };
const rpcError = (message: string) => new RpcRequestError({ body, error: { code: -32500, message }, url: "http://bundler" });

describe("isSponsorRefusal", () => {
  test("the paymaster's own refusals are fee refusals", () => {
    expect(isSponsorRefusal(rpcError("gas policy rejected: request limit exceeded"))).toBe(true);
    expect(isSponsorRefusal(rpcError("AA31 paymaster deposit too low"))).toBe(true);
    expect(isSponsorRefusal(new Error("pm_sponsorUserOperation failed: sponsorship policy rejected"))).toBe(true);
  });
  test("a failed user operation whose request carries paymaster fields is not; nor a timeout, an RPC rate limit, a revert", () => {
    expect(isSponsorRefusal(rpcError("AA25 invalid account nonce"))).toBe(false);
    expect(isSponsorRefusal(new TimeoutError({ body, url: "http://bundler" }))).toBe(false);
    expect(isSponsorRefusal(new Error("429: rate limited by the RPC"))).toBe(false);
    expect(isSponsorRefusal(rpcError("UserOperation reverted during simulation with reason: PriceMoved"))).toBe(false);
  });
});
