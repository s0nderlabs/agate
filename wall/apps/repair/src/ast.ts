// Gate 1, the syntax half (BUILD-SPEC 15.2, fix round Oct 3): an allowlist on the draft's syntax tree, so the draft
// can reach only its arguments, its own values, the allowed helpers and a short list of plain globals. The word list
// (purity.ts) alone did not: `(0 as any)["constr" + "uctor"]` named no forbidden word and reached the global object.
// Every rule is syntactic and holds at run time whatever the types say (types can be bent by any, casts and array
// covariance), so a page that steers the model cannot write its way past it. The tree comes from the TypeScript 7 API
// (`typescript/unstable/async`, which starts the same bundled compiler `tsc` runs); the draft is parsed, never run.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API } from "typescript/unstable/async";
import { SyntaxKind as K } from "typescript/unstable/ast";
import { bannedWordIn } from "./purity.ts";

/** The only globals a draft may name. */
export const LIB_GLOBALS = ["Math", "Number", "String", "parseInt", "parseFloat", "RegExp", "JSON", "Array", "Map", "Set", "isNaN", "isFinite", "Boolean", "undefined", "NaN", "Infinity"] as const;
/** Globals a draft may construct with `new` (and classes imported from ../text.ts). */
export const NEW_GLOBALS = ["Map", "Set", "RegExp", "Array"] as const;
/** Classes of ../text.ts a draft may construct (imported under their own name). */
export const HELPER_CLASSES: readonly string[] = ["LayoutError"];
/** Property names a draft may never write, read or define (reflection and function plumbing), plus any name
 *  starting with "__". */
export const BANNED_PROPS = ["constructor", "prototype", "__proto__", "caller", "callee", "arguments", "call", "apply", "bind"] as const;

export type AstResult = { ok: true } | { ok: false; why: string };

type N = {
  kind: number;
  pos: number;
  end: number;
  parent: N;
  text?: string;
  forEachChild(cb: (n: N) => unknown): unknown;
  [k: string]: unknown;
};

const LIB = new Set<string>(LIB_GLOBALS);
const PRIMITIVE_GLOBALS = new Set<string>(["undefined", "NaN", "Infinity"]);
/** Globals of the other runtimes a draft runs in (the CRE workflow's QuickJS under Javy) or that Bun lacks. */
const OTHER_RUNTIME_GLOBALS = new Set<string>(["Javy", "print", "std", "os", "scriptArgs", "global", "module", "exports", "require", "window", "self", "document", "Deno"]);
const NEWABLE = new Set<string>(NEW_GLOBALS);
const BANNED = new Set<string>(BANNED_PROPS);
const VALUE_IMPORT = "../text.ts";

