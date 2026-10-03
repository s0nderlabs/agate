// Runs inside the sandbox only (BUILD-SPEC 15.2): `sandbox-exec -p <PROFILE> bun run runner.ts <batch file>`, with no
// network and no file writes outside the draft's out folder. Reads each page of the batch and parses it with each
// listed parser version of the scratch copy (a draft is registered there), then prints one JSON object.
import { readFileSync } from "node:fs";

interface BatchPage {
  id: string;
  file?: string;
  body?: string;
  utcDate: string;
  nowSec: number;
}
interface Batch {
  pkg: string;
  versions: string[];
  pages: BatchPage[];
}

type ParseWith = (v: string, body: string, ctx: { utcDate: string; nowSec: number }) => unknown;

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("usage: runner.ts <batch file>");
  const batch = JSON.parse(readFileSync(path, "utf8")) as Batch;
  const api = (await import(`${batch.pkg}/src/pure/index.ts`)) as { parseWith?: ParseWith; PARSER_VERSIONS?: readonly string[] };
  if (typeof api.parseWith !== "function") throw new Error("the scratch copy has no parseWith");
  for (const v of batch.versions) if (!api.PARSER_VERSIONS?.includes(v)) throw new Error(`version ${v} is not registered in the scratch copy`);
  const results: { id: string; rows: Record<string, unknown> }[] = [];
  for (const p of batch.pages) {
    let body = p.body ?? "";
    if (p.file) {
      const raw = readFileSync(p.file);
      body = new TextDecoder("utf-8").decode(p.file.endsWith(".gz") ? Bun.gunzipSync(raw) : raw);
    }
    const rows: Record<string, unknown> = {};
    for (const v of batch.versions) {
      try {
        rows[v] = api.parseWith(v, body, { utcDate: p.utcDate, nowSec: p.nowSec });
      } catch (e) {
        rows[v] = { error: String(e instanceof Error ? e.message : e).slice(0, 200) };
      }
    }
    results.push({ id: p.id, rows });
  }
  process.stdout.write(JSON.stringify({ ok: true, results }));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, why: String(e instanceof Error ? e.message : e).slice(0, 300) }));
  process.exitCode = 1;
});
