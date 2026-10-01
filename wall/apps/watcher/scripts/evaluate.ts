// Rule R v4.3 on a JSON scenario (the differential-test entry point): `bun run scripts/evaluate.ts scenario.json`
// prints the full Evaluation as JSON (stdin when no file is given).
import { readFileSync } from "node:fs";
import { evaluate } from "../src/rule/decide.ts";
import type { RuleScenario } from "../src/rule/types.ts";

const text = process.argv[2] ? readFileSync(process.argv[2], "utf8") : await new Response(Bun.stdin.stream()).text();
const out = evaluate(JSON.parse(text) as RuleScenario);
console.log(JSON.stringify(out, null, 1));
