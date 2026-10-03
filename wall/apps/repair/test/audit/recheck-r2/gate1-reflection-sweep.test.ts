// Recheck r2 (phase 2b, cold): a fresh adversarial sweep of gate 1's syntax allowlist (BUILD-SPEC 15.2). The round-1
// HIGH was a banned name as a string-literal destructuring key reaching Function then Bun. This re-probes every known
// path to a global object or to reflection (constructor / prototype / __proto__ / call / apply / bind, and the
// globals Function, Bun, process, globalThis, Reflect, Symbol, Object, Date, RegExp statics), through every destructuring
// position, computed and element keys, template substitutions, optional chaining, spreads, aliasing and escapes. None
// may pass checkSyntax; the canned good drafts must still pass. No source is edited and no draft is run: a refusal by
// checkSyntax means the draft never reaches the sandbox.
import { describe, expect, test } from "bun:test";
import { checkSyntax } from "../../../src/ast.ts";
import { GOOD_V2, NEW_ONLY_V2, SPOT_V2 } from "../../canned.ts";

const HEAD = 'import type { Extractor } from "../../types.ts";\nimport { textOf, LayoutError, type Cell } from "../text.ts";\n';
const wrap = (body: string, top = "") => `${HEAD}${top}\nexport const extract: Extractor = (body, ctx) => {\n${body}\n  return {};\n};\n`;

/** Each case must be refused by checkSyntax (ok === false). The label says the vector it probes. */
const REFUSED: [string, string][] = [
  // --- reflection via property names, every surface
  ["dot constructor", wrap("  const f: any = () => 0;\n  void f.constructor;")],
  ["dot prototype", wrap("  void (Array as any).prototype;")],
  ["dot __proto__", wrap("  const o: any = {};\n  void o.__proto__;")],
  ["dot call", wrap("  const p: any = [].push;\n  void p.call;")],
  ["optional-chain constructor", wrap("  const f: any = () => 0;\n  void f?.constructor;")],
  ["element access \"constructor\"", wrap('  const f: any = () => 0;\n  void f["constructor"];')],
  ["element access escaped constructor", wrap('  const f: any = () => 0;\n  void f["constr\\u0075ctor"];')],
  ["optional element \"bind\"", wrap('  const f: any = () => 0;\n  void f?.["bind"];')],
  ["template substitution .constructor", wrap("  const f: any = () => 0;\n  void `${f.constructor}`;")],
  // --- destructuring pattern keys in every position (round-1 class)
  ["const pattern constructor", wrap('  const { "constructor": F }: any = (() => 0);\n  void F;')],
  ["const pattern escaped", wrap('  const { "constr\\u0075ctor": F }: any = (() => 0);\n  void F;')],
  ["param pattern __proto__", wrap('  const g = ({ "__proto__": p }: any) => p;\n  void g;')],
  ["for-of pattern bind", wrap('  for (const { "bind": b } of [] as any[]) void b;')],
  ["catch pattern constructor", wrap('  try { textOf(body); } catch ({ "constructor": c }: any) { void c; }')],
  ["nested pattern prototype", wrap('  const { a: { "prototype": p } }: any = { a: {} };\n  void p;')],
  ["array-in-object pattern call", wrap('  const { a: [{ "call": c }] }: any = { a: [{}] };\n  void c;')],
  ["shorthand escaped constructor", wrap('  const { constr\\u0075ctor }: any = {};\n  void constr\\u0075ctor;')],
  ["computed pattern key (fixed banned)", wrap('  const k = "constructor";\n  const { [k]: F }: any = (() => 0);\n  void F;')],
  // --- globals as a value (alias) or by name
  ["Function by name", wrap("  const f: any = Function;\n  void f;")],
  ["Function escaped", wrap("  void Functi\\u006fn;")],
  ["globalThis", wrap("  void globalThis;")],
  ["globalThis escaped", wrap("  void globalTh\\u0069s;")],
  ["Bun", wrap("  void (Bun as any).version;")],
  ["Bun escaped string", wrap('  const s = "B\\u0075n";\n  void s;')],
  ["process", wrap("  void (process as any).env;")],
  ["Reflect", wrap("  void Reflect;")],
  ["Symbol", wrap("  void Symbol.iterator;")],
  ["Object", wrap("  void Object.keys({});")],
  ["Date", wrap("  void new Date();")],
  ["Math aliased then member write", wrap('  const m: any = Math;\n  m.max = () => "x";\n  void m;')],
  ["Math passed as a value", wrap("  const f = (o: any) => o;\n  void f(Math);")],
  ["Math destructured", wrap("  const { floor } = Math;\n  void floor;")],
  ["global declared in one scope, used in another", wrap("  void Object.keys({});", "function hide() { const Object = 1; return Object; }\n")],
  // --- RegExp statics (Bun keeps the legacy last-match statics)
  ["RegExp.input", wrap("  void (RegExp as any).input;")],
  ["RegExp.$1", wrap("  void (RegExp as any).$1;")],
  ["RegExp.lastMatch", wrap("  void (RegExp as any).lastMatch;")],
  // --- import attributes and quoted import names
  ["import attributes (macro)", wrap("", 'import type { Cell as C2 } from "../text.ts" with { type: "macro" };\n')],
  ["quoted import name", wrap("", 'import { "textOf" as t } from "../text.ts";\n')],
  ["default import", wrap("", 'import def from "../text.ts";\n')],
  ["namespace import", wrap("", 'import * as ns from "../text.ts";\n')],
  ["value import from another module", wrap("", 'import { x } from "../../other.ts";\n')],
  // --- other escape surfaces
  ["dynamic import", wrap('  void import("../text.ts");')],
  ["tagged template String.raw", wrap("  void String.raw`x`;")],
  ["eval by name", wrap("  const e: any = eval;\n  void e;")],
  ["this in a function", wrap("  const f = function (this: any) { return this; };\n  void f;")],
  ["computed object-literal key banned", wrap('  const o: any = { ["constr\\u0075ctor"]: 1 };\n  void o;')],
  ["property-assignment banned name", wrap('  const o: any = { "constructor": 1 };\n  void o;')],
  ["new of a non-allowlisted class", wrap("  void new TypeError();")],
  ["for ... in", wrap("  const o: any = {};\n  for (const k in o) void k;")],
  ["with statement", wrap("  const o: any = {};\n  with (o) { void 0; }")],
  ["delete", wrap("  const o: any = { a: 1 };\n  delete o.a;")],
];

