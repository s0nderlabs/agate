// A Mera signing session has no built-in scope or expiry (Mera docs, concepts/signing-sessions.mdx), so this
// wraps the session's viem account in a policy: it signs only the four spike calls, on Monad testnet, with
// caps, until an expiry. Anything else is refused before the session key is touched.
import { type Address, decodeFunctionData, type Hex, isAddressEqual, type LocalAccount } from "viem";
import { abis, chainId, contracts, flow } from "./chain";

export type SessionScope = {
  chainId: number;
  /** ms since epoch; after this the wrapper refuses and the caller ends the Mera session. */
  expiresAt: number;
  /** total testUSD the session may spend on buys (6 decimals). */
  buyCap: bigint;
  /** largest agent grant (and matching token allowance) the session may sign. */
  agentCapMax: bigint;
  /** longest agent grant the session may sign, in seconds. */
  agentTtlMax: number;
};

export type ScopeState = { spent: bigint; signatures: number };

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

export function defaultScope(now = Date.now(), minutes = 30): SessionScope {
  return {
    chainId,
    expiresAt: now + minutes * 60_000,
    buyCap: 1_000_000_000n, // 1,000 testUSD per session
    agentCapMax: flow.agentCap,
    agentTtlMax: flow.agentTtlSeconds,
  };
}

/** Plain-language scope for the UI. */
export function describeScope(scope: SessionScope): string[] {
  const usd = (v: bigint) => (Number(v) / 1e6).toLocaleString();
  return [
    "Only Monad testnet (chain 10143), only the agate spike contracts",
    "Claim test dollars to your own address",
    `Buy spUP up to ${usd(scope.buyCap)} testUSD in total`,
    `Approve an agent for at most ${usd(scope.agentCapMax)} testUSD and ${Math.round(scope.agentTtlMax / 3600)} h`,
    "No MON transfers, no token transfers, no message signing, no EIP-7702",
    `Ends ${new Date(scope.expiresAt).toLocaleTimeString()} or when you close the tab`,
  ];
}

const sel = (data: Hex | undefined, abi: typeof abis.testUsd) => {
  if (!data) throw new ScopeError("empty calldata is not in scope");
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    throw new ScopeError("unknown function");
  }
};

export function checkTransaction(
  tx: { to?: Address | null; data?: Hex; value?: bigint; chainId?: number; authorizationList?: unknown },
  self: Address,
  scope: SessionScope,
  state: ScopeState,
  now = Date.now(),
): { spend: bigint } {
  if (now >= scope.expiresAt) throw new ScopeError("session expired");
  if (tx.chainId !== scope.chainId) throw new ScopeError(`chain ${tx.chainId} is not in scope`);
  if (tx.value && tx.value > 0n) throw new ScopeError("sending MON is not in scope");
  if (tx.authorizationList) throw new ScopeError("EIP-7702 is not in scope");
  if (!tx.to) throw new ScopeError("contract creation is not in scope");

  if (isAddressEqual(tx.to, contracts.testUsd as Address)) {
    const { functionName, args = [] } = sel(tx.data, abis.testUsd);
    if (functionName === "faucet") {
      if (!isAddressEqual(args[0] as Address, self)) throw new ScopeError("faucet only to yourself");
      return { spend: 0n };
    }
    if (functionName === "approve") {
      if (!isAddressEqual(args[0] as Address, contracts.market as Address)) throw new ScopeError("approve only the market");
      if ((args[1] as bigint) > scope.agentCapMax) throw new ScopeError("allowance above the agent cap");
      return { spend: 0n };
    }
    throw new ScopeError(`testUSD.${functionName} is not in scope`);
  }

  if (isAddressEqual(tx.to, contracts.market as Address)) {
    const { functionName, args = [] } = sel(tx.data, abis.market);
    if (functionName === "buyUp" || functionName === "buyUpWithPermit") {
      const amount = args[0] as bigint;
      if (state.spent + amount > scope.buyCap) throw new ScopeError("buy cap for this session reached");
      return { spend: amount };
    }
    if (functionName === "approveAgent") {
      const [, cap, expiry] = args as [Address, bigint, bigint];
      if (cap > scope.agentCapMax) throw new ScopeError("agent cap above the session limit");
      if (Number(expiry) > Math.floor(now / 1000) + scope.agentTtlMax + 300) throw new ScopeError("agent grant too long");
      return { spend: 0n };
    }
    throw new ScopeError(`market.${functionName} is not in scope`);
  }
  throw new ScopeError(`contract ${tx.to} is not in scope`);
}

type TypedDataArg = Parameters<LocalAccount["signTypedData"]>[0];

export function checkPermit(td: TypedDataArg, self: Address, scope: SessionScope, state: ScopeState, now = Date.now()) {
  if (now >= scope.expiresAt) throw new ScopeError("session expired");
  if (td.primaryType !== "Permit") throw new ScopeError("only EIP-2612 permits may be signed");
  const d = td.domain ?? {};
  if (Number(d.chainId) !== scope.chainId || !d.verifyingContract || !isAddressEqual(d.verifyingContract, contracts.testUsd as Address))
    throw new ScopeError("permit only for testUSD on Monad testnet");
  const m = td.message as { owner: Address; spender: Address; value: bigint; deadline: bigint };
  if (!isAddressEqual(m.owner, self) || !isAddressEqual(m.spender, contracts.market as Address))
    throw new ScopeError("permit only from you to the market");
  if (BigInt(m.value) + state.spent > scope.buyCap) throw new ScopeError("permit above the session buy cap");
  if (Number(m.deadline) > Math.floor(now / 1000) + 3600) throw new ScopeError("permit deadline too far out");
}

/** Wraps a Mera viem account so it signs only what the scope allows. */
export function scopeAccount(
  inner: LocalAccount,
  scope: SessionScope,
  state: ScopeState = { spent: 0n, signatures: 0 },
  onSign?: (kind: "tx" | "permit") => void,
): LocalAccount {
  const refuse = async (): Promise<never> => {
    throw new ScopeError("this session signs only scoped agate calls");
  };
  return {
    ...inner,
    signMessage: refuse,
    sign: refuse,
    signAuthorization: refuse,
    async signTransaction(tx, opts) {
      const { spend } = checkTransaction(tx as Parameters<typeof checkTransaction>[0], inner.address, scope, state);
      const signed = await inner.signTransaction(tx, opts);
      state.spent += spend;
      state.signatures += 1;
      onSign?.("tx");
      return signed;
    },
    async signTypedData(td) {
      checkPermit(td as TypedDataArg, inner.address, scope, state);
      const signed = await inner.signTypedData(td);
      state.signatures += 1;
      onSign?.("permit");
      return signed;
    },
  } as LocalAccount;
}