const bannedName = (s: string) => BANNED.has(s) || s.startsWith("__");
/** A name or a string's cooked text for a refusal message: quoted, printable ASCII only. */
const show = (s: string) => JSON.stringify(s.slice(0, 60)).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** Nodes whose cooked text the word check reads (recheck r1, H1): names, strings and template parts. */
const TEXT_KINDS = new Set<number>([K.Identifier, K.PrivateIdentifier, K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead, K.TemplateMiddle, K.TemplateTail, K.JsxText]);
const isNum = (n: N) => n.kind === K.NumericLiteral || n.kind === K.BigIntLiteral;
const isStr = (n: N) => n.kind === K.StringLiteral || n.kind === K.NoSubstitutionTemplateLiteral;
const safeStr = (n: N) => isStr(n) && !bannedName(String(n.text));
/** The run-time expression under parentheses and type-only wrappers (as, satisfies, <T>, !): they change no value. */
const unparen = (n: N): N => {
  let x = n;
  while (x.kind === K.ParenthesizedExpression || x.kind === K.AsExpression || x.kind === K.SatisfiesExpression || x.kind === K.TypeAssertionExpression || x.kind === K.NonNullExpression) x = x.expression as N;
  return x;
};
const clauseTypeOnly = (c: N) => c.phaseModifier === K.TypeKeyword;
const isType = (n: N) => (n.kind >= K.FirstTypeNode && n.kind <= K.LastTypeNode) || n.kind === K.InterfaceDeclaration || n.kind === K.TypeAliasDeclaration || n.kind === K.TypeParameter;
const NUM_BIN = new Set<number>([K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken, K.AsteriskAsteriskToken, K.BarToken, K.AmpersandToken, K.CaretToken, K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.GreaterThanGreaterThanGreaterThanToken]);
const NUM_COMPOUND = new Set<number>([K.MinusEqualsToken, K.AsteriskEqualsToken, K.SlashEqualsToken, K.PercentEqualsToken, K.AsteriskAsteriskEqualsToken, K.BarEqualsToken, K.AmpersandEqualsToken, K.CaretEqualsToken, K.LessThanLessThanEqualsToken, K.GreaterThanGreaterThanEqualsToken, K.GreaterThanGreaterThanGreaterThanEqualsToken]);
const isAssignOp = (k: number) => k >= K.FirstAssignment && k <= K.LastAssignment;
const DENIED: Record<number, string> = {
  [K.ClassDeclaration]: "a class",
  [K.ClassExpression]: "a class",
  [K.ThisKeyword]: "this",
  [K.SuperKeyword]: "super",
  [K.MetaProperty]: "import.meta or new.target",
  [K.TaggedTemplateExpression]: "a tagged template",
  [K.WithStatement]: "with",
  [K.DebuggerStatement]: "debugger",
  [K.Decorator]: "a decorator",
  [K.DeleteExpression]: "delete",
  [K.YieldExpression]: "a generator",
  [K.AwaitExpression]: "await",
  [K.GetAccessor]: "a getter",
  [K.SetAccessor]: "a setter",
  [K.ForInStatement]: "for ... in",
  [K.EnumDeclaration]: "an enum",
  [K.ModuleDeclaration]: "a namespace or module block",
  [K.ImportEqualsDeclaration]: "import =",
  [K.ExportAssignment]: "export =",
  [K.ExportDeclaration]: "a re-export",
  [K.PrivateIdentifier]: "a private name",
  [K.JsxElement]: "JSX",
  [K.JsxSelfClosingElement]: "JSX",
  [K.JsxFragment]: "JSX",
};

