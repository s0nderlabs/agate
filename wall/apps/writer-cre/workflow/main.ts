// agate primary writer: a Chainlink CRE workflow (BUILD-SPEC 8.2). On its cron trigger it fetches every source
// page once through the HTTP capability (median consensus on the parsed integers per source and GPU on a real
// DON; one node in simulate), builds one entry per registered GPU for the current slice of the index clock, and
// writes the report to the index through the EVM write capability (onReport via the forwarder).
// The body lives in handler.ts: javy refuses exported functions with parameters in the entry module.
import { Runner } from "@chainlink/cre-sdk";
import { type Config, initWorkflow } from "./handler.ts";

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
