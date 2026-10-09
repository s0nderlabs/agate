import { getChapters } from "@/lib/docs/content";

// Each chapter as markdown at /docs/raw/<slug>.md (the page's "View as Markdown", and for agents): the file as written,
// frontmatter included, with its links made absolute. Written at build; any other name is a 404.
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return getChapters().map((c) => ({ file: `${c.slug}.md` }));
}

export async function GET(_req: Request, ctx: RouteContext<"/docs/raw/[file]">) {
  const { file } = await ctx.params;
  const c = getChapters().find((x) => `${x.slug}.md` === file);
  if (!c) return new Response("Not found", { status: 404 });
  return new Response(c.markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": "inline" } });
}
