import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocArticle } from "@/components/docs/DocArticle";
import { getChapter, getChapters } from "@/lib/docs/content";
import { SITE } from "@/lib/docs/types";

// one page per chapter, all written at build; any other slug is a 404 (never rendered on a request)
export const dynamicParams = false;

export function generateStaticParams() {
  return getChapters().map((c) => ({ slug: c.slug }));
}

/** A short fingerprint of what the share image shows, so a changed title or line gets a fresh image from sites that
 *  keep shared images by address. */
function imageVersion(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export async function generateMetadata({ params }: PageProps<"/docs/[slug]">): Promise<Metadata> {
  const found = getChapter((await params).slug);
  if (!found) return {};
  const c = found.chapter;
  const title = `${c.title} | Agate docs`;
  const url = `${SITE}/docs/${c.slug}`;
  // the chapter's own share image (opengraph-image.tsx beside this page), named here so it carries the chapter's alt
  // text; the share card for X takes the same image, title and line
  const image = { url: `/docs/${c.slug}/opengraph-image?v=${imageVersion(c.title + c.description)}`, width: 1200, height: 630, type: "image/png", alt: `${c.title}, a chapter of the Agate docs: ${c.description}` };
  return {
    title,
    description: c.description,
    alternates: { canonical: url, types: { "text/markdown": `${SITE}/docs/raw/${c.slug}.md` } },
    openGraph: { type: "article", siteName: "Agate", url, title, description: c.description, images: [image] },
    twitter: { card: "summary_large_image", title, description: c.description, images: [image] },
  };
}

export default async function DocPage({ params }: PageProps<"/docs/[slug]">) {
  const found = getChapter((await params).slug);
  if (!found) notFound();
  const { chapter: c, prev, next } = found;
  return (
    <DocArticle
      slug={c.slug}
      file={c.file}
      html={c.html}
      toc={c.toc}
      source={c.source}
      prev={prev && { slug: prev.slug, title: prev.title }}
      next={next && { slug: next.slug, title: next.title }}
    />
  );
}
