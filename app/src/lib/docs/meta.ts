// A docs chapter's page metadata: its title, canonical address and share card. Shared by the chapters written from
// markdown and the one written in the app (How Agate works), so every chapter's card is named the same way.
import type { Metadata } from "next";
import { SITE } from "./types";

/** A short fingerprint of what the share image shows, so a changed title or line gets a fresh image from sites that
 *  keep shared images by address. */
function imageVersion(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** The chapter's own share image (opengraph-image.tsx beside its page) is named here so it carries the chapter's alt
 *  text: a page's openGraph replaces the docs' one whole, image included. The card for X takes the same image. */
export function chapterMetadata(c: { slug: string; title: string; description: string; markdown?: boolean }): Metadata {
  const title = `${c.title} | Agate docs`;
  const url = `${SITE}/docs/${c.slug}`;
  const image = { url: `/docs/${c.slug}/opengraph-image?v=${imageVersion(c.title + c.description)}`, width: 1200, height: 630, type: "image/png", alt: `${c.title}, a chapter of the Agate docs: ${c.description}` };
  return {
    title,
    description: c.description,
    alternates: { canonical: url, ...(c.markdown ? { types: { "text/markdown": `${SITE}/docs/raw/${c.slug}.md` } } : {}) },
    openGraph: { type: "article", siteName: "Agate", url, title, description: c.description, images: [image] },
    twitter: { card: "summary_large_image", title, description: c.description, images: [image] },
  };
}
