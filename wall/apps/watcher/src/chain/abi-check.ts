// The ABI the watcher speaks must be the rule R v4.3 interface (signAll, needsSign, missAdvanced). A stale generated
// abi.ts would mis-decode clocks(), record() and the events, so every process refuses to start on one.
import type { Abi, AbiEvent, AbiFunction, AbiParameter } from "viem";

function comps(p: AbiParameter | undefined): string[] {
  return ((p as { components?: AbiParameter[] } | undefined)?.components ?? []).map((c) => c.name ?? "");
}

export function abiProblems(abi: Abi): string[] {
  const out: string[] = [];
  const fn = (n: string) => abi.find((x) => x.type === "function" && x.name === n) as AbiFunction | undefined;
  const ev = (n: string) => abi.find((x) => x.type === "event" && x.name === n) as AbiEvent | undefined;
  if (!comps(fn("clocks")?.outputs[0]).includes("signAll")) out.push("Clocks has no signAll");
  if (!comps(fn("record")?.outputs[2]).includes("needsSign")) out.push("Record has no needsSign");
  if (!ev("DayClosed")?.inputs.some((i) => i.name === "needsSign")) out.push("DayClosed has no needsSign");
  if (!ev("DayCarried")?.inputs.some((i) => i.name === "missAdvanced")) out.push("DayCarried has no missAdvanced");
  return out;
}
