// Debug: match revert selectors from the live raw tests against Kernel / ZeroDev policy error names.
import { toFunctionSelector } from "viem";

const want = new Set(["0x3f7b7a68", "0x1c49f4d1", "0x59d52e40"]);
const names = [
  "CallViolatesParamRule()", "CallViolatesValueRule()", "InvalidCallType()", "InvalidCallData()", "NotInstalled()", "NotPermitted()",
  "RateLimitExceeded()", "RateLimitReached()", "PolicyFailed(uint256)", "PolicyFailed()", "SignerPrefixNotPresent()", "PolicyDataTooLarge()",
  "InvalidValidationReturn()", "InvalidValidator()", "InvalidSignature()", "InvalidNonce()", "EnableNotApproved()", "PolicySignatureOrderError()",
  "InvalidValidationType()", "InvalidMode()", "OnlyExecuteUserOp()", "InvalidSelector()", "InitConfigError(uint256)", "InvalidCaller()",
  "PermissionDataLengthMismatch()", "InvalidTarget()", "NotAllowed()", "CallNotAllowed()", "ValueLimitExceeded()", "ExecutionFailed()",
  "PolicyNotAllowed()", "AlreadyInitialized(address)", "NotInitialized(address)", "TimestampNotValid()", "ValidAfter()", "ValidUntil()",
  "InvalidPermission()", "PermissionNotFound()", "InvalidPermissionId()", "CallTypeNotSupported()", "InvalidParamRule()",
];
for (const n of names) {
  const s = toFunctionSelector(`function ${n}`);
  if (want.has(s)) console.log(s, n);
}
console.log("checked", names.length);
