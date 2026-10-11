import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // local render checks open the app at 127.0.0.1; without this Next blocks its dev scripts there. AGATE_DEV_ORIGINS
  // (a comma list, set in a local env file) adds more, such as a private network name for testing on a phone.
  allowedDevOrigins: ["127.0.0.1", ...(process.env.AGATE_DEV_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean)],
  // the dev "N" indicator sat over the chart legend (Mock controls hold the other corner); compile and runtime errors
  // still show without it
  devIndicators: false,
  // @agate/client and @agate/wallet ship TypeScript source (workspace packages); Next compiles them only when listed
  transpilePackages: ["@agate/client", "@agate/wallet"],
  // the Index page lives at /gpu-index: at /index, Next's client router took "/index" for "/" (Markets showed the Index
  // page and a Markets click did nothing). Old links still land on it. Oct 10: the site at the root, the app under /app; every
  // old app address (the server's /connect?request= and /approve?request= links, guides, bookmarks) lands on its new
  // one with its query. They stay; "not permanent" only keeps browsers from caching them. A bare path has its own rule:
  // "/p/:rest*" alone also matches "/p", but on Vercel it sends "/app/p/" and then strips the slash (two hops). Oct 11:
  // How Agate works moved into the docs as their first chapter.
  async redirects() {
    return [
      { source: "/index", destination: "/app/gpu-index", permanent: false },
      { source: "/app/how", destination: "/docs/how-agate-works", permanent: false },
      { source: "/landing", destination: "/", permanent: false },
      ...["positions", "gpu-index", "ai", "connect", "approve"].flatMap((p) => [
        { source: `/${p}`, destination: `/app/${p}`, permanent: false },
        { source: `/${p}/:rest+`, destination: `/app/${p}/:rest+`, permanent: false },
      ]),
    ];
  },
  // the H100 film's frames (221 files a visit): public files are served "max-age=0, must-revalidate", which asks the
  // server about every one on every visit. A day in the browser, and a week more of using the copy while it checks in
  // the background; their addresses carry the render's name (frames.ts), so a new render is fetched fresh. Hosted
  // builds only: a local server keeps its default, so a frame staged again shows on the next reload.
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    const cache = [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }];
    return [
      { source: "/landing/h100/:file*", headers: cache },
      { source: "/landing/h100s/:file*", headers: cache },
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
