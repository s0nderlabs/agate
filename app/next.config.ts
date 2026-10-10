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
  // the Index page lives at /gpu-index: at /index, Next's client router took "/index" for "/" (Markets showed the Index
  // page and a Markets click did nothing). Old links still land on it. Oct 10: the site at the root, the app under /app; every
  // old app address (the server's /connect?request= and /approve?request= links, guides, bookmarks) lands on its new
  // one with its query. They stay; "not permanent" only keeps browsers from caching them. ("/p/:rest*" matches "/p" too.)
  async redirects() {
    return [
      { source: "/index", destination: "/app/gpu-index", permanent: false },
      { source: "/landing", destination: "/", permanent: false },
      ...["positions", "gpu-index", "ai", "connect", "approve"].map((p) => ({ source: `/${p}/:rest*`, destination: `/app/${p}/:rest*`, permanent: false })),
    ];
  },
  // the developer API (docs/site/08-api.md) at the app's own address: /api/v1/... is agate's server's /v1/..., proxied
  async rewrites() {
    const server = process.env.NEXT_PUBLIC_AGATE_SERVER || "https://agate-1.tailf06dd7.ts.net";
    return [
      { source: "/api/v1", destination: `${server}/v1` },
      { source: "/api/v1/:path*", destination: `${server}/v1/:path*` },
    ];
  },
  turbopack: {
    // Turbopack resolves nothing outside its root, so the root is the repo, which holds app/ and the workspace packages
    // (Next docs: turbopack.root for linked packages). The root install is hoisted (bunfig.toml), so there is one viem.
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;
