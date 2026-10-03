// Writes a deploy config's GPU entries (contracts/script/config/<name>.json, "gpus") from a panel file's deploy
// entries, leaving the rest of the file byte for byte (13.3, 18.3).
//   bun run scripts/deploy-gpus.ts <name> [--check]
// <name>: the config without .json (testnet-demo, local-demo, ...). A testnet config registers panels/launch.json, the
// launch indexes' panel (7.10); a local or fork config panels/default.json. --check writes nothing and exits 1 when the
// config's entries differ from the panel's.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DeployEntry, deployGpus, panelFileFor, withGpus } from "../src/panelTool.ts";

const [name, ...rest] = process.argv.slice(2);
if (!name || !/^[a-z0-9-]+$/.test(name)) {
  console.error("usage: bun run scripts/deploy-gpus.ts <config name, e.g. testnet-demo> [--check]");
  process.exit(2);
}
const config = `${name}.json`;
const path = join(import.meta.dir, "..", "..", "..", "..", "contracts", "script", "config", config);
if (!existsSync(path)) {
  console.error(`${path} does not exist: write its profile, roles and forwarder first`);
  process.exit(2);
}
if (/^market-/.test(name)) {
  console.error(`${config} is a market config: its gpus are the factory's three, never written from a panel`);
  process.exit(2);
}
const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
if (!parsed.profile || !parsed.roles) {
  console.error(`${config} is not an index deploy config (no profile or roles)`);
  process.exit(2);
}
const panelFile = panelFileFor(config);
const panel = JSON.parse(readFileSync(join(import.meta.dir, "..", "panels", panelFile), "utf8")) as { deploy: DeployEntry[] };
const gpus = deployGpus(config, panelFile, panel.deploy);
const text = readFileSync(path, "utf8");
const have = (JSON.parse(text) as { gpus?: DeployEntry[] }).gpus; // the gpus hold no number above 2^53
const same = JSON.stringify(have ?? null) === JSON.stringify(gpus);
if (rest.includes("--check")) {
  console.log(`${config}: ${same ? "registers" : "does NOT register"} the ${gpus.length} entries of panels/${panelFile}`);
  process.exit(same ? 0 : 1);
}
if (!same) writeFileSync(path, withGpus(text, gpus));
console.log(`${config}: ${same ? "already registers" : "now registers"} the ${gpus.length} entries of panels/${panelFile} (${gpus.map((g) => g.gpu).join(", ")})`);
