// The ONE list of what an AI pocket may call (plan.md section 9). The same list:
//  1. compiles to the pocket's onchain session key (ZeroDev CallPolicy v0.0.4, checked by the Kernel account itself),
//  2. checks every operation the server builds before it is signed (MCP tools, auto-roll),
//  3. checks every delegated signature again in Transaction Review (decoded from the user operation's callData),
//  4. can compile to Dynamic environment rules the day Dynamic's policy engine supports Monad (it does not yet:
//     neither 143 nor 10143, verified Oct 4 2026), as a third layer. Never remove the onchain one.
//
// What a pocket may do: approve the router (any agate token or the test dollar), open a long, a daily long or a short
// up to the per-trade cap with the payee pinned to the user's main account, close its own positions, take test
// dollars from the faucet. Never: transfer, approve anyone else, setPayout, setOperator, mint pairs, redeem, settle,
// or call any other contract.
import { type Address, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, type Hex, zeroAddress } from "viem";
import { abi } from "@agate/client";

const { agateRouterAbi, agateDollarAbi, agateTokenAbi } = abi;

export type PocketLimits = {
  /** the agate routers the pocket may use: the real factory's, plus a demo session's while one runs (each demo
   *  session deploys a fresh factory and router) */
  routers: readonly Address[];
  dollar: Address;
  /** the only payee a pocket may name: the user's main smart account */
  mainAccount: Address;
  /** u: the most dollars one open (or one buy-back) may spend */
  perTradeCap: bigint;
  /** base units: the most tokens one short may open (perTradeCap over the dearest pair cost at grant time) */
  shortTokensCap: bigint;
};

/** The pair cost one short token is sized against (u per token, i.e. dollars per GPU-hour x 1e6): above every
 *  listed GPU's band top, so a short of shortTokensCapFor(cap) tokens never needs more than `cap` dollars of
 *  collateral. The app and the server both derive the onchain short cap from it, so they always agree. */
/** 6-decimal base units in plain numbers (dollars or GPU-hours) for refusal texts. */
const six = (v: bigint): string => (Number(v) / 1e6).toString();

export const SHORT_SIZING_PRICE = 20_000_000n;
export function shortTokensCapFor(perTradeCap: bigint): bigint {
  return (perTradeCap * 1_000_000n) / SHORT_SIZING_PRICE;
}

export type { Call } from "./kernel.ts";
import type { Call } from "./kernel.ts";

/** Why a call was refused, in the words the MCP tools and the activity feed use. */
export type Refusal =
  | "not_allowed_contract"
  | "not_allowed_function"
  | "over_per_trade_cap"
  | "payee_must_be_you"
  | "approve_router_only"
  | "no_native_value";

export type Check = { ok: true } | { ok: false; rule: Refusal; detail: string; index: number };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Decoded = { functionName: string; args: readonly unknown[] };

function decodeWith(abi_: readonly unknown[], data: Hex): Decoded | null {
  try {
    return decodeFunctionData({ abi: abi_ as never, data }) as unknown as Decoded;
  } catch {
    return null;
  }
}

/** Checks a batch call by call, exactly as the onchain CallPolicy would, plus nothing more. */
export function checkPocketCalls(calls: readonly Call[], l: PocketLimits): Check {
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    const no = (rule: Refusal, detail: string): Check => ({ ok: false, rule, detail, index: i });
    if (c.value !== 0n) return no("no_native_value", "a pocket call never sends MON");
    if (l.routers.some((r) => same(c.to, r))) {
      const d = decodeWith(agateRouterAbi, c.data);
      if (!d) return no("not_allowed_function", "not a router function");
      const a = d.args;
      switch (d.functionName) {
        case "openLong":
          if ((a[1] as bigint) > l.perTradeCap) return no("over_per_trade_cap", `openLong spends $${six(a[1] as bigint)}, the cap is $${six(l.perTradeCap)} a trade`);
          continue;
        case "openLongDaily":
          if ((a[1] as bigint) > l.perTradeCap) return no("over_per_trade_cap", `openLongDaily spends $${six(a[1] as bigint)}, the cap is $${six(l.perTradeCap)} a trade`);
          if (!same(a[4] as string, l.mainAccount)) return no("payee_must_be_you", "the daily payee must be the user's main account");
          continue;
        case "openShort":
          if ((a[1] as bigint) > l.shortTokensCap) return no("over_per_trade_cap", `openShort opens ${six(a[1] as bigint)} GPU-hours, the limit is ${six(l.shortTokensCap)} GPU-hours a short`);
          if (!same(a[4] as string, l.mainAccount)) return no("payee_must_be_you", "the short's payee must be the user's main account");
          continue;
        case "closeShort":
          if ((a[2] as bigint) > l.perTradeCap) return no("over_per_trade_cap", `closeShort spends up to $${six(a[2] as bigint)}, the cap is $${six(l.perTradeCap)} a trade`);
          continue;
        case "closeLong":
        case "closeLongDaily":
          continue;
        default:
          return no("not_allowed_function", `router.${d.functionName} is not allowed`);
      }
    }
    const fn = decodeWith(agateTokenAbi, c.data) ?? decodeWith(agateDollarAbi, c.data);
    if (fn?.functionName === "approve") {
      if (!l.routers.some((r) => same(fn.args[0] as string, r))) return no("approve_router_only", "a pocket approves only the agate router");
      continue;
    }
    if (fn?.functionName === "drip" && same(c.to, l.dollar)) continue;
    return no(same(c.to, l.dollar) ? "not_allowed_function" : "not_allowed_contract", `call to ${c.to} is not allowed`);
  }
  return { ok: true };
}

