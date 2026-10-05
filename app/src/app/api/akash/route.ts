// Akash's traded GPU prices for the comparison panel, from the shared-akash robot's file (wall/apps/akash, written
// every hour to <AGATE_WALL_HOME>/akash/akash-traded.json). Display only, never an index input. Only what the panel
// shows leaves the server. A server without the file answers 404, and the app keeps its dated reading.
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

export async function GET() {
  const home = process.env.AGATE_WALL_HOME || path.join(os.homedir(), ".agate-wall");
  let raw: { kind?: string; version?: number; generatedAt?: number; label?: string; gpus?: Record<string, FileGpu> };
  try {
    raw = JSON.parse(await readFile(path.join(home, "akash", "akash-traded.json"), "utf8"));
  } catch {
    return Response.json({ error: "no Akash reading on this server" }, { status: 404 });
  }
  if (raw.kind !== "agate.akash-traded" || raw.version !== 1 || typeof raw.generatedAt !== "number") return Response.json({ error: "unexpected Akash file" }, { status: 502 });
  const gpus = Object.fromEntries(
    Object.entries(raw.gpus ?? {}).map(([g, v]) => [g, { median: v.median === null ? null : Number(v.median), gpus: v.gpus, leases: v.leases, sellers: v.sellers, buyers: v.buyers }]),
  );
  return Response.json({ generatedAt: raw.generatedAt, label: raw.label ?? "traded, Akash chain", gpus });
}
