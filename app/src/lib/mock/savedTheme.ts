// The theme someone picked is kept in a cookie (the store writes it on every change), so a reload or a new visit
// renders in it from the server: no flash of the other theme. A theme in the link still wins.
import { cookies } from "next/headers";
import { parseConfig, THEME_COOKIE } from "./config";

type Query = Record<string, string | string[] | undefined>;

/** A page's first state: its link's, with the saved theme when the link names none. */
export async function pageConfig(sp: Query | Promise<Query>) {
  return parseConfig(await withSavedTheme(sp));
}

export async function withSavedTheme(sp: Query | Promise<Query>): Promise<Query> {
  const q = await sp;
  if (q.theme !== undefined) return q;
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  return saved === "dark" || saved === "light" ? { ...q, theme: saved } : q;
}
