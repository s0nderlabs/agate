import type { Metadata } from "next";
import { DocsIndex } from "@/components/docs/DocsIndex";
import { SITE } from "@/lib/docs/types";

const description =
  "How Agate's GPU-hour price is made, how its monthly market works, and every way in: the app, an AI, the API, the SDK and the contracts.";

// the share card comes from opengraph-image.tsx beside this page (no images key here, so that one is used)
export const metadata: Metadata = {
  title: "Agate docs",
  description,
  alternates: { canonical: `${SITE}/docs`, types: { "text/plain": `${SITE}/llms.txt` } },
  openGraph: { type: "website", siteName: "Agate", url: `${SITE}/docs`, title: "Agate docs", description },
  twitter: { card: "summary_large_image", title: "Agate docs", description },
};

export default function DocsHome() {
  return <DocsIndex />;
}