// ------------------------------------------------------------------ onchain: ZeroDev CallPolicy permissions

// ParamCondition values of @zerodev/permissions (kept here as numbers so this file stays importable without it).
const EQUAL = 0;
const LTE = 4;
const ONE_OF = 6;

/** The CallPolicy permissions of a pocket's session key. Args are positional; a null skips that argument. Offsets
 *  are computed by the SDK as index x 32, which is right here: every conditioned argument comes before the Permit
 *  tuple. A zeroAddress target (CallPolicy >= 0.0.2) means "this selector on any contract": used for approve, whose
 *  spender is pinned to the router. */
export function pocketPermissions(l: PocketLimits) {
  if (l.routers.length === 0) throw new Error("a pocket needs at least one router");
  const routerRules = (router: Address) => [
    { target: router, abi: agateRouterAbi, functionName: "openLong", args: [null, { condition: LTE, value: l.perTradeCap }, null, null] },
    {
      target: router,
      abi: agateRouterAbi,
      functionName: "openLongDaily",
      args: [null, { condition: LTE, value: l.perTradeCap }, null, null, { condition: EQUAL, value: l.mainAccount }, null],
    },
    {
      target: router,
      abi: agateRouterAbi,
      functionName: "openShort",
      args: [null, { condition: LTE, value: l.shortTokensCap }, null, null, { condition: EQUAL, value: l.mainAccount }, null, null],
    },
    { target: router, abi: agateRouterAbi, functionName: "closeShort", args: [null, null, { condition: LTE, value: l.perTradeCap }, null] },
    { target: router, abi: agateRouterAbi, functionName: "closeLong", args: [] },
    { target: router, abi: agateRouterAbi, functionName: "closeLongDaily", args: [] },
  ];
  return [
    { target: zeroAddress, abi: agateTokenAbi, functionName: "approve", args: [{ condition: ONE_OF, value: [...l.routers] }, null] },
    { target: l.dollar, abi: agateDollarAbi, functionName: "drip", args: [] },
    ...l.routers.flatMap(routerRules),
  ];
}

// ------------------------------------------------------------------ later: Dynamic environment rules

/** The same list as plain (contract, function, limit) rows: what the Allow page shows, and the input for Dynamic
 *  environment rules once Dynamic validates Monad. */
export function describePocket(l: PocketLimits): { contract: string; fn: string; limit: string }[] {
  const cap = `${Number(l.perTradeCap) / 1e6} dollars`;
  return [
    { contract: "any agate token or the test dollar", fn: "approve", limit: "spender = agate router" },
    { contract: "test dollar", fn: "drip", limit: "faucet only" },
    { contract: "agate router", fn: "openLong", limit: `at most ${cap}` },
    { contract: "agate router", fn: "openLongDaily", limit: `at most ${cap}, paid to your main account` },
    { contract: "agate router", fn: "openShort", limit: `at most ${cap} of collateral, paid to your main account` },
    { contract: "agate router", fn: "closeShort", limit: `at most ${cap}` },
    { contract: "agate router", fn: "closeLong / closeLongDaily", limit: "its own positions only (the router checks)" },
  ];
}

// ------------------------------------------------------------------ Kernel v3 callData

const kernelExecuteAbi = [
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "execMode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;
const executionsAbi = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "callData", type: "bytes" },
    ],
  },
] as const;

/** The calls a Kernel v3 user operation makes: execute(mode, data) with callType 0x00 (one call, packed) or 0x01
 *  (a batch). Anything else (delegatecall, other entry points) returns null: never allowed for a pocket. */
export function decodeKernelCalls(callData: Hex): Call[] | null {
  const d = decodeWith(kernelExecuteAbi, callData);
  if (!d || d.functionName !== "execute") return null;
  const mode = d.args[0] as Hex;
  const body = d.args[1] as Hex;
  const callType = mode.slice(2, 4);
  const execType = mode.slice(4, 6);
  if (execType !== "00") return null; // only "revert on failure"
  if (callType === "00") {
    const hex = body.slice(2);
    if (hex.length < 104) return null;
    return [{ to: `0x${hex.slice(0, 40)}` as Address, value: BigInt(`0x${hex.slice(40, 104)}`), data: `0x${hex.slice(104)}` as Hex }];
  }
  if (callType === "01") {
    try {
      const [execs] = decodeAbiParameters(executionsAbi, body);
      return execs.map((e) => ({ to: e.target, value: e.value, data: e.callData }));
    } catch {
      return null;
    }
  }
  return null;
}

/** Test helper and the server's own builder: the Kernel v3 callData for a batch (as ZeroDev encodes it). */
export function encodeKernelBatch(calls: readonly Call[]): Hex {
  const body = encodeAbiParameters(executionsAbi, [calls.map((c) => ({ target: c.to, value: c.value, callData: c.data }))]);
  const mode = `0x01${"00".repeat(31)}` as Hex;
  return encodeFunctionData({ abi: kernelExecuteAbi, functionName: "execute", args: [mode, body] });
}
