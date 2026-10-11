// The day writer's failure line (e2e/world.ts errorOf): what a failed days.ts printed, reduced to its error and the
// node's own words. Bun prints the source lines around a throw first, and viem's buildRequest throws from a switch
// over every RPC error class, so the first line naming an error used to be a neighbouring case (InvalidRequestRpcError
// for a -32602 that was anvil's BlockOutOfRangeError).
import { describe, expect, test } from "bun:test";
import { errorOf } from "../e2e/world.ts";

// bun's output for anvil's -32602 through viem's http transport (paths shortened, the error object's dump left out)
const OUT_OF_RANGE = `45 |                     case rpc_js_1.InvalidRequestRpcError.code:
46 |                         throw new rpc_js_1.InvalidRequestRpcError(err);
47 |                     case rpc_js_1.MethodNotFoundRpcError.code:
48 |                         throw new rpc_js_1.MethodNotFoundRpcError(err, { method: args.method });
49 |                     case rpc_js_1.InvalidParamsRpcError.code:
50 |                         throw new rpc_js_1.InvalidParamsRpcError(err);
                                   ^
InvalidParamsRpcError: Invalid parameters were provided to the RPC method.
Double check you have provided the correct parameters.

URL: http://127.0.0.1:56540
Request body: {"method":"eth_call","params":[{"to":"0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36","data":"0x"},"latest"]}

Details: BlockOutOfRangeError: block height is 68300101 but requested was 68300100
Version: viem@2.57.2
       code: -32602,

      at <anonymous> (viem/_cjs/utils/buildRequest.js:50:31)
      at async <anonymous> (viem/_cjs/utils/promise/withRetry.js:27:36)

Bun v1.4.2 (macOS arm64)
`;

describe("the day writer's failure line", () => {
  test("a viem RPC error: its own class and the node's details, never a neighbouring case of the source excerpt", () => {
    const line = errorOf(OUT_OF_RANGE);
    expect(line).toBe("InvalidParamsRpcError: Invalid parameters were provided to the RPC method. Details: BlockOutOfRangeError: block height is 68300101 but requested was 68300100");
    expect(line).not.toContain("InvalidRequestRpcError");
  });

  test("a plain error thrown by the script itself", () => {
    const out = `73 |   if (rc.status !== "success") throw new Error(\`\${what} reverted (\${hash})\`);
                                          ^
error: postReport 20749/3 reverted (0xabc)
      at tx (ops/testnet/rehearse/days.ts:73:42)

Bun v1.4.2 (macOS arm64)
`;
    expect(errorOf(out)).toBe("error: postReport 20749/3 reverted (0xabc)");
  });

  test("no error line at all: the first line that is not source, and nothing for empty output", () => {
    expect(errorOf("12 | const x = 1;\nkilled by a signal\n")).toBe("killed by a signal");
    expect(errorOf("")).toBe("");
  });
});