/** Each must PASS (ok === true): a plain global used in place, allowed news, and the canned good drafts. */
const ALLOWED: [string, string][] = [
  ["Math.floor in place", wrap("  void Math.floor(1.5);")],
  ["JSON.parse in place", wrap('  void JSON.parse("1");')],
  ["Array.from in place", wrap("  void Array.from([1], (x) => x);")],
  ["new RegExp", wrap('  void new RegExp("a");')],
  ["RegExp(...) call", wrap('  void RegExp("a");')],
  ["new Map / Set / Array", wrap("  void new Map();\n  void new Set();\n  void new Array(1);")],
  ["new LayoutError (helper class)", wrap('  throw new LayoutError("moved");')],
  ["element access with a numeric expression key", wrap("  const o: any = [1, 2];\n  const n = 1;\n  void o[n - 1];")],
  ["element access with a fixed string key", wrap('  const k = "price";\n  const o: any = {};\n  void o[k];')],
];

describe("recheck r2: gate 1 refuses every path to a global or reflection", () => {
  test("the refusal battery is refused (none reaches the sandbox)", async () => {
    const leaked: string[] = [];
    for (const [name, src] of REFUSED) {
      const r = await checkSyntax(src);
      if (r.ok) leaked.push(name);
    }
    expect(leaked).toEqual([]);
  }, 120_000);

  test("plain in-place globals, allowed news and safe keys still pass", async () => {
    const wrong: string[] = [];
    for (const [name, src] of ALLOWED) {
      const r = await checkSyntax(src);
      if (!r.ok) wrong.push(`${name}: ${r.why}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  test("the canned good, spot and new-only drafts pass unchanged", async () => {
    for (const s of [GOOD_V2, SPOT_V2, NEW_ONLY_V2]) expect(await checkSyntax(s)).toEqual({ ok: true });
  }, 60_000);
});
