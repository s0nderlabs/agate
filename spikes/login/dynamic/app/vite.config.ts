import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

const appDir = import.meta.dirname;
const spikeDir = resolve(appDir, "..");
const sharedDir = resolve(spikeDir, "../shared");
const idsPath = resolve(sharedDir, "ids.json");

const readIds = (): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(idsPath, "utf8"));
  } catch {
    return {};
  }
};

// Serves shared/ids.json fresh on every request, so ids written after the dev server started are picked up
// on a page reload. A production build also bakes in whatever exists at build time.
const idsPlugin = (): Plugin => {
  // Must return void: a function returned from configureServer is treated as a post hook.
  const serve = (server: { middlewares: { use: (path: string, fn: (req: unknown, res: any) => void) => unknown } }): void => {
    server.middlewares.use("/ids.json", (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(readIds()));
    });
  };
  return { name: "agate-ids", configureServer: serve, configurePreviewServer: serve };
};

export default defineConfig(() => {
  const ids = readIds();
  if (!ids.dynamicEnvironmentId) console.warn(`[dynamic spike] ${idsPath} has no dynamicEnvironmentId yet; the page will say so.`);
  return {
    root: appDir,
    envDir: spikeDir,
    plugins: [react(), idsPlugin()],
    define: { __IDS_AT_BUILD__: JSON.stringify(ids) },
    server: { host: "localhost", port: 5173, strictPort: true, fs: { allow: [spikeDir, sharedDir] } },
    preview: { host: "localhost", port: 5173, strictPort: true },
    build: { outDir: resolve(spikeDir, "dist"), emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  };
});
