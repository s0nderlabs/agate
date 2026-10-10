// The docs' code blocks, written at build time: the pages are prerendered, so the highlighter never ships to the
// browser and never runs on a request. Shiki's synchronous core with its JavaScript regex engine and only the grammars
// the docs use; anything else is plain text. Each token carries a class named after its CSS variable (Shiki's
// CSS-variables theme), and prose.module.css gives those variables their colors on the light and the dark ground.
import { createCssVariablesTheme, createHighlighterCoreSync, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import solidity from "shiki/langs/solidity.mjs";
import typescript from "shiki/langs/typescript.mjs";

type Grammar = "typescript" | "javascript" | "json" | "solidity" | "shellscript";

/** A fence's language as written, mapped to the grammar that colors it (null: plain text) and the name the header shows. */
const LANGS: Record<string, { grammar: Grammar | null; name: string }> = {
  sh: { grammar: "shellscript", name: "Shell" },
  bash: { grammar: "shellscript", name: "Shell" },
  shell: { grammar: "shellscript", name: "Shell" },
  shellscript: { grammar: "shellscript", name: "Shell" },
  zsh: { grammar: "shellscript", name: "Shell" },
  console: { grammar: "shellscript", name: "Shell" },
  ts: { grammar: "typescript", name: "TypeScript" },
  typescript: { grammar: "typescript", name: "TypeScript" },
  mts: { grammar: "typescript", name: "TypeScript" },
  js: { grammar: "javascript", name: "JavaScript" },
  javascript: { grammar: "javascript", name: "JavaScript" },
  mjs: { grammar: "javascript", name: "JavaScript" },
  cjs: { grammar: "javascript", name: "JavaScript" },
  json: { grammar: "json", name: "JSON" },
  solidity: { grammar: "solidity", name: "Solidity" },
  sol: { grammar: "solidity", name: "Solidity" },
  // named but not colored: shown as plain text under their own name
  text: { grammar: null, name: "Text" },
  txt: { grammar: null, name: "Text" },
  plaintext: { grammar: null, name: "Text" },
  diff: { grammar: null, name: "Diff" },
  graphql: { grammar: null, name: "GraphQL" },
  python: { grammar: null, name: "Python" },
  py: { grammar: null, name: "Python" },
  toml: { grammar: null, name: "TOML" },
  yaml: { grammar: null, name: "YAML" },
  yml: { grammar: null, name: "YAML" },
};
const TEXT = { grammar: null, name: "Text" } as const;

/** Shiki's CSS-variables theme, made quieter: "constant" is narrowed to numbers and literals (true, null, format
 *  placeholders), since its default also takes in object and class names and would color most identifiers in
 *  TypeScript; and a shell command's bare arguments and flags stay in the text color (the shell grammar calls them
 *  strings, which would color nearly every line). Quoted strings keep their color everywhere. */
function theme() {
  const t = createCssVariablesTheme({ name: "agate", variablePrefix: "--shiki-", fontStyle: false });
  const constants = ["constant.numeric", "constant.language", "constant.other.placeholder", "constant.character.format.placeholder"];
  t.tokenColors = [
    ...(t.tokenColors ?? []).map((rule) => (rule.settings?.foreground === "var(--shiki-token-constant)" ? { ...rule, scope: constants } : rule)),
    { scope: ["string.unquoted.argument.shell", "string.unquoted.argument"], settings: { foreground: "var(--shiki-foreground)" } },
  ];
  return t;
}

let highlighter: HighlighterCore | null = null;
/** One highlighter for the whole build (dev reuses it across requests). */
function getHighlighter() {
  highlighter ??= createHighlighterCoreSync({
    themes: [theme()],
    langs: [typescript, javascript, json, solidity, shellscript],
    engine: createJavaScriptRegexEngine({
      // a grammar rule the engine cannot express is skipped, never a failed build
      forgiving: true,
      // the ES2018 regex flavor: for every grammar here it gives the same tokens as the newest flavor, and it gives
      // them every time on every JavaScript runtime, where the newest flavor has been seen to color an odd line flat
      target: "ES2018",
    }),
  });
  return highlighter;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Text made safe inside HTML and its attributes (the one escape for the docs' code and prose alike). */
export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}
const esc = escapeHtml;

/** The token's kind from its color, which the theme writes as var(--shiki-token-<kind>) or var(--shiki-foreground). */
function kindOf(t: ThemedToken): string | null {
  const m = /^var\(--shiki-token-([a-z-]+)\)$/.exec(t.color ?? "");
  return m ? m[1] : null;
}

/** One line's tokens as HTML: neighbors of the same kind share a span, spaces join whatever run they sit in. */
function lineHtml(tokens: ThemedToken[]): string {
  let out = "";
  let run = "";
  let kind: string | null = null;
  const flush = () => {
    if (run) out += kind ? `<span class="tk-${kind}">${esc(run)}</span>` : esc(run);
    run = "";
  };
  for (const t of tokens) {
    const k: string | null = /^\s*$/.test(t.content) ? kind : kindOf(t);
    if (k !== kind) {
      flush();
      kind = k;
    }
    run += t.content;
  }
  flush();
  return out;
}

/** Each line of the code as HTML, colored when the grammar is one of the docs' languages (plain if coloring fails:
 *  a block shown without color beats a build that stops). */
export function highlightLines(code: string, grammar: Grammar | null): string[] {
  const lines = code.split("\n");
  if (!grammar) return lines.map(esc);
  try {
    const tokens = getHighlighter().codeToTokensBase(code, { lang: grammar, theme: "agate" });
    return lines.map((_, i) => lineHtml(tokens[i] ?? []));
  } catch {
    return lines.map(esc);
  }
}

/** A fence's info string: the language (first word) and an optional title="file.ts" (or title='…', title=bare). */
export function parseInfo(info: string): { lang: string; title: string | null } {
  const first = /^\S*/.exec(info.trim())?.[0] ?? "";
  const lang = first.includes("=") ? "" : first.toLowerCase();
  const t = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(info);
  const title = t ? (t[1] ?? t[2] ?? t[3] ?? "").trim() : "";
  return { lang, title: title || null };
}

/** A shell transcript: some lines start with "$ ". A line ending in "\" carries its command on to the next line;
 *  every other line without the prompt is output. */
function transcript(lines: string[]) {
  const kinds: ("prompt" | "more" | "out")[] = [];
  let carry = false;
  for (const l of lines) {
    if (/^\$(?: |$)/.test(l)) kinds.push("prompt");
    else if (carry) kinds.push("more");
    else kinds.push("out");
    carry = kinds[kinds.length - 1] !== "out" && /\\$/.test(l);
  }
  return kinds;
}

const CHECK =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path d="M3 8.6 6.3 11.8 13 4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/></svg>';

/**
 * A fenced block as a figure: a header row with the language (or the fence's title) and a Copy button, then the code
 * in its own sideways-scrolling box. In a shell transcript the "$" is drawn but cannot be selected, and Copy takes only
 * the commands (data-copy holds them); otherwise Copy takes the code as shown.
 */
export function codeBlock(text: string, info: string): string {
  const { lang, title } = parseInfo(info);
  const known = LANGS[lang] ?? TEXT;
  const raw = text.split("\n");
  let lines: string[];
  let copy: string | null = null;
  const kinds = known.grammar === "shellscript" ? transcript(raw) : null;
  if (kinds?.includes("prompt")) {
    const commands: string[] = [];
    raw.forEach((l, i) => {
      if (kinds[i] === "prompt") commands.push(l.replace(/^\$ ?/, ""));
      else if (kinds[i] === "more") commands.push(l);
    });
    const colored = highlightLines(commands.join("\n"), "shellscript");
    let c = 0;
    lines = raw.map((l, i) => {
      if (kinds[i] === "out") return `<span class="out">${esc(l)}</span>`;
      const html = colored[c++] ?? "";
      return kinds[i] === "prompt" ? `<span class="prompt" aria-hidden="true">$ </span>${html}` : html;
    });
    copy = commands.join("\n");
  } else {
    lines = highlightLines(text, known.grammar);
  }
  const code = lines.map((l) => `<span class="line">${l}</span>`).join("\n");
  const caption = title ? `<figcaption data-title>${esc(title)}</figcaption>` : `<figcaption>${known.name}</figcaption>`;
  const button =
    `<button type="button" class="copy" ${copy === null ? "data-copy" : `data-copy="${esc(copy)}"`} aria-label="Copy code">` +
    `<span class="copy-idle">Copy</span><span class="copy-done">${CHECK}Copied</span></button>`;
  return `<figure class="code" data-lang="${esc(lang || "text")}">${caption}${button}<pre><code>${code}</code></pre></figure>\n`;
}
