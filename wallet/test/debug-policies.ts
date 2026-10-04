// Debug: which pocket policy makes enable-mode validation revert (AA23) on a Monad testnet fork.
// FORK must already run on FORK_PORT. bun run test/debug-policies.ts
import { deserializePermissionAccount, serializePermissionAccount, toPermissionValidator } from "@zerodev/permissions";
import { CallPolicyVersion, toCallPolicy, toRateLimitPolicy, toSignatureCallerPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { toECDSASigner, toEmptyECDSASigner } from "@zerodev/permissions/signers";
import { createKernelAccount } from "@zerodev/sdk";
import { createPublicClient, encodeFunctionData, http, type PublicClient, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { abi } from "@agate/client";
import { AGATE, ENTRY_POINT, KERNEL_VERSION, accountClient, kernelAccount, monadTestnet, pocketPermissions, RATE_LIMIT_WITH_RESET, sendCalls, sudoValidator } from "../src/index.ts";
import { miniBundler } from "./miniBundler.ts";

const FORK = `http://127.0.0.1:${process.env.FORK_PORT ?? 18575}`;
const pc = createPublicClient({ chain: monadTestnet, transport: http(FORK) }) as PublicClient;
const rpc = (method: string, params: unknown[]) => fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
const executor = privateKeyToAccount(generatePrivateKey());
await rpc("anvil_setBalance", [executor.address, toHex(10n ** 20n)]);
const sponsor = { bundler: miniBundler(FORK, executor).transport };
const drip = { to: AGATE.dollar, value: 0n, data: encodeFunctionData({ abi: abi.agateDollarAbi, functionName: "drip", args: [] }) };
const now = Number((await pc.getBlock()).timestamp);

const variants: Record<string, (main: `0x${string}`) => unknown[]> = {
  callOnly: (m) => [toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: pocketPermissions({ routers: [AGATE.router], dollar: AGATE.dollar, mainAccount: m, perTradeCap: 1n, shortTokensCap: 1n }) as never })],
  timestamp: () => [toTimestampPolicy({ validUntil: now + 86_400 })],
  rateReset: () => [toRateLimitPolicy({ policyAddress: RATE_LIMIT_WITH_RESET, interval: 86_400, count: 3 })],
  rateClassic: () => [toRateLimitPolicy({ count: 3 })],
  sigNone: () => [toSignatureCallerPolicy({ policyFlag: "0x0001" as never, allowedCallers: [] })],
  sigOne: () => [toSignatureCallerPolicy({ policyFlag: "0x0001" as never, allowedCallers: [AGATE.router] })],
  callPlusTs: (m) => [...variants.callOnly!(m), toTimestampPolicy({ validUntil: now + 86_400 })],
};

for (const [name, mk] of Object.entries(variants)) {
  const main = privateKeyToAccount(generatePrivateKey());
  const assistant = privateKeyToAccount(generatePrivateKey());
  const mainAddr = (await kernelAccount(pc, main)).address;
  const sudo = await sudoValidator(pc, main);
  const regular = await toPermissionValidator(pc, { entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION, signer: toEmptyECDSASigner(assistant.address), policies: mk(mainAddr) as never });
  const acct = await createKernelAccount(pc, { entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION, index: 1n, plugins: { sudo, regular } });
  await rpc("anvil_setBalance", [acct.address, toHex(10n ** 20n)]);
  const approval = await serializePermissionAccount(acct);
  const session = await deserializePermissionAccount(pc, ENTRY_POINT, KERNEL_VERSION, approval, await toECDSASigner({ signer: assistant }));
  try {
    const r = await sendCalls(accountClient(session, pc, sponsor), [drip]);
    console.log(name.padEnd(12), "OK", r.success);
  } catch (e) {
    const m = (e as Error).message.match(/AA\d\d[^,)]*/)?.[0] ?? (e as Error).message.slice(0, 120);
    console.log(name.padEnd(12), "FAIL", m);
  }
}
process.exit(0);
