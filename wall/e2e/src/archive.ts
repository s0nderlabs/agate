// The replay's archive view: a scratch folder of symlinks to whole, finished hours of the live logger's archive
// (AGATE_RAW_DIR, default ~/.agate-index-logger/data/raw), so an hour the logger is still writing is never served.
// Nothing is copied: the links point at the archive, and the folder lives outside the repo.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// the archive as configured when the harness loaded (a World points AGATE_RAW_DIR at its own view while it runs)
const ARCHIVE = process.env.AGATE_RAW_DIR || join(homedir(), ".agate-index-logger", "data", "raw");

export function sourceRawDir(): string {
  return ARCHIVE;
}

export function archivePresent(): boolean {
  return existsSync(sourceRawDir());
}

/** Links the finished hours selected by `want(date, hour)`; returns the folder to use as AGATE_RAW_DIR. */
export function archiveView(want: (date: string, hour: string) => boolean): { rawDir: string; hours: string[] } {
  const src = sourceRawDir();
  const root = mkdtempSync(join(tmpdir(), "agate-e2e-archive-"));
  const raw = join(root, "data", "raw");
  mkdirSync(raw, { recursive: true });
  const readings = join(dirname(src), "readings.jsonl");
  if (existsSync(readings)) symlinkSync(readings, join(root, "data", "readings.jsonl"));
  const nowHour = new Date().toISOString().slice(0, 13); // the logger may still be writing this hour
  const hours: string[] = [];
  for (const date of readdirSync(src).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()) {
    for (const hour of readdirSync(join(src, date)).filter((h) => /^\d{2}$/.test(h)).sort()) {
      if (`${date}T${hour}` >= nowHour || !want(date, hour)) continue;
      mkdirSync(join(raw, date), { recursive: true });
      symlinkSync(join(src, date, hour), join(raw, date, hour));
      hours.push(`${date}T${hour}`);
    }
  }
  return { rawDir: raw, hours };
}
