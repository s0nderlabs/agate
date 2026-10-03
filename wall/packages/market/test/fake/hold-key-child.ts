// A child process for runtime.test.ts (audit M-K1): takes its key the way a bot does at start, prints its address,
// then waits so the parent can read its exec-time environment with `ps -wwE`. Never prints the key.
import { takeKey } from "../../src/runtime.ts";

const r = takeKey({ keyVar: "AGATE_TEST_CHILD_KEY", addressVar: "AGATE_TEST_CHILD_ADDRESS" }, process.env);
console.log(JSON.stringify({ from: r.from, keyVar: r.keyVar, cmdLeft: process.env.AGATE_KEY_CMD !== undefined, keyLeft: process.env.AGATE_TEST_CHILD_KEY !== undefined }));
await Bun.sleep(60_000);
