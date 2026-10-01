// Creates the agent policy in the operator's Privy app and writes its id (plus the signer id) to
// agent/policy.json, which the web app reads. Run once per one-day window:
//   PRIVY_SIGNER_ID=<key quorum id from the dashboard> bun run policy
// Needs PRIVY_APP_SECRET. Prints nothing secret.
import { writeFileSync } from "node:fs";
import { PrivyClient } from "@privy-io/node";
import { agentPolicy } from "./policy-def";
import { appId, fail, flag, policyPath, savedPolicy, secret } from "./env";
import { flow } from "../../shared/config";

const signerId = process.env.PRIVY_SIGNER_ID || savedPolicy().signerId;
if (!signerId) fail("PRIVY_SIGNER_ID missing: the key quorum id shown next to your authorization key in the Privy dashboard");

const expiry = Math.floor(Date.now() / 1000) + flow.agentTtlSeconds;
const body = agentPolicy(expiry);

if (flag("dry-run")) {
  console.log(JSON.stringify({ signerId, expiry, policy: body }, null, 2));
  process.exit(0);
}

const privy = new PrivyClient({ appId: appId(), appSecret: secret("PRIVY_APP_SECRET") });
const policy = await privy.policies().create(body);
writeFileSync(policyPath, JSON.stringify({ policyId: policy.id, signerId, expiry, createdAt: new Date().toISOString() }, null, 2) + "\n");
console.log(`policy ${policy.id} created, valid until ${new Date(expiry * 1000).toISOString()}`);
console.log(`wrote ${policyPath}. Restart the web app dev server so step 4 picks it up.`);
