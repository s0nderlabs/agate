import type { Metadata } from "next";
import { DocsIndex } from "@/components/docs/DocsIndex";
import { SITE } from "@/lib/docs/types";

export const metadata: Metadata = {
  title: "Agate docs",
  description: "How Agate's GPU-hour price is made, how its monthly market works, and every way in: the app, an AI, the API, the SDK and the contracts.",
  alternates: { canonical: `${SITE}/docs`, types: { "text/plain": `${SITE}/llms.txt` } },
};

export default function DocsHome() {
  return <DocsIndex />;
}
