// The addresses of the configured test world (test/fixtures/deployments.test.json, the same file config.yaml is
// generated from), plus made-up addresses for the dynamic contracts and accounts of the unit tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeployments } from "../scripts/config-gen.ts";

export const deployments = parseDeployments(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/deployments.test.json"), "utf8")));
const f = (name: string) => deployments.factories.find((x) => x.name === name)!;
export const DEMO = f("demo");
export const REAL = f("real");
export const PILOT = f("pilot");
export const DOLLAR = deployments.dollar;
export const START = Math.min(...deployments.factories.map((x) => x.startBlock)); // config.yaml's start_block

const a = (prefix: string, n: number) => `0x${prefix}${n.toString(16).padStart(40 - prefix.length, "0")}`;
export const series = (n: number) => a("5e", n);
export const token = (n: number) => a("70", n);
export const market = (n: number) => a("ba", n);
export const user = (n: number) => a("ad", n);
export const ZERO = "0x0000000000000000000000000000000000000000";
export const H100 = "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955";
export const H200 = "0xf7b3c4797305bd1433be196119ae5d6df4a433cffbf8d02c22048cc3a487b30d";
export const U = 1_000_000n;
