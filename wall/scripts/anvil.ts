// Starts a local test chain through anvil-safe.sh and waits until it answers. When the wrapper refuses (every
// slot busy, free disk under the floor) or anvil dies, the error carries the wrapper's own reason instead of a
// bare timeout. Local chains only.
export const ANVIL_SAFE = `${import.meta.dir}/anvil-safe.sh`;

export function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port!;
  s.stop(true);
  return p;
}

async function answers(rpc: string): Promise<boolean> {
  try {
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(2_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export type AnvilProc = { proc: Bun.Subprocess; port: number; rpc: string };

/** args go to anvil after `--port`; env is added to this process's environment (e.g. AGATE_ANVIL_ROOT). `states`: how
 *  many recent block states anvil keeps in memory (anvil-safe's leading count, `--prune-history <n>`; never on disk).
 *  None by default: a read at "latest" that races a newly mined block then fails (-32602 BlockOutOfRangeError). */
export async function spawnAnvil(args: string[], o: { env?: Record<string, string>; timeoutMs?: number; states?: number } = {}): Promise<AnvilProc> {
  if (o.states !== undefined && !(Number.isInteger(o.states) && o.states > 0)) throw new Error(`states must be a positive integer, not ${o.states}`);
  const port = freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const states = o.states ? [String(o.states)] : [];
  const proc = Bun.spawn([ANVIL_SAFE, ...states, "--port", String(port), ...args], { env: { ...process.env, ...o.env }, stdout: "ignore", stderr: "pipe" });
  const err = new Response(proc.stderr).text(); // drained from the start so a chatty anvil can never block on the pipe
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  const deadline = Date.now() + (o.timeoutMs ?? 90_000); // longer than the wrapper's 60 s wait for a slot
  while (!exited && Date.now() < deadline) {
    if (await answers(rpc)) return { proc, port, rpc };
    await Bun.sleep(50);
  }
  if (!exited) proc.kill();
  await proc.exited;
  const why = (await err).trim();
  throw new Error(`anvil did not start${why ? `: ${why}` : ""}`);
}