function lineOf(src: string, pos: number): number {
  let n = 1;
  for (let i = 0; i < pos && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

function kids(n: N): N[] {
  const out: N[] = [];
  n.forEachChild((c) => {
    out.push(c);
  });
  return out;
}

/** Every binding a name gets anywhere in the file, with how it is bound. */
interface Binding {
  how: "var" | "param" | "function" | "import" | "catch" | "forof" | "pattern";
  decl: N; // the VariableDeclaration, Parameter, ...
  isConst: boolean;
}

class Checker {
  private readonly bindings = new Map<string, Binding[]>();
  private readonly assigns = new Map<string, N[]>(); // the assignment or update expressions whose target is the name
  private numeric = new Set<string>();
  private fixed = new Set<string>();
  private fail: string | null = null;

  constructor(
    readonly sf: N,
    readonly src: string,
  ) {}

  private refuse(n: N, why: string): void {
    if (!this.fail) this.fail = `line ${lineOf(this.src, n.pos + (this.src.slice(n.pos, n.end).length - this.src.slice(n.pos, n.end).trimStart().length))}: ${why}`;
  }

  run(): AstResult {
    this.collect(this.sf);
    if (this.fail) return { ok: false, why: this.fail };
    this.solve();
    this.topLevel();
    this.visit(this.sf);
    if (!this.fail) this.words(this.sf);
    return this.fail ? { ok: false, why: this.fail } : { ok: true };
  }

  /** The word list on the cooked text of every name, string and template part, types included (recheck r1, H1):
   *  purity.ts reads the raw source, where an escape ("B\u0075n") hides the word. */
  private words(n: N): void {
    if (this.fail) return;
    if (TEXT_KINDS.has(n.kind) && typeof n.text === "string") {
      const w = bannedWordIn(n.text);
      if (w !== null) return this.refuse(n, `the name or string ${show(n.text)} holds the forbidden word ${show(w)} (escapes are read as what they stand for)`);
    }
    for (const c of kids(n)) this.words(c);
  }

  // ------------------------------------------------------------- bindings and assignments

  private bind(name: N, how: Binding["how"], decl: N, isConst = false): void {
    if (name.kind === K.Identifier) {
      const s = String(name.text);
      // no declaration takes a global's name (LIB or any name the runtime has: Object, Date, Symbol, console, ...):
      // the check is by name over the whole file, so a name declared in one scope and used outside it would otherwise
      // pass as "declared" and resolve to the global at run time
      if (LIB.has(s) || OTHER_RUNTIME_GLOBALS.has(s) || s in globalThis) this.refuse(name, `declares ${s}, a global name`);
      if (bannedName(s)) this.refuse(name, `declares ${s}`);
      const b = this.bindings.get(s) ?? [];
      b.push({ how, decl, isConst });
      this.bindings.set(s, b);
      return;
    }
    // a destructuring pattern: every name in it is a pattern binding. Its keys are property reads, so each obeys
    // rule (c) by its cooked text, whatever its form (recheck r1, H1: `const { "constr\u0075ctor": F } = f` passed)
    for (const el of kids(name)) {
      if (el.kind !== K.BindingElement) continue;
      const key = el.propertyName as N | undefined;
      if (key) {
        if (key.kind === K.ComputedPropertyName) this.refuse(el, "a computed name in a destructuring pattern");
        else if (key.kind !== K.Identifier && key.kind !== K.StringLiteral && key.kind !== K.NumericLiteral) this.refuse(el, "a destructuring key that is not a name, a string or a number");
        else if (bannedName(String(key.text))) this.refuse(el, `reads the property ${show(String(key.text))}`);
      } else if (name.kind === K.ObjectBindingPattern && (el.name as N).kind === K.Identifier && bannedName(String((el.name as N).text))) this.refuse(el, `reads the property ${show(String((el.name as N).text))}`);
      this.bind(el.name as N, "pattern", el);
    }
  }

  private collect(n: N): void {
    if (isType(n)) return;
    switch (n.kind) {
      case K.VariableDeclaration: {
        const list = n.parent;
        const flags = list.kind === K.VariableDeclarationList ? (list.flags as number) : 0;
        if ((flags & 4) !== 0) this.refuse(n, "using is not allowed"); // NodeFlags.Using, AwaitUsing
        const isConst = (flags & 7) === 2; // NodeFlags.Const
        const inCatch = list.kind === K.CatchClause;
        const forOf = list.kind === K.VariableDeclarationList && list.parent.kind === K.ForOfStatement;
        this.bind(n.name as N, inCatch ? "catch" : forOf ? "forof" : (n.name as N).kind === K.Identifier ? "var" : "pattern", n, isConst);
        break;
      }
      case K.Parameter:
        this.bind(n.name as N, "param", n);
        break;
      case K.FunctionDeclaration:
      case K.FunctionExpression:
        if (n.name) this.bind(n.name as N, "function", n);
        break;
      case K.ImportSpecifier:
      case K.ImportClause:
      case K.NamespaceImport:
        // value bindings only: a type-only import is erased (its name is no value at run time)
        if (n.name && !this.typeOnlyImport(n)) this.bind(n.name as N, "import", n);
        break;
      case K.BinaryExpression:
        if (isAssignOp((n.operatorToken as N).kind)) this.target(n.left as N, n);
        break;
      case K.PrefixUnaryExpression:
      case K.PostfixUnaryExpression:
        if (n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken) this.target(n.operand as N, n);
        break;
      case K.ForOfStatement:
        if ((n.initializer as N).kind !== K.VariableDeclarationList) this.refuse(n, "for ... of without a declaration");
        break;
    }
    for (const c of kids(n)) this.collect(c);
  }

  private typeOnlyImport(n: N): boolean {
    for (let x: N | undefined = n; x && x.kind !== K.ImportDeclaration; x = x.parent) {
      if (x.kind === K.ImportSpecifier && (x.isTypeOnly as boolean)) return true;
      if (x.kind === K.ImportClause && clauseTypeOnly(x)) return true;
    }
    return false;
  }

  /** The target of an assignment: an identifier, or a member chain rooted at a name the file declares (never a global,
   *  an import or an argument of the exported function's caller, which the parse layer freezes anyway). */
  private target(t0: N, expr: N): void {
    const t = unparen(t0);
    if (t.kind === K.Identifier) {
      const s = String(t.text);
      const a = this.assigns.get(s) ?? [];
      a.push(expr);
      this.assigns.set(s, a);
      return;
    }
    if (t.kind === K.ArrayLiteralExpression || t.kind === K.ObjectLiteralExpression) {
      this.refuse(t, "a destructuring assignment (declare new names instead)");
      return;
    }
    let root = t;
    while (root.kind === K.PropertyAccessExpression || root.kind === K.ElementAccessExpression || root.kind === K.ParenthesizedExpression || root.kind === K.NonNullExpression || root.kind === K.AsExpression || root.kind === K.SatisfiesExpression || root.kind === K.TypeAssertionExpression) root = root.expression as N;
    if (root.kind !== K.Identifier) {
      this.refuse(t, "an assignment to a member of something that is not a declared name");
      return;
    }
    this.rootChecks.push(root);
  }
  private readonly rootChecks: N[] = [];

  // ------------------------------------------------------------- which names are numeric or fixed keys

  /** Greatest fixpoint: a name stays numeric while every binding and assignment of it gives a number. */
  private solve(): void {
    const names = [...this.bindings.keys()];
    this.numeric = new Set(names.filter((s) => this.bindings.get(s)!.every((b) => b.how === "var" && (b.decl.initializer as N | undefined) !== undefined)));
    for (let changed = true; changed; ) {
      changed = false;
      for (const s of [...this.numeric]) {
        const ok = this.bindings.get(s)!.every((b) => this.num(b.decl.initializer as N)) && (this.assigns.get(s) ?? []).every((e) => this.numAssign(e));
        if (!ok) {
          this.numeric.delete(s);
          changed = true;
        }
      }
    }
    for (const [s, bs] of this.bindings) {
      if ((this.assigns.get(s) ?? []).length > 0) continue;
      if (bs.every((b) => (b.how === "var" && b.isConst && this.fixedExpr(b.decl.initializer as N | undefined)) || (b.how === "forof" && b.isConst && this.literalArray((b.decl.parent.parent as N).expression as N)))) this.fixed.add(s);
    }
  }

  /** A safe string literal, a number literal, or a choice between such. */
  private fixedExpr(e0: N | undefined): boolean {
    if (!e0) return false;
    const e = unparen(e0);
    if (safeStr(e) || isNum(e)) return true;
    return e.kind === K.ConditionalExpression && this.fixedExpr(e.whenTrue as N) && this.fixedExpr(e.whenFalse as N);
  }

  private literalArray(e: N): boolean {
    const a = unparen(e);
    return a.kind === K.ArrayLiteralExpression && kids(a).every((x) => safeStr(x) || isNum(x));
  }

  /** An expression that is a number (or a bigint) at run time whatever its operands hold. */
  private num(e0: N | undefined): boolean {
    if (!e0) return false;
    const e = unparen(e0);
    switch (e.kind) {
      case K.NumericLiteral:
      case K.BigIntLiteral:
        return true;
      case K.PrefixUnaryExpression:
        return e.operator !== K.ExclamationToken;
      case K.PostfixUnaryExpression:
        return true;
      case K.BinaryExpression: {
        const op = (e.operatorToken as N).kind;
        if (NUM_BIN.has(op) || NUM_COMPOUND.has(op)) return true;
        if (op === K.PlusToken || op === K.PlusEqualsToken) return this.num(e.left as N) && this.num(e.right as N);
        if (op === K.EqualsToken) return this.num(e.right as N);
        return false;
      }
      case K.ConditionalExpression:
        return this.num(e.whenTrue as N) && this.num(e.whenFalse as N);
      case K.Identifier:
        return this.numeric.has(String(e.text));
      case K.CallExpression: {
        const c = unparen(e.expression as N);
        if (c.kind === K.Identifier) return ["parseInt", "parseFloat", "Number"].includes(String(c.text));
        if (c.kind === K.PropertyAccessExpression && (c.expression as N).kind === K.Identifier) {
          const o = String((c.expression as N).text);
          const m = String((c.name as N).text);
          return o === "Math" || (o === "Number" && (m === "parseInt" || m === "parseFloat"));
        }
        return false;
      }
      default:
        return false;
    }
  }

  private numAssign(e: N): boolean {
    if (e.kind === K.PrefixUnaryExpression || e.kind === K.PostfixUnaryExpression) return true;
    const op = (e.operatorToken as N).kind;
    if (NUM_COMPOUND.has(op)) return true;
    return this.num(e.right as N) && (op === K.EqualsToken || op === K.PlusEqualsToken);
  }

  private safeKey(k0: N): boolean {
    const k = unparen(k0);
    if (isNum(k) || safeStr(k) || this.num(k)) return true;
    return k.kind === K.Identifier && this.fixed.has(String(k.text));
  }

  // ------------------------------------------------------------- the walk

  private topLevel(): void {
    for (const st of (this.sf.statements as N[]) ?? []) {
      const ok = st.kind === K.ImportDeclaration || st.kind === K.VariableStatement || st.kind === K.FunctionDeclaration || st.kind === K.InterfaceDeclaration || st.kind === K.TypeAliasDeclaration || st.kind === K.EmptyStatement;
      if (!ok) this.refuse(st, "a top-level statement other than an import, a declaration or a type");
    }
  }

  private declared(s: string): boolean {
    return this.bindings.has(s);
  }

  private isReference(id: N): boolean {
    const p = id.parent;
    switch (p.kind) {
      case K.PropertyAccessExpression:
        return p.expression === id;
      case K.PropertyAssignment:
        return p.initializer === id;
      case K.VariableDeclaration:
      case K.Parameter:
      case K.BindingElement:
        return p.initializer === id;
      case K.FunctionDeclaration:
      case K.FunctionExpression:
      case K.MethodDeclaration:
      case K.PropertyDeclaration:
      case K.ImportSpecifier:
      case K.ImportClause:
      case K.NamespaceImport:
      case K.LabeledStatement:
      case K.BreakStatement:
      case K.ContinueStatement:
      case K.QualifiedName:
        return false;
      default:
        return true;
    }
  }

  private visit(n: N): void {
    if (this.fail) return;
    if (n.kind === K.TypePredicate || n.kind === K.ImportType || n.kind === K.TypeQuery) {
      if (n.kind === K.ImportType) return this.refuse(n, "an import type");
    }
    if (isType(n)) return;
    const d = DENIED[n.kind];
    if (d) return this.refuse(n, `${d} is not allowed`);
    const mods = (n.modifiers as N[] | undefined) ?? [];
    for (const m of mods) {
      if (m.kind === K.DeclareKeyword) return this.refuse(n, "declare is not allowed");
      if (m.kind === K.AsyncKeyword) return this.refuse(n, "async is not allowed");
      if (m.kind === K.ExportKeyword && n.parent !== this.sf) return this.refuse(n, "export inside a block");
    }
    if ((n.kind === K.FunctionDeclaration || n.kind === K.FunctionExpression || n.kind === K.MethodDeclaration) && n.asteriskToken) return this.refuse(n, "a generator is not allowed");
    if (n.kind === K.FunctionDeclaration && !n.body) return this.refuse(n, "a function without a body (an overload)");
    switch (n.kind) {
      case K.ImportDeclaration: {
        const spec = String((n.moduleSpecifier as N).text);
        const clause = n.importClause as N | undefined;
        if (spec !== VALUE_IMPORT && clause && !clauseTypeOnly(clause)) {
          const named = clause.namedBindings as N | undefined;
          const allType = !clause.name && named?.kind === K.NamedImports && kids(named).every((s) => s.isTypeOnly as boolean);
          if (!allType) return this.refuse(n, `a value import from ${spec}`);
        }
        if (clause?.name || (clause?.namedBindings as N | undefined)?.kind === K.NamespaceImport) return this.refuse(n, "a default or namespace import");
        // `with { type: "macro" }` would make bun run the import at transpile time; a quoted import name is no need
        if (n.attributes) return this.refuse(n, "import attributes (with { ... })");
        const named = clause?.namedBindings as N | undefined;
        if (named && kids(named).some((s) => s.propertyName !== undefined && (s.propertyName as N).kind !== K.Identifier)) return this.refuse(n, "an import under a quoted name");
        return; // names checked through the bindings
      }
      case K.Identifier: {
        if (!this.isReference(n)) return;
        const s = String(n.text);
        if (!this.declared(s) && !LIB.has(s)) return this.refuse(n, `names ${s}, which is neither declared here nor one of ${LIB_GLOBALS.join(", ")}`);
        // a global object is used in place only (Math.floor(x), JSON.parse(s), new Map()), never as a value: an alias
        // (const m = Math; m.max = ...) could rewrite it for the whole process the draft is installed in
        if (!this.declared(s) && !PRIMITIVE_GLOBALS.has(s)) {
          const p = n.parent;
          const inPlace = (p.kind === K.PropertyAccessExpression || p.kind === K.CallExpression || p.kind === K.NewExpression) && p.expression === n;
          if (!inPlace) return this.refuse(n, `uses the global ${s} as a value (only ${s}.member, ${s}(...) or new ${s}(...))`);
          // RegExp's static members (input, lastMatch, $1 ...) hold the last match of the whole process: a writer's
          // or the watcher's, not the draft's arguments
          if (s === "RegExp" && p.kind === K.PropertyAccessExpression) return this.refuse(n, "a static member of RegExp (only new RegExp(...) or RegExp(...))");
        }
        return;
      }
      case K.PropertyAccessExpression: {
        const name = n.name as N;
        if (name.kind !== K.Identifier) return this.refuse(n, "a private name");
        if (bannedName(String(name.text))) return this.refuse(n, `the property ${name.text} is not allowed`);
        break;
      }
      case K.ElementAccessExpression:
        if (!this.safeKey(n.argumentExpression as N)) return this.refuse(n, "an index that is not a number, a string literal or a fixed key (see the rules)");
        break;
      case K.ComputedPropertyName:
        if (!this.safeKey(n.expression as N)) return this.refuse(n, "a computed name that is not a number, a string literal or a fixed key");
        break;
      case K.PropertyAssignment:
      case K.MethodDeclaration:
      case K.ShorthandPropertyAssignment: {
        const name = n.name as N;
        if ((name.kind === K.Identifier || isStr(name)) && bannedName(String(name.text))) return this.refuse(n, `the property name ${show(String(name.text))} is not allowed`);
        break;
      }
      case K.CallExpression:
        if ((n.expression as N).kind === K.ImportKeyword) return this.refuse(n, "a dynamic import");
        break;
      case K.NewExpression: {
        const c = unparen(n.expression as N);
        const s = c.kind === K.Identifier ? String(c.text) : "";
        const imported = HELPER_CLASSES.includes(s) && (this.bindings.get(s) ?? []).every((b) => b.how === "import" && (b.decl.propertyName as N | undefined) === undefined);
        if (!NEWABLE.has(s) && !imported) return this.refuse(n, `new is allowed only for ${[...NEW_GLOBALS, ...HELPER_CLASSES].join(", ")}`);
        break;
      }
    }
    for (const c of kids(n)) this.visit(c);
  }

  /** Assignment roots must be names the file declares as variables or parameters (never globals or imports). */
  checkRoots(): AstResult {
    for (const r of this.rootChecks) {
      const s = String(r.text);
      const bs = this.bindings.get(s);
      if (!bs || bs.some((b) => b.how === "import" || b.how === "function")) return { ok: false, why: `line ${lineOf(this.src, r.pos)}: writes into ${s}, which this file does not own` };
    }
    for (const [s, es] of this.assigns) {
      const bs = this.bindings.get(s);
      if (!bs) return { ok: false, why: `line ${lineOf(this.src, es[0]!.pos)}: assigns ${s}, which this file does not declare` };
      if (bs.some((b) => b.how === "import" || b.how === "function")) return { ok: false, why: `line ${lineOf(this.src, es[0]!.pos)}: assigns ${s}, an import or a function` };
    }
    return { ok: true };
  }

  result(): AstResult {
    const r = this.run();
    return r.ok ? this.checkRoots() : r;
  }
}

/** Checks one draft's source. Writes it to a fresh folder (under `dir`, else the temp folder), parses it with the
 *  TypeScript API and walks the tree; the folder is removed after. */
export async function checkSyntax(src: string, dir?: string): Promise<AstResult> {
  const base = dir ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const work = mkdtempSync(join(base, "ast-"));
  let api: API | undefined;
  try {
    writeFileSync(join(work, "draft.ts"), src);
    writeFileSync(join(work, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, noResolve: true, lib: ["ESNext"], types: [], target: "ESNext", module: "ESNext" }, files: ["draft.ts"] }));
    api = new API({ cwd: work });
    const snap = await api.updateSnapshot({ openProjects: [join(work, "tsconfig.json")] });
    const proj = snap.getProjects()[0];
    if (!proj) return { ok: false, why: "the TypeScript API opened no project" };
    const sf = (await proj.program.getSourceFile(join(work, "draft.ts"))) as unknown as N | undefined;
    if (!sf) return { ok: false, why: "the TypeScript API returned no syntax tree" };
    const diags = await proj.program.getSyntacticDiagnostics(join(work, "draft.ts"));
    if (diags.length > 0) return { ok: false, why: "the draft has a syntax error" };
    return new Checker(sf, src).result();
  } catch (e) {
    return { ok: false, why: `the syntax check failed (${(e instanceof Error ? e.message : String(e)).slice(0, 120)})` };
  } finally {
    try {
      await api?.close();
    } catch {
      // the API child is gone already
    }
    rmSync(work, { recursive: true, force: true });
  }
}
