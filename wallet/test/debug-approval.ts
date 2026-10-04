// Debug: what an approval stores for its signer and policies (no keys inside). FORK on FORK_PORT.
import { createPublicClient, http, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AGATE, createPocketPermission, kernelAccount, monadTestnet, readApproval } from "../src/index.ts";

const pc = createPublicClient({ chain: monadTestnet, transport: http(`http://127.0.0.1:${process.env.FORK_PORT ?? 18575}`) }) as PublicClient;
const main = privateKeyToAccount(generatePrivateKey());
const assistant = privateKeyToAccount(generatePrivateKey());
const mainAccount = (await kernelAccount(pc, main)).address;
const { approval } = await createPocketPermission(pc, main, { assistant: assistant.address, limits: { routers: [AGATE.router], dollar: AGATE.dollar, mainAccount, perTradeCap: 1n, shortTokensCap: 1n }, validUntil: 2_000_000_000, tradesPerDay: 3 });
const a = readApproval(approval);
console.log("assistant", assistant.address);
console.log("signer", JSON.stringify(a.signer));
console.log("policy types", a.policies.map((p) => p.type).join(","));
console.log("approval bytes", approval.length);
process.exit(0);
