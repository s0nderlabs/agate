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

export const viewport: Viewport = { themeColor: "#f6f5f1" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={apfel.variable}>
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=erode@300,400,500&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
