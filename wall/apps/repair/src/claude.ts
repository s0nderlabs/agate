// Claude Code headless (BUILD-SPEC 15.2): `claude -p` with every built-in tool off, no MCP server, no session kept,
// Claude Code's own sign-in (no API key), the prompt on stdin, a fresh empty cwd and a scrubbed environment.
// The answer is a proposal: schema-checked here again, then gated and sandboxed before anything else.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_PROMPT } from "./untrusted.ts";
import type { Spawner } from "./spawn.ts";

export const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["diagnosis", "extractorSource", "notes"],
  properties: {
    diagnosis: { enum: ["redesign", "wrong_cell", "moved", "blocked", "sold_out", "unsure"] },
    proposedUrl: { type: "string", maxLength: 256 },
    extractorSource: { type: "string", maxLength: 40000 },
    notes: { type: "string", maxLength: 2000 },
  },
} as const;

export type ModelDiagnosis = "redesign" | "wrong_cell" | "moved" | "blocked" | "sold_out" | "unsure";
export interface Answer {
  diagnosis: ModelDiagnosis;
  proposedUrl?: string;
  extractorSource: string;
  notes: string;
}

/** Flags the CLI must list in `--help` before any call is made (15.2). */
export const REQUIRED_FLAGS = ["--restricted", "--safe-mode", "--tools", "--json-schema", "--strict-mcp-config", "--no-session-persistence"] as const;

/** The JSON field the CLI puts the schema-checked object in (Claude Code docs, headless: "--json-schema ... The parsed
 *  output is placed in the structured_output field"); a `result` string holding the JSON is the fallback. */
export const STRUCTURED_FIELD = "structured_output";

/** Variables the Claude child may see; everything else (AGATE_*, keys, RPC URLs, ANTHROPIC_API_KEY) is dropped. */
export const CHILD_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TERM"] as const;

export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_KEYS) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}

/** argv after the binary, exactly as 15.2 lists it; the prompt is never in it. */
export function claudeArgs(model?: string): string[] {
  return [
    "-p",
    "--restricted",
    // no CLAUDE.md, skills, plugins or hooks of the operator's own setup reach the call (auth still works)
    "--safe-mode",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(ANSWER_SCHEMA),
    "--system-prompt",
    SYSTEM_PROMPT,
    ...(model ? ["--model", model] : []),
  ];
}

/** Validates an answer against ANSWER_SCHEMA by hand (no extra fields, the enum, every length). */
export function validateAnswer(x: unknown): { ok: true; answer: Answer } | { ok: false; why: string } {
  if (!x || typeof x !== "object" || Array.isArray(x)) return { ok: false, why: "the answer is not an object" };
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(k in ANSWER_SCHEMA.properties)) return { ok: false, why: `the answer has an extra field ${JSON.stringify(k.slice(0, 40))}` };
  for (const k of ANSWER_SCHEMA.required) if (!(k in o)) return { ok: false, why: `the answer lacks ${k}` };
  if (!ANSWER_SCHEMA.properties.diagnosis.enum.includes(o.diagnosis as ModelDiagnosis)) return { ok: false, why: "the answer's diagnosis is not one of the six" };
  if (typeof o.extractorSource !== "string" || o.extractorSource.length > 40_000) return { ok: false, why: "extractorSource is not a string of at most 40,000 characters" };
  if (typeof o.notes !== "string" || o.notes.length > 2_000) return { ok: false, why: "notes is not a string of at most 2,000 characters" };
  if (o.proposedUrl !== undefined && (typeof o.proposedUrl !== "string" || o.proposedUrl.length > 256)) return { ok: false, why: "proposedUrl is not a string of at most 256 characters" };
  const answer: Answer = { diagnosis: o.diagnosis as ModelDiagnosis, extractorSource: o.extractorSource, notes: o.notes };
  if (typeof o.proposedUrl === "string" && o.proposedUrl !== "") answer.proposedUrl = o.proposedUrl;
  return { ok: true, answer };
}

/** The schema-checked object from the CLI's JSON output: structured_output, else a `result` string holding JSON. */
export function answerFromStdout(stdout: string): { ok: true; answer: Answer } | { ok: false; why: string } {
  let j: unknown;
  try {
    j = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, why: "the CLI did not print JSON" };
  }
  const o = (j && typeof j === "object" ? j : {}) as Record<string, unknown>;
  if (o.is_error === true) return { ok: false, why: `the CLI reported an error (${String(o.subtype ?? "error").slice(0, 60)})` };
  if (o[STRUCTURED_FIELD] !== undefined && o[STRUCTURED_FIELD] !== null) return validateAnswer(o[STRUCTURED_FIELD]);
  if (typeof o.result === "string") {
    try {
      return validateAnswer(JSON.parse(o.result));
    } catch {
      return { ok: false, why: "the CLI's result is not the answer's JSON" };
    }
  }
  return { ok: false, why: "the CLI printed no structured output" };
}

export interface ClaudeDeps {
  spawner: Spawner;
  cwdRoot: string; // <repair>/claude-cwd
  env: Record<string, string | undefined>;
  timeoutS: number;
  model?: string;
}

/** `<bin> --help` must list every required flag; otherwise no call is ever made. */
export async function checkCli(d: ClaudeDeps): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    const r = await d.spawner.run("claude", ["--help"], { env: childEnv(d.env), timeoutMs: 30_000, maxStdout: 512 * 1024 });
    const text = `${r.stdout}\n${r.stderr}`;
    const missing = REQUIRED_FLAGS.filter((f) => !new RegExp(`(^|\\s)${f.replace(/-/g, "\\-")}(\\s|,|=|$)`, "m").test(text));
    if (r.timedOut || missing.length > 0) return { ok: false, why: `the Claude CLI lacks a required flag (${missing.join(", ") || "help timed out"})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `the Claude CLI could not be started (${(e as Error).message.slice(0, 80)})` };
  }
}

/** One call: a fresh empty cwd (deleted after), the scrubbed environment, the prompt on stdin. */
export async function callClaude(d: ClaudeDeps, prompt: string): Promise<{ ok: true; answer: Answer; raw: string } | { ok: false; why: string; raw: string }> {
  const cwd = join(d.cwdRoot, [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  mkdirSync(cwd, { recursive: true });
  try {
    let r;
    try {
      r = await d.spawner.run("claude", claudeArgs(d.model), { cwd, env: childEnv(d.env), stdin: prompt, timeoutMs: d.timeoutS * 1000, maxStdout: 2 * 1024 * 1024 });
    } catch (e) {
      return { ok: false, why: `the Claude CLI could not be started (${(e as Error).message.slice(0, 80)})`, raw: "" };
    }
    if (r.timedOut) return { ok: false, why: `Claude did not answer within ${d.timeoutS} s`, raw: "" };
    if (r.code !== 0) return { ok: false, why: `the Claude CLI exited ${r.code}`, raw: r.stdout.slice(0, 4_000) };
    const a = answerFromStdout(r.stdout);
    return a.ok ? { ok: true, answer: a.answer, raw: r.stdout } : { ok: false, why: a.why, raw: r.stdout.slice(0, 4_000) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
