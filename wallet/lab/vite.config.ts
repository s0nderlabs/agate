// The wallet lab: a bare page that runs agate's Dynamic flows end to end on Monad testnet (the reference for the app).
// bun run lab   ->  http://localhost:5174
// The ZeroDev RPC (project id inside) is read at dev time from AGATE_DYNAMIC_HOME/zerodev.env and only ever served
// to this local page.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "vite";

const home = process.env.AGATE_DYNAMIC_HOME ?? join(homedir(), ".agate-dynamic");
const zd = (() => {
  const f = join(home, "zerodev.env");
  if (!existsSync(f)) return "";
  return /ZERODEV_RPC=(\S+)/.exec(readFileSync(f, "utf8"))?.[1] ?? "";
})();

export default defineConfig({
  root: import.meta.dirname,
  define: {
    __ZERODEV_RPC__: JSON.stringify(zd),
    __AGATE_SERVER__: JSON.stringify(process.env.AGATE_SERVER_URL ?? "http://127.0.0.1:5191"),
    // must equal the server's AGATE_EXTRA_ROUTERS (same order): the pocket signs exactly this router list
    __EXTRA_ROUTERS__: JSON.stringify((process.env.AGATE_EXTRA_ROUTERS ?? "").split(",").filter(Boolean)),
  },
  server: { host: "localhost", port: 5174, strictPort: true, fs: { allow: [resolve(import.meta.dirname, "..", "..")] } },
  build: { chunkSizeWarningLimit: 4000 },
});
