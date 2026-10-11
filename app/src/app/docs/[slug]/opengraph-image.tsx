import { getChapter, getChapters } from "@/lib/docs/content";
import { DOCS_LINE, SHARE_SIZE, shareCard } from "@/lib/docs/shareCard";

// Each chapter's share image: the docs' card (lib/docs/shareCard.tsx) with the chapter's name and line. Written at
// build for every chapter (static params, force-static), so a share never renders anything on a request.

export const alt = "A chapter of the Agate docs: its name and what it covers, with the Agate lockup";
export const size = SHARE_SIZE;
export const contentType = "image/png";
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return getChapters().map((c) => ({ slug: c.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const c = getChapter((await params).slug)?.chapter;
  return shareCard(c?.title ?? "Agate docs", c?.description ?? DOCS_LINE);
}
