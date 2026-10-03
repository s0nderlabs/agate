// The only place the repair agent starts a process (BUILD-SPEC 15.2): the Claude CLI, sandbox-exec, bun, tsc and
// osascript, each by its configured path, never through a shell, always with an explicit environment (nothing is
// inherited), a timeout (then killed) and a cap on what it may print.

export type ProgramKind = "claude" | "sandbox" | "bun" | "tsc" | "osascript";
export const PROGRAM_KINDS: readonly ProgramKind[] = ["claude", "sandbox", "bun", "tsc", "osascript"];

export interface RunOptions {
  cwd?: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  maxStdout?: number; // bytes kept; more is cut and flagged
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

async function readCapped(s: ReadableStream<Uint8Array> | null | undefined, cap: number): Promise<{ text: string; truncated: boolean }> {
  if (!s) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let n = 0;
  let truncated = false;
  const reader = s.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (n < cap) {
      const keep = value.subarray(0, Math.max(0, cap - n));
      chunks.push(keep);
      if (keep.length < value.length) truncated = true;
    } else truncated = true;
    n += value.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export class Spawner {
  readonly log: { kind: ProgramKind; argv: string[] }[] = [];

  constructor(readonly programs: Readonly<Record<ProgramKind, string>>) {}

  async run(kind: ProgramKind, args: readonly string[], o: RunOptions): Promise<RunResult> {
    if (!PROGRAM_KINDS.includes(kind)) throw new Error(`refused to start ${String(kind)}: not on the allowlist`);
    const argv = [this.programs[kind], ...args];
    this.log.push({ kind, argv });
    const p = Bun.spawn(argv, {
      cwd: o.cwd,
      env: o.env,
      stdin: o.stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill("SIGKILL");
    }, o.timeoutMs);
    try {
      const cap = o.maxStdout ?? 4 * 1024 * 1024;
      // read while writing stdin, so neither side can fill a pipe and wait for the other
      const reading = Promise.all([readCapped(p.stdout, cap), readCapped(p.stderr, 64 * 1024)]);
      if (o.stdin !== undefined && p.stdin) {
        try {
          p.stdin.write(o.stdin);
          await p.stdin.end();
        } catch {
          // the child closed its input early; its exit code and output tell the rest
        }
      }
      const [out, err] = await reading;
      const code = await p.exited;
      return { code: timedOut ? null : code, stdout: out.text, stderr: err.text, timedOut, truncated: out.truncated };
    } finally {
      clearTimeout(timer);
    }
  }
}
