import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // local render checks open the app at 127.0.0.1; without this Next blocks its dev scripts there
  allowedDevOrigins: ["127.0.0.1"],
  // the dev "N" indicator sat over the chart legend (Mock controls hold the other corner); compile and runtime errors
  // still show without it
  devIndicators: false,
  // @agate/client and @agate/wallet ship TypeScript source (workspace packages); Next compiles them only when listed
  transpilePackages: ["@agate/client", "@agate/wallet"],
  turbopack: {
    // Turbopack resolves nothing outside its root, so the root is the repo, which holds app/ and the workspace packages
    // (Next docs: turbopack.root for linked packages). The root install is hoisted (bunfig.toml), so there is one viem.
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;
