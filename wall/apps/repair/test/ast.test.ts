// Gate 1's syntax half (BUILD-SPEC 15.2, fix round Oct 3, audit H1; recheck r1 H1): the allowlist on the draft's
// syntax tree. Every escape below names no forbidden word in the raw source; each must be refused, and the canned
// good drafts must pass.
import { describe, expect, test } from "bun:test";
import { checkSyntax } from "../src/ast.ts";
import { checkPurity } from "../src/purity.ts";
import { GOOD_V2, NEW_ONLY_V2, SPOT_V2 } from "./canned.ts";

const HEAD = 'import type { Extractor } from "../../types.ts";\nimport { textOf, LayoutError, type Cell } from "../text.ts";\n';
const wrap = (body: string, top = "") => `${HEAD}${top}\nexport const extract: Extractor = (body, ctx) => {\n${body}\n  return {};\n};\n`;

describe("the canned drafts", () => {
  test("the good, spot-cell and new-only drafts pass (gates 2 and 3 judge what they read)", async () => {
    for (const s of [GOOD_V2, SPOT_V2, NEW_ONLY_V2]) expect(await checkSyntax(s)).toEqual({ ok: true });
  }, 60_000);
});

describe("escapes that name no forbidden word are refused", () => {
  const cases: [string, string][] = [
    ["the audit's bypass: a computed constructor key", wrap('  const k = "constr" + "uctor";\n  const F: any = (0 as any)[k][k];\n  void F;')],
    ["a key from a parameter", wrap("  const o: any = {};\n  void o[body];")],
    ["a key copied from a fixed one", wrap('  const a = "x";\n  const b = a;\n  const o: any = {};\n  void o[b];')],
    ["a key made with a template", wrap('  const o: any = {};\n  void o[`constr${"uctor"}`];')],
    ["a key from JSON", wrap('  const o: any = {};\n  void o[JSON.parse("\\"x\\"")];')],
    ["a counter that once takes a string", wrap('  let i: any = 0;\n  i = "x";\n  const o: any = {};\n  void o[i];')],
    ["a counter grown with a string", wrap('  let i: any = 0;\n  i += "x";\n  const o: any = {};\n  void o[i];')],
    ["a counter also bound as a parameter elsewhere", wrap("  let i = 0;\n  const o: any = {};\n  void o[i];", "function f(i: any) { return i; }\nconst z = f(1);\n")],
    ["a catch variable as a key", wrap("  const o: any = {};\n  try { textOf(body); } catch (e) { void o[e as any]; }")],
    ["a computed name in an object literal", wrap('  const o = { ["constr" + "uctor"]: 1 };\n  void o;')],
    ["an escaped constructor property", wrap("  const f: any = () => 0;\n  void f.\\u0063onstructor;")],
    ["an escaped constructor string", wrap('  const f: any = () => 0;\n  void f["\\u0063onstructor"];')],
    ["an escaped global name", wrap("  void glob\\u0061lThis;")],
    ["Object", wrap("  void Object.keys({});")],
    ["Symbol", wrap("  void Symbol.iterator;")],
    ["Date", wrap("  void new Date();")],
    ["an Error subclass by name", wrap("  void new TypeError();")],
    ["a member write to a global", wrap("  (Math as any).floor = () => 1;")],
    ["a member write to an import", wrap("  (textOf as any).x = 1;")],
    ["a write to a global name", wrap("  (NaN as any) = 1;")],
    ["a global object aliased, then rewritten (would change it for the whole process)", wrap('  const m: any = Math;\n  m.max = () => "x";\n  const a = [1];\n  void a[Math.max(0)];')],
    ["a global object passed as a value", wrap("  const f = (o: any) => o;\n  void f(JSON);")],
    ["a global object in an array", wrap("  void [Array];")],
    ["a global's name declared in one scope and used in another (resolves to the global at run time)", wrap("  void Object.keys({});", "function hide() { const Object = 1; return Object; }\n")],
    ["a runtime global's name declared (Date, console)", wrap("  const Date = 1;\n  const console = 2;\n  void (Date + console);")],
    ["the CRE runtime's Javy declared in one scope and used in another", wrap("  void (Javy as any).IO;", "function hide() { const Javy = 1; return Javy; }\n")],
    ["a global object destructured", wrap("  const { floor } = Math;\n  void floor;")],
    ["call, apply and bind", wrap("  const p: any = [].push;\n  void p.call([], 1);")],
    ["prototype", wrap("  void (Array as any).prototype;")],
    ["a __ property", wrap("  const o: any = {};\n  void o.__lookupGetter__;")],
    ["this", wrap("  const f = function (this: any) { return this; };\n  void f;")],
    ["a class", wrap("  class A {}\n  void A;")],
    ["a getter", wrap("  const o = { get x() { return 1; } };\n  void o;")],
    ["a tagged template", wrap("  void String.raw`x`;")],
    ["a generator", wrap("  function* g() { yield 1; }\n  void g;")],
    ["async", wrap("  const f = async () => 1;\n  void f;")],
    ["delete", wrap("  const o: any = { a: 1 };\n  delete o.a;")],
    ["for ... in", wrap("  for (const k in {}) void k;")],
    ["a destructuring assignment", wrap('  let a = 0;\n  [a] = [1];\n  void a;')],
    ["declare", wrap("  void 0;", "declare const Object2: any;\n")],
    ["a global name declared", wrap("  void 0;", "const Math = 1;\n")],
    ["a top-level loop", wrap("  void 0;", "for (;;) { break; }\n")],
    ["a namespace", wrap("  void 0;", "namespace N { export const a = 1; }\n")],
    ["a value import from types", 'import { SOURCES } from "../../types.ts";\nexport const extract = (b: string) => (SOURCES ? {} : {});\n'],
    ["a default import", 'import t from "../text.ts";\nexport const extract = (b: string) => (t ? {} : {});\n'],
    ["new of a non-class import", wrap("  void new (textOf as any)();")],
    ["new of a class imported under another name", 'import { textOf as LayoutError } from "../text.ts";\nexport const extract = (b: string) => { void new (LayoutError as any)(b); return {}; };\n'],
    ["a syntax error", `${HEAD}export const extract = (b: string) => {;\n`],
    // recheck r1 (H1): a banned name as a string-literal key in any destructuring pattern, escaped or not
    ["a string key in a const pattern, escaped (the recheck's draft)", wrap('  const f = (x: number) => x;\n  const { "constr\\u0075ctor": F }: any = f;\n  void F;')],
    ["a string key in a const pattern, plain", wrap('  const f = (x: number) => x;\n  const { "constructor": F }: any = f;\n  void F;')],
    ["a single-quoted string key in a pattern", wrap("  const f = (x: number) => x;\n  const { 'constructor': F }: any = f;\n  void F;")],
    ["a string key in a parameter pattern", wrap('  const h = ({ "constr\\u0075ctor": F }: any) => F;\n  void h(body);')],
    ["a string key in a for ... of pattern", wrap('  for (const { "constr\\u0075ctor": F } of [body as any]) void F;')],
    ["a string key in a catch pattern", wrap('  try { textOf(body); } catch ({ "constr\\u0075ctor": F }) { void F; }')],
    ["a string key in a nested pattern", wrap('  const { a: { "constr\\u0075ctor": F } }: any = { a: body };\n  void F;')],
    ["a string key in an object pattern inside an array pattern", wrap('  const [{ "constr\\u0075ctor": F }]: any = [body];\n  void F;')],
    ["an escaped __ key in a pattern", wrap('  const { "\\u005f_proto__": P }: any = body;\n  void P;')],
    ["a forbidden word behind an escape in a string key", wrap('  const o: any = {};\n  void o["B\\u0075n"];')],
    ["a forbidden word behind an escape in a template", wrap("  void `gl\\u006fbalThis`;")],
    ["a reserved name behind an escape in a string", wrap('  const s = "m\\u006fdule";\n  void s;')],
    ["a forbidden word behind an escape in a type", wrap("  void 0;", 'type T = "B\\u0075n";\n')],
    ["import attributes (a bun macro would run at transpile time)", 'import { textOf } from "../text.ts" with { type: "macro" };\nexport const extract = (b: string) => (textOf(b) ? {} : {});\n'],
    ["an import under a quoted name", 'import { "textOf" as t } from "../text.ts";\nexport const extract = (b: string) => (t(b) ? {} : {});\n'],
    ["a static member of RegExp (the last match of the whole process)", wrap("  void RegExp.input;")],
    ["RegExp.$1", wrap("  void RegExp.$1;")],
  ];
  // the recheck r1 cases are refused for the reason they test, not by accident
  const why: Record<string, string> = {
    "a string key in a const pattern, escaped (the recheck's draft)": 'reads the property "constructor"',
    "a string key in a const pattern, plain": 'reads the property "constructor"',
    "a single-quoted string key in a pattern": 'reads the property "constructor"',
    "a string key in a parameter pattern": 'reads the property "constructor"',
    "a string key in a for ... of pattern": 'reads the property "constructor"',
    "a string key in a catch pattern": 'reads the property "constructor"',
    "a string key in a nested pattern": 'reads the property "constructor"',
    "a string key in an object pattern inside an array pattern": 'reads the property "constructor"',
    "an escaped __ key in a pattern": 'reads the property "__proto__"',
    "a forbidden word behind an escape in a string key": 'holds the forbidden word "Bun"',
    "a forbidden word behind an escape in a template": 'holds the forbidden word "globalThis"',
    "a reserved name behind an escape in a string": 'holds the forbidden word "module"',
    "a forbidden word behind an escape in a type": 'holds the forbidden word "Bun"',
    "import attributes (a bun macro would run at transpile time)": "import attributes",
    "an import under a quoted name": "an import under a quoted name",
    "a static member of RegExp (the last match of the whole process)": "a static member of RegExp",
    "RegExp.$1": "a static member of RegExp",
  };
  for (const [name, src] of cases) {
    test(name, async () => {
      const r = await checkSyntax(src);
      expect(r.ok).toBe(false);
      if (why[name]) expect(r).toMatchObject({ why: expect.stringContaining(why[name]) });
    }, 30_000);
  }
  test("every recheck r1 case is in the list", () => {
    for (const k of Object.keys(why)) expect(cases.some(([n]) => n === k)).toBe(true);
  });
  test("a control character in a refused key reaches the reason only as a visible escape", async () => {
    const r = await checkSyntax(wrap('  const { "__\\u001b[8m": P }: any = body;\n  void P;'));
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining('"__\\u001b[8m"') });
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(r.ok ? "" : r.why)).toBe(false);
  }, 30_000);
  test("the audit's bypass passes the word list but not the syntax check", async () => {
    const src = cases[0]![1];
    expect(checkPurity(src)).toEqual({ ok: true });
    expect(await checkSyntax(src)).toMatchObject({ ok: false, why: expect.stringContaining("line 6: an index") });
  }, 30_000);
});

