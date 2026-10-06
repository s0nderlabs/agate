// Akash's traded GPU prices for the comparison panel, from the shared-akash robot's file (wall/apps/akash, written
// every hour to <AGATE_WALL_HOME>/akash/akash-traded.json). A hosted app has no such folder, so AGATE_AKASH_URL, when
// set, names where the robot's machine serves the same file. Display only, never an index input. Only what the panel
// shows leaves the server. Without a reading the route answers 404, and the app keeps its dated reading.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface FileGpu {
  median: string | null;
  gpus: number;
  leases: number;
  sellers: number;
  buyers: number;
}
type Raw = { kind?: string; version?: number; generatedAt?: number; label?: string; gpus?: Record<string, FileGpu> };

async function readRaw(): Promise<Raw | null> {
  const url = process.env.AGATE_AKASH_URL;
  const home = process.env.AGATE_WALL_HOME || path.join(os.homedir(), ".agate-wall");
  try {
    if (!url) return JSON.parse(await readFile(path.join(home, "akash", "akash-traded.json"), "utf8")) as Raw;
    // the robot writes hourly: a good reading is kept ten minutes for every visitor (Next caches only a 200), and a
    // machine that stops answering costs a visitor five seconds, not the function's whole run
    const r = await fetch(url, { next: { revalidate: 600 }, signal: AbortSignal.timeout(5000) });
    return r.ok ? ((await r.json()) as Raw) : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const raw = await readRaw();
  if (!raw) return Response.json({ error: "no Akash reading on this server" }, { status: 404 });
  if (raw.kind !== "agate.akash-traded" || raw.version !== 1 || typeof raw.generatedAt !== "number") return Response.json({ error: "unexpected Akash file" }, { status: 502 });
  const gpus = Object.fromEntries(
    Object.entries(raw.gpus ?? {}).map(([g, v]) => [g, { median: v.median === null ? null : Number(v.median), gpus: v.gpus, leases: v.leases, sellers: v.sellers, buyers: v.buyers }]),
  );
  return Response.json({ generatedAt: raw.generatedAt, label: raw.label ?? "traded, Akash chain", gpus });
}
