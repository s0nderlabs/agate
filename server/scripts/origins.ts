// Dynamic's allowed origins (CORS) for this environment: list, or add some. Social sign-in stays disabled in the
// dashboard until at least one origin is set; once set, Dynamic answers only these origins.
// bun run scripts/origins.ts list | add <origin> [origin...]
import { config, requireSecret } from "../src/config.ts";

const base = `${config.dynamicApi}/environments/${config.environmentId}`;
const h = { authorization: `Bearer ${requireSecret("DYNAMIC_ADMIN_TOKEN", "admin.env")}`, "content-type": "application/json" };
const [cmd, ...rest] = process.argv.slice(2);
const list = async () => ((await (await fetch(`${base}/origins`, { headers: h })).json()) as { origins: { origin: string }[] }).origins.map((o) => o.origin);
if (cmd === "add") {
  const have = new Set(await list());
  for (const o of rest) {
    if (have.has(o)) {
      console.log("have", o);
      continue;
    }
    const r = await fetch(`${base}/origins`, { method: "POST", headers: h, body: JSON.stringify({ origin: o }) });
    console.log(r.status, o, r.ok ? "" : (await r.text()).slice(0, 200));
  }
}
console.log("origins:", (await list()).join(", ") || "(none)");
process.exit(0);
