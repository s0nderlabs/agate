// Moves a copied secret (e.g. a Dynamic API token) from the clipboard into AGATE_DYNAMIC_HOME/<file> as NAME=value
// (mode 600), prints only its length and prefix shape, then clears the clipboard. The value never reaches a log.
// bun run scripts/save-secret.ts DYNAMIC_ADMIN_TOKEN admin.env [expected-prefix]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, HOME } from "../src/config.ts";

const [name, file, prefix] = process.argv.slice(2);
if (!name || !file) throw new Error("usage: save-secret.ts NAME file.env [prefix]");
ensureHome();
const v = Bun.spawnSync(["pbpaste"]).stdout.toString().trim();
if (!v || /\s/.test(v)) throw new Error(`clipboard is empty or has spaces (length ${v.length}): copy the token again`);
if (prefix && !v.startsWith(prefix)) throw new Error(`clipboard does not start with ${prefix} (length ${v.length}): copy the token again`);
const f = join(HOME, file);
const lines = existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l && !l.startsWith(`${name}=`)) : [];
lines.push(`${name}=${v}`);
writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 });
Bun.spawnSync(["pbcopy"], { stdin: Buffer.from("") });
console.log(`saved ${name} to ${f} (length ${v.length}); clipboard cleared`);
