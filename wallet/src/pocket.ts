// The AI pocket: a separate Kernel account (index 1, 2, ... of the user's main wallet) that holds only the budget the
// user moved into it. A ZeroDev session key on it lets the user's Assistant wallet (a second Dynamic embedded wallet,
// delegated to agate) sign trades, and nothing else:
//  - CallPolicy 0.0.4: the allowed-call list (allowed.ts): router functions only, per-trade cap, payee pinned to the
//    user's main account, approve the router only, faucet;
//  - TimestampPolicy: the end date the user picked;
//  - RateLimitPolicy (with reset): trades per day;
//  - SignatureCallerPolicy with no allowed caller: the key can never produce an ERC-1271 signature for the pocket
//    (no permit, no off-chain order), only user operations.
// The main wallet signs the permission once (Kernel "enable mode": installed by the first trade, no transaction now).
// A fully compromised agate server can therefore only trade inside the pocket, and only in these shapes.
import { deserializePermissionAccount, serializePermissionAccount, toPermissionValidator } from "@zerodev/permissions";
import { CallPolicyVersion, toCallPolicy, toRateLimitPolicy, toSignatureCallerPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { toECDSASigner, toEmptyECDSASigner } from "@zerodev/permissions/signers";
import { createKernelAccount } from "@zerodev/sdk";
import { type Address, encodeFunctionData, type LocalAccount, type PublicClient } from "viem";
import { type PocketLimits, pocketPermissions } from "./allowed.ts";
import { ENTRY_POINT, KERNEL_VERSION, POCKET_INDEX } from "./chain.ts";
import { addressOnly, type Call, kernelAddress, sudoValidator } from "./kernel.ts";

/** ZeroDev's rate limit policy that refills `count` uses every `interval` seconds (deployed on 10143). */
export const RATE_LIMIT_WITH_RESET = "0x6a06358e6b283921deceabe7e8a3741d506cca9b" as Address;
const NOT_FOR_VALIDATE_USEROP = "0x0001";
const DAY = 86_400;

export type PocketTerms = {
  /** the Assistant wallet's address: the session key's only signer */
  assistant: Address;
  limits: PocketLimits;
  /** unix seconds: the permission stops working after this */
  validUntil: number;
  tradesPerDay: number;
  /** which pocket of this main wallet (1 for the first connected AI) */
  index?: bigint;
};

export function pocketPolicies(t: PocketTerms) {
  return [
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: pocketPermissions(t.limits) as never }),
    toTimestampPolicy({ validUntil: t.validUntil }),
    toRateLimitPolicy({ policyAddress: RATE_LIMIT_WITH_RESET, interval: DAY, count: t.tradesPerDay }),
    toSignatureCallerPolicy({ policyFlag: NOT_FOR_VALIDATE_USEROP as never, allowedCallers: [] }),
  ];
}

export async function pocketAddress(pc: PublicClient, mainOwner: Address, index: bigint = POCKET_INDEX): Promise<Address> {
  return kernelAddress(pc, mainOwner, index);
}

/** In the app: the main wallet signs the pocket's session-key permission (one signature, typed data). Returns the
 *  pocket's address and the serialized approval to send to agate (it holds the enable signature, never a key). */
export async function createPocketPermission(pc: PublicClient, main: LocalAccount, t: PocketTerms): Promise<{ pocket: Address; approval: string }> {
  const sudo = await sudoValidator(pc, main);
  const regular = await toPermissionValidator(pc, {
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    signer: toEmptyECDSASigner(t.assistant),
    policies: pocketPolicies(t),
  });
  const account = await createKernelAccount(pc, {
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    index: t.index ?? POCKET_INDEX,
    plugins: { sudo, regular },
  });
  return { pocket: account.address, approval: await serializePermissionAccount(account) };
}

/** On the server: the pocket as seen by its session key, signing with the Assistant (a delegated Dynamic wallet). */
export async function pocketSessionAccount(pc: PublicClient, approval: string, assistant: LocalAccount) {
  const signer = await toECDSASigner({ signer: assistant });
  return deserializePermissionAccount(pc, ENTRY_POINT, KERNEL_VERSION, approval, signer);
}

/** The approval's contents, decoded (base64 JSON, bigints as strings). */
export function readApproval(approval: string): {
  accountAddress: Address;
  initCode: string;
  enableSignature: string | undefined;
  policies: Record<string, unknown>[];
  signer: Record<string, unknown> | undefined;
} {
  const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(approval), (c) => c.codePointAt(0)!)));
  const pp = json.permissionParams ?? {};
  return {
    accountAddress: json.accountParams?.accountAddress,
    initCode: json.accountParams?.initCode,
    enableSignature: json.enableSignature,
    policies: (pp.policies ?? []).map((p: { policyParams?: Record<string, unknown> }) => p.policyParams ?? p),
    signer: pp.signer,
  };
}

const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : typeof x === "string" ? x.toLowerCase() : x)));

/** On the server, before accepting a grant: the approval is for the expected pocket, has exactly the expected policies,
 *  and carries the main wallet's enable signature. Returns the reasons it does not. */
export async function checkApproval(pc: PublicClient, approval: string, mainOwner: Address, t: PocketTerms): Promise<string[]> {
  const out: string[] = [];
  let a: ReturnType<typeof readApproval>;
  try {
    a = readApproval(approval);
  } catch {
    return ["the approval is not readable"];
  }
  const want = await pocketAddress(pc, mainOwner, t.index ?? POCKET_INDEX);
  if (a.accountAddress?.toLowerCase() !== want.toLowerCase()) out.push(`the approval is for ${a.accountAddress}, the pocket is ${want}`);
  if (!a.enableSignature || a.enableSignature === "0x") out.push("the approval has no enable signature");
  const expected = pocketPolicies(t).map((p) => p.policyParams);
  if (JSON.stringify(norm(a.policies)) !== JSON.stringify(norm(expected))) out.push("the approval's limits differ from the agreed ones");
  // The session key's signer (the Assistant) is not stored in the approval: the main wallet's enable signature covers
  // it, and the Kernel checks that signature on the pocket's first operation. The server therefore installs the key
  // with a harmless first operation right away and treats the grant as live only once that lands.
  const got = await deserializePermissionAccount(pc, ENTRY_POINT, KERNEL_VERSION, approval, await toECDSASigner({ signer: addressOnly(t.assistant) })).catch(() => null);
  if (!got) out.push("the approval does not deserialize");
  else if (got.address.toLowerCase() !== want.toLowerCase()) out.push("the approval deserializes to another account");
  return out;
}

/** The main account's batch that funds the pocket: a plain test-dollar transfer to it. */
export function fundPocketCalls(dollar: Address, pocket: Address, amount: bigint): Call[] {
  return [{ to: dollar, value: 0n, data: encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [pocket, amount] }) }];
}

const transferAbi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
