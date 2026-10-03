// Gate 1, the static half (BUILD-SPEC 15.2): what a drafted extractor may contain. The typecheck half runs tsc in
// the scratch copy (scratch.ts). The words are checked on the whole source, comments and strings included: the
// system prompt forbids them anywhere, so this is the same rule, never weaker than "comments removed".

export const MAX_EXTRACTOR_CHARS = 40_000;

/** Whole-word tokens a draft may never contain (15.2 gate 1). `import(` is matched as the keyword followed by "(". */
export const FORBIDDEN_WORDS = [
  "fetch",
  "Bun",
  "process",
  "require",
  "eval",
  "Function",
  "globalThis",
  "window",
  "self",
  "import(",
  "XMLHttpRequest",
  "WebSocket",
  "setTimeout",
  "setInterval",
  "queueMicrotask",
  "Deno",
  "__proto__",
  "Reflect",
  "Proxy",
  "Atomics",
  "SharedArrayBuffer",
  "WebAssembly",
] as const;

/** The only imports a draft may have, by module, and whether a value import is allowed. */
export const ALLOWED_IMPORTS: Readonly<Record<string, "value-or-type" | "type-only">> = {
  "../text.ts": "value-or-type",
  "../../types.ts": "type-only",
  "@agate/report/types": "type-only",
};

export type PurityResult = { ok: true } | { ok: false; why: string };

const ID = "[A-Za-z0-9_$]";

function wordRe(w: string): RegExp {
  if (w === "import(") return /(?<![A-Za-z0-9_$])import\s*\(/;
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!${ID})${esc}(?!${ID})`);
}
const WORD_RES = FORBIDDEN_WORDS.map((w) => [w, wordRe(w)] as const);
/** Names a draft may not write outside its import lines (checked on the source after the imports are removed). */
export const RESERVED_NAMES = ["module", "exports", "arguments", "constructor"] as const;
const RESERVED_RE = new RegExp(`(?<!${ID})(${RESERVED_NAMES.join("|")})(?!${ID})`);

/** The first forbidden word in a text, else null. */
export function forbiddenWordIn(text: string): string | null {
  for (const [w, re] of WORD_RES) if (re.test(text)) return w;
  return null;
}

/** The first forbidden word or reserved name in a text, else null. The syntax check (ast.ts) runs it on the cooked
 *  text of every name and string in the tree, so an escape ("B\u0075n", "constr\u0075ctor") cannot hide a word. */
export function bannedWordIn(text: string): string | null {
  return forbiddenWordIn(text) ?? RESERVED_RE.exec(text)?.[1] ?? null;
}

/** Static checks of gate 1: size, imports, exactly one `extract` export, no forbidden word anywhere. */
export function checkPurity(src: unknown): PurityResult {
  if (typeof src !== "string" || src.trim() === "") return { ok: false, why: "the extractor source is empty" };
  if (src.length > MAX_EXTRACTOR_CHARS) return { ok: false, why: `the extractor source is ${src.length} characters (at most ${MAX_EXTRACTOR_CHARS})` };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(src)) return { ok: false, why: "the source holds control or bidirectional characters" };
  const w = forbiddenWordIn(src);
  if (w !== null) return { ok: false, why: `the source contains the forbidden word ${JSON.stringify(w)}` };
  // imports: each must be exactly `import { ... } from "<allowed>";` or `import type { ... } from "<allowed>";`
  const importRe = /(^|\n)[ \t]*import[ \t]+(type[ \t]+)?\{([^{}]*)\}[ \t]*from[ \t]*"([^"\n]*)"[ \t]*;?/g;
  let rest = src;
  for (const m of src.matchAll(importRe)) {
    const mod = m[4]!;
    const typeOnly = Boolean(m[2]);
    const rule = ALLOWED_IMPORTS[mod];
    if (!rule) return { ok: false, why: `import from ${JSON.stringify(mod)} is not allowed (only ${Object.keys(ALLOWED_IMPORTS).join(", ")})` };
    if (rule === "type-only" && !typeOnly) return { ok: false, why: `${mod} may only be imported with "import type"` };
    if (/[^A-Za-z0-9_$,\s]|\bas\b\s*$/.test(m[3]!.replace(/\b(type|as)\b/g, " "))) return { ok: false, why: `odd import list from ${mod}` };
    rest = rest.replace(m[0], m[1]!);
  }
  if (/(?<![A-Za-z0-9_$])import(?![A-Za-z0-9_$])/.test(rest)) return { ok: false, why: "an import other than the allowed named imports" };
  if (/(?<![A-Za-z0-9_$])(from)\s*["'`]/.test(rest)) return { ok: false, why: "a re-export or import from another module" };
  if (RESERVED_RE.test(rest)) return { ok: false, why: "the source names module, exports, arguments or constructor" };
  const exports = [...rest.matchAll(/(?<![A-Za-z0-9_$])export(?![A-Za-z0-9_$])/g)].length;
  if (exports !== 1 || !/(?<![A-Za-z0-9_$])export\s+(const|function)\s+extract(?![A-Za-z0-9_$])/.test(rest)) return { ok: false, why: "the source must export exactly one `extract` (export const extract or export function extract) and nothing else" };
  return { ok: true };
}
