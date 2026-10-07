import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Apfel Grotezk (OFL) is self-hosted. Erode (ITF Free Font License) must load from Fontshare, never self-hosted.
const apfel = localFont({
  src: [
    { path: "../fonts/apfel-Regular.woff2", weight: "400", style: "normal" },
    { path: "../fonts/apfel-Mittel.woff2", weight: "500", style: "normal" },
    { path: "../fonts/apfel-Fett.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-apfel",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Agate",
  description: "An open onchain price for an hour of GPU time that anyone can trade, hedge or build on.",
};

// cover: the page runs under the notch and home bar, and the dock and sheets pad themselves with the safe areas.
// resizes-content: the on-screen keyboard shrinks the layout, so a sheet's button stays above it. Zoom stays allowed.
// theme-color follows the in-app theme once a screen mounts (useThemeColor).
export const viewport: Viewport = { themeColor: "#f6f5f1", viewportFit: "cover", interactiveWidget: "resizes-content" };

// The hosts every page reads first (the markets snapshot, the indexer, the chain): their connections open while the
// page loads instead of after the scripts run. The indexer and RPC settings are comma lists the client reads from the
// first entry, so the first entry of each is preconnected; the snapshot is one URL, as the client reads it. The RPC
// fallback is a copy of the client's PUBLIC_RPC, kept literal so this server file does not load viem. fetch() asks
// without cookies, so the connections are opened the same way (crossOrigin). A loopback host (the client's local rule)
// is skipped. Dynamic's own connection opens when Dynamic starts (getDynamic), since a signed-out visit never loads it.
const PUBLIC_RPC = "https://testnet-rpc.monad.xyz";
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;
const first = (list: string | undefined) =>
  (list ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean)[0];
const SNAPSHOT = process.env.NEXT_PUBLIC_AGATE_SNAPSHOT_URL?.trim() || null;
const origins = [SNAPSHOT, first(process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL), first(process.env.NEXT_PUBLIC_AGATE_RPC_URL) ?? PUBLIC_RPC]
  .map((u) => {
    try {
      const url = u ? new URL(u) : null;
      return url && !LOCAL.test(url.hostname) ? url.origin : null;
    } catch {
      return null;
    }
  })
  .filter((o): o is string => !!o);

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={apfel.variable}>
      <head>
        {[...new Set(origins)].map((o) => (
          <link key={o} rel="preconnect" href={o} crossOrigin="anonymous" />
        ))}
        {/* the markets snapshot is the page's first read: fetched while the scripts load, so a first visit does not
            wait for @agate/client's chunk before asking (the client's own fetch, same URL and mode, takes it) */}
        {SNAPSHOT && <link rel="preload" as="fetch" href={SNAPSHOT} crossOrigin="anonymous" />}
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=erode@300,400,500&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
