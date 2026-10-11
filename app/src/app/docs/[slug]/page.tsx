import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocArticle } from "@/components/docs/DocArticle";
import { getChapter, getChapters } from "@/lib/docs/content";
import { chapterMetadata } from "@/lib/docs/meta";

// one page per chapter, all written at build; any other slug is a 404 (never rendered on a request)
export const dynamicParams = false;

export function generateStaticParams() {
  return getChapters().map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: PageProps<"/docs/[slug]">): Promise<Metadata> {
  const found = getChapter((await params).slug);
  if (!found) return {};
  const c = found.chapter;
  return chapterMetadata({ slug: c.slug, title: c.title, description: c.description, markdown: true });
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
