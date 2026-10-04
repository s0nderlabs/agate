import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // local render checks open the app at 127.0.0.1; without this Next blocks its dev scripts there
  allowedDevOrigins: ["127.0.0.1"],
  // @agate/client ships TypeScript source (../client); Next compiles node_modules only when listed
  transpilePackages: ["@agate/client"],
  turbopack: {
    // Turbopack resolves nothing outside its root, so the root is the repo, which holds both app/ and client/ (Next
    // docs: turbopack.root for linked packages)
    root: path.join(__dirname, ".."),
    // bun installs the file: dependency as folders of symlinks into ../client, and Turbopack will not read a symlinked
    // package.json. So the bundle takes the client from its source entry, and the client's viem from the app's own
    // copy (one viem in the bundle, the version both pin). TypeScript still reads the types through node_modules.
    resolveAlias: {
      // relative to this folder (app/)
      "@agate/client": "../client/src/index.ts",
      viem: "./node_modules/viem",
    },
  },
};

export default nextConfig;
