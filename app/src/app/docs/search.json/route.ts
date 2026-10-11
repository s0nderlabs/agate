import { getChapters } from "@/lib/docs/content";
import { HOW_SOURCE } from "@/lib/docs/explainer";
import { buildSearchIndex } from "@/lib/docs/search";

// The docs search's index: one entry per chapter and one per H2 and H3 section, each text cut near 600 characters.
// Written at build (force-static) and fetched by the browser the first time someone opens the search.
export const dynamic = "force-static";

export function GET() {
  return Response.json(buildSearchIndex([HOW_SOURCE, ...getChapters()]));
}
