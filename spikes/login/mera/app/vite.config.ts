import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const drip = { "/drip": { target: "http://127.0.0.1:5181", changeOrigin: true } };

// Served on localhost (not 127.0.0.1): WebAuthn needs a secure context and the rpId is the hostname.
export default defineConfig({
  root: here,
  envDir: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5171,
    strictPort: true,
    proxy: drip,
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
  preview: { host: "localhost", port: 5171, strictPort: true, proxy: drip },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
