// Backup codes for a passkey account: ten one-time codes that let a person who lost every copy of their passkey add
// a new one to the same account. A code is 8 Crockford base32 characters (40 bits), shown "XXXX-XXXX" once, when made;
// agate keeps only an HMAC of it under a pepper in HOME/backup-codes.key (made on first use, mode 600, never printed
// or logged), so a copy of the database alone cannot be searched for codes. The pepper is NOT in the database backups:
// a rebuild must restore it with the database (ops/dynamic/README.md). A missing pepper while codes exist is refused
// (every code would silently stop working), never replaced. Typing is forgiving the Crockford way:
// any case, with or without the dash or spaces, O read as 0 and I or L as 1.
import { createHmac, randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, HOME } from "../config.ts";

export const CODES_PER_SET = 10;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U

function readOrCreatePepper(home: string, hasCodes: () => boolean): Buffer {
  const f = join(home, "backup-codes.key");
  if (!existsSync(f)) {
    if (hasCodes()) throw new Error("backup-codes.key is missing while backup codes exist: restore it with the database");
    if (home === HOME) ensureHome();
    try {
      writeFileSync(f, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
    } catch (e) {
      // two first uses at once: the other one's file wins
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  const p = Buffer.from(readFileSync(f, "utf8").trim(), "base64");
  if (p.length < 32) throw new Error("the backup-code pepper is too short");
  return p;
}

export type BackupCodes = {
  /** a new set: the codes to show once, and their hashes to store */
  make(): { codes: string[]; hashes: string[] };
  /** the hash of what someone typed, or null when it cannot be a code */
  hashOf(typed: string): string | null;
};

/** `pepper`: tests pass their own; otherwise HOME/backup-codes.key. `hasCodes`: whether any code is stored. */
export function backupCodes(opts: { pepper?: () => Buffer; home?: string; hasCodes?: () => boolean } = {}): BackupCodes {
  let pepper: Buffer | undefined;
  const key = () => (pepper ??= opts.pepper?.() ?? readOrCreatePepper(opts.home ?? HOME, opts.hasCodes ?? (() => false)));
  const hash = (canonical: string) => createHmac("sha256", key()).update(canonical).digest("base64url");
  return {
    make() {
      const codes: string[] = [];
      const seen = new Set<string>();
      while (codes.length < CODES_PER_SET) {
        let c = "";
        for (let i = 0; i < 8; i++) c += ALPHABET[randomInt(ALPHABET.length)];
        if (seen.has(c)) continue;
        seen.add(c);
        codes.push(`${c.slice(0, 4)}-${c.slice(4)}`);
      }
      return { codes, hashes: codes.map((c) => hash(c.replace("-", ""))) };
    },
    hashOf(typed) {
      const c = normalize(typed);
      return c ? hash(c) : null;
    },
  };
}

/** what someone typed as the 8 canonical characters, or null */
export function normalize(typed: string): string | null {
  if (typeof typed !== "string" || typed.length > 32) return null;
  const c = typed
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(c) ? c : null;
}