describe("what an extractor needs is allowed", () => {
  const ok: [string, string][] = [
    ["numeric literals, counters and arithmetic as keys", wrap("  const a = [1, 2, 3];\n  let s = 0;\n  for (let i = 0; i < a.length; i++) s += a[i]! + a[a.length - 1]! + a[i | 0]! + a[+body.length]!;\n  void s;")],
    ["a counter fed by another counter", wrap("  const a = [1, 2];\n  let i = 0;\n  let j = i + 1;\n  j *= 2;\n  void a[j];")],
    ["Math, Number and parseInt results as keys", wrap('  const a = [1, 2];\n  void a[Math.min(1, 0)];\n  void a[Number.parseInt("1", 10)];\n  void a[parseInt("0", 10)];')],
    ["fixed keys from a for ... of over string literals", wrap('  const out: Partial<Record<"H100" | "B200", Cell>> = {};\n  for (const g of ["H100", "B200"] as const) out[g] = { kind: "missing", why: g };\n  void out;')],
    ["a const string key and a choice between two", wrap('  const o: Record<string, number> = { "gpu-type": 1 };\n  const k = "gpu-type";\n  const c = body ? "a" : "b";\n  void o[k];\n  void o[c];\n  void o["gpu-type"];')],
    ["helpers, regexes, maps, sets, JSON and strings", wrap('  const m = new Map<string, string[]>();\n  const s = new Set<string>();\n  const r = new RegExp("x", "g");\n  const t = textOf(body).replace(/\\s+/g, " ");\n  m.set(t, [t]);\n  s.add(String(JSON.stringify({ a: 1 })));\n  if (!r.test(t)) throw new LayoutError("no x");')],
    ["writes to own objects and parameters of its own helpers", wrap("  const o: { a: number[] } = { a: [] };\n  o.a.push(1);\n  o.a[0] = 2;\n  fill(o);", "function fill(x: { a: number[] }) { x.a[0] = 1; }\n")],
    ["type annotations, casts and non-null assertions", wrap('  const a = [body] as string[];\n  const b = a[0]!;\n  void (b satisfies string);')],
    ["string and number keys in a pattern that name no banned property", wrap('  const row = JSON.parse(body) as { "gpu-type": string; 0: number };\n  const { "gpu-type": t, 0: z } = row;\n  void t;\n  void z;')],
    ["new RegExp and RegExp(...) calls", wrap('  const r = new RegExp("x");\n  const q = RegExp("y");\n  void r;\n  void q;')],
    ["ordinary escapes in strings", wrap('  const s = "a\\tb\\n\\u0041 \\"quoted\\"";\n  void s;')],
  ];
  for (const [name, src] of ok) {
    test(name, async () => {
      expect(await checkSyntax(src)).toEqual({ ok: true });
    }, 30_000);
  }
});
