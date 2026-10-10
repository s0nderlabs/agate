// The docs' shared shapes: what the build reads from docs/site (one markdown file per chapter) and what the pages,
// the sidebar and the search receive. Plain data only, so client components can import it.

/** The five groups, in reading order; a chapter's frontmatter `group` must be one of them. */
export const GROUPS = ["Get started", "Concepts", "Reference", "Operate", "Background"] as const;
export type Group = (typeof GROUPS)[number];

/** The app's public address: llms.txt, llms-full.txt and the raw markdown link to it. */
export const SITE = "https://agate.elpabl0.xyz";
/** Links that leave docs/site (../judge.md, ../JUDGES.md) open the file on GitHub. */
export const GITHUB = "https://github.com/s0nderlabs/agate";
/** The branch the GitHub links read and edit ("Edit this page", the code a chapter describes). */
export const GITHUB_BRANCH = "main";
/** Where the chapters' markdown sits in the repo, for "Edit this page on GitHub". */
export const DOCS_PATH = "docs/site";

export interface ChapterMeta {
  slug: string;
  /** the short name: the sidebar, prev and next, and the browser tab */
  title: string;
  description: string;
  group: Group;
  order: number;
  /** the code the page describes (frontmatter `source`), one path each */
  source: string[];
}

/** An H2 or H3 of a chapter, with the id its anchor uses (GitHub's, so existing #links still land). */
export interface Heading {
  id: string;
  text: string;
  depth: 2 | 3;
}

/** A stretch of a chapter's text under one heading (the first one sits under the H1 and has no id). */
export interface Section {
  id: string | null;
  heading: string;
  text: string;
}

export interface NavChapter {
  slug: string;
  title: string;
  description: string;
  /** the chapter's H2s, for the sidebar's fold below the current chapter */
  sections: { id: string; text: string }[];
}

export interface NavGroup {
  group: Group;
  chapters: NavChapter[];
}

