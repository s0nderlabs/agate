import type { Metadata } from "next";
import { HowChapter } from "@/components/docs/HowChapter";
import { firstChapter } from "@/lib/docs/content";
import { HOW_DESCRIPTION, HOW_SLUG, HOW_TITLE } from "@/lib/docs/explainer";
import { chapterMetadata } from "@/lib/docs/meta";

export const metadata: Metadata = chapterMetadata({ slug: HOW_SLUG, title: HOW_TITLE, description: HOW_DESCRIPTION });

export default function HowAgateWorksPage() {
  const next = firstChapter();
  return <HowChapter next={next && { slug: next.slug, title: next.title }} />;
}
