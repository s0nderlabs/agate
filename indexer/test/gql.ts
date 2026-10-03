// A small GraphQL reader for the README's queries (BOTS-SPEC 5.8): parses the query subset the app uses (variables,
// where with _eq/_gt/_gte/_lt/_lte/_in/_or/_and, order_by, limit, object relations and @derivedFrom lists) and runs
// it over the test indexer's entities the way Hasura reads Envio's tables (a relation `x` is the column `x_id`).
// Every selected or filtered field is checked against schema.graphql, so a query that names a field the schema does
// not have fails here instead of in the app. No Docker, no Hasura.

type Tok = { k: "p" | "name" | "str" | "num" | "var"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/[\s,]/.test(c)) i++;
    else if (c === "#") while (i < src.length && src[i] !== "\n") i++;
    else if ("{}()[]:!".includes(c)) out.push({ k: "p", v: src[i++]! });
    else if (c === '"') {
      const j = src.indexOf('"', i + 1);
      out.push({ k: "str", v: src.slice(i + 1, j) });
      i = j + 1;
    } else if (c === "$") {
      const m = /^\$[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i))![0];
      out.push({ k: "var", v: m.slice(1) });
      i += m.length;
    } else if (/[-0-9]/.test(c)) {
      const m = /^-?[0-9]+/.exec(src.slice(i))![0];
      out.push({ k: "num", v: m });
      i += m.length;
    } else {
      const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i));
      if (!m) throw new Error(`gql: unexpected ${c}`);
      out.push({ k: "name", v: m[0] });
      i += m[0].length;
    }
  }
  return out;
}

export type Value = string | number | boolean | null | { var: string } | { enum: string } | Value[] | { [k: string]: Value };
export interface Field {
  name: string;
  args: Record<string, Value>;
  sel: Field[] | null;
}
export interface Query {
  name: string;
  vars: string[];
  sel: Field[];
}

export function parse(src: string): Query[] {
  const t = lex(src);
  let p = 0;
  const peek = () => t[p];
  const take = (v?: string) => {
    const x = t[p++];
    if (!x || (v !== undefined && x.v !== v)) throw new Error(`gql: expected ${v ?? "a token"} at ${p}, got ${x?.v}`);
    return x;
  };
  const value = (): Value => {
    const x = take();
    if (x.k === "var") return { var: x.v };
    if (x.k === "str") return x.v;
    if (x.k === "num") return Number(x.v);
    if (x.k === "name") return x.v === "true" ? true : x.v === "false" ? false : x.v === "null" ? null : { enum: x.v };
    if (x.v === "[") {
      const xs: Value[] = [];
      while (peek()?.v !== "]") xs.push(value());
      take("]");
      return xs;
    }
    if (x.v === "{") {
      const o: Record<string, Value> = {};
      while (peek()?.v !== "}") {
        const k = take().v;
        take(":");
        o[k] = value();
      }
      take("}");
      return o;
    }
    throw new Error(`gql: bad value ${x.v}`);
  };
  const selection = (): Field[] => {
    take("{");
    const fs: Field[] = [];
    while (peek()?.v !== "}") {
      const name = take().v;
      const args: Record<string, Value> = {};
      if (peek()?.v === "(") {
        take("(");
        while (peek()?.v !== ")") {
          const k = take().v;
          take(":");
          args[k] = value();
        }
        take(")");
      }
      fs.push({ name, args, sel: peek()?.v === "{" ? selection() : null });
    }
    take("}");
    return fs;
  };
  const qs: Query[] = [];
  while (p < t.length) {
    take("query");
    const name = take().v;
    const vars: string[] = [];
    if (peek()?.v === "(") {
      take("(");
      while (peek()?.v !== ")") {
        vars.push(take().v);
        take(":");
        take();
        if (peek()?.v === "!") take("!");
      }
      take(")");
    }
    qs.push({ name, vars, sel: selection() });
  }
  return qs;
}

// ------------------------------------------------------------------ the schema

interface FieldDef {
  type: string;
  list: boolean;
  derivedFrom?: string;
}
export type Schema = { entities: Map<string, Map<string, FieldDef>>; enums: Set<string> };

export function readSchema(src: string): Schema {
  const enums = new Set([...src.matchAll(/^enum (\w+)/gm)].map((m) => m[1]!));
  const entities = new Map<string, Map<string, FieldDef>>();
  for (const m of src.matchAll(/^type (\w+) \{([\s\S]*?)^\}/gm)) {
    const fields = new Map<string, FieldDef>();
    for (const line of m[2]!.split("\n")) {
      const f = /^\s*(\w+): (\[)?(\w+)!?\]?!?(.*)$/.exec(line.replace(/#.*$/, ""));
      if (!f) continue;
      const d = /@derivedFrom\(field: "(\w+)"\)/.exec(f[4]!);
      fields.set(f[1]!, { type: f[3]!, list: f[2] === "[", derivedFrom: d?.[1] });
    }
    entities.set(m[1]!, fields);
  }
  return { entities, enums };
}

// ------------------------------------------------------------------ the evaluator

type Row = Record<string, unknown>;
export type Data = Record<string, Row[]>;

function resolve(v: Value, vars: Record<string, unknown>): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if ("var" in v && typeof v.var === "string" && Object.keys(v).length === 1) {
      if (!(v.var in vars)) throw new Error(`gql: variable $${v.var} not given`);
      return vars[v.var];
    }
    if ("enum" in v && Object.keys(v).length === 1) return v.enum;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x as Value, vars)]));
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x, vars));
  return v;
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "bigint" || typeof b === "bigint") {
    const x = BigInt(a as bigint);
    const y = BigInt(b as bigint);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** `x_id`, the column Envio stores for a (non-derived) relation `x`, readable in Hasura like any column. */
function relationColumn(schema: Schema, entity: string, key: string): boolean {
  const f = key.endsWith("_id") ? schema.entities.get(entity)!.get(key.slice(0, -3)) : undefined;
  return f !== undefined && !f.list && !f.derivedFrom && schema.entities.has(f.type);
}

function column(schema: Schema, entity: string, key: string): string {
  const fs = schema.entities.get(entity)!;
  if (relationColumn(schema, entity, key)) return key;
  const f = fs.get(key);
  if (!f || f.list || schema.entities.has(f.type)) throw new Error(`gql: ${entity}.${key} is not a column`);
  return key;
}

function matches(schema: Schema, entity: string, row: Row, where: Record<string, unknown>): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === "_or") {
      if (!(cond as Record<string, unknown>[]).some((w) => matches(schema, entity, row, w))) return false;
      continue;
    }
    if (k === "_and") {
      if (!(cond as Record<string, unknown>[]).every((w) => matches(schema, entity, row, w))) return false;
      continue;
    }
    const v = row[column(schema, entity, k)];
    for (const [op, x] of Object.entries(cond as Record<string, unknown>)) {
      const ok =
        op === "_eq" ? v !== undefined && cmp(v, x) === 0
        : op === "_gt" ? v !== undefined && cmp(v, x) > 0
        : op === "_gte" ? v !== undefined && cmp(v, x) >= 0
        : op === "_lt" ? v !== undefined && cmp(v, x) < 0
        : op === "_lte" ? v !== undefined && cmp(v, x) <= 0
        : op === "_in" ? (x as unknown[]).some((y) => cmp(v, y) === 0)
        : (() => {
            throw new Error(`gql: operator ${op}`);
          })();
      if (!ok) return false;
    }
  }
  return true;
}

function list(schema: Schema, entity: string, rows: Row[], args: Record<string, unknown>): Row[] {
  let out = args.where ? rows.filter((r) => matches(schema, entity, r, args.where as Record<string, unknown>)) : [...rows];
  if (args.order_by) {
    const [[k, dir]] = Object.entries(args.order_by as Record<string, string>) as [[string, string]];
    const col = column(schema, entity, k);
    out.sort((a, b) => cmp(a[col], b[col]) * (dir === "desc" ? -1 : 1));
  }
  if (args.limit !== undefined) out = out.slice(0, args.limit as number);
  return out;
}

function project(schema: Schema, data: Data, entity: string, row: Row, sel: Field[], vars: Record<string, unknown>): Row {
  const fs = schema.entities.get(entity)!;
  const out: Row = {};
  for (const f of sel) {
    if (relationColumn(schema, entity, f.name)) {
      out[f.name] = row[f.name] ?? null;
      continue;
    }
    const def = fs.get(f.name);
    if (!def) throw new Error(`gql: ${entity} has no field ${f.name}`);
    const args = resolve(f.args as Value, vars) as Record<string, unknown>;
    if (def.derivedFrom) {
      if (!f.sel) throw new Error(`gql: ${entity}.${f.name} needs a selection`);
      const rows = (data[def.type] ?? []).filter((r) => r[`${def.derivedFrom}_id`] === row.id);
      out[f.name] = list(schema, def.type, rows, args).map((r) => project(schema, data, def.type, r, f.sel!, vars));
    } else if (schema.entities.has(def.type)) {
      if (!f.sel) throw new Error(`gql: ${entity}.${f.name} needs a selection`);
      const id = row[`${f.name}_id`];
      const target = id === undefined ? undefined : (data[def.type] ?? []).find((r) => r.id === id);
      out[f.name] = target ? project(schema, data, def.type, target, f.sel, vars) : null;
    } else {
      if (f.sel) throw new Error(`gql: ${entity}.${f.name} is a scalar`);
      out[f.name] = row[f.name] ?? null;
    }
  }
  return out;
}

/** Checks a filter's columns and operators against the schema, whatever the data. */
function checkWhere(schema: Schema, entity: string, where: Value): void {
  for (const [k, cond] of Object.entries(where as Record<string, Value>)) {
    if (k === "_or" || k === "_and") {
      for (const w of cond as Value[]) checkWhere(schema, entity, w);
      continue;
    }
    column(schema, entity, k);
    for (const op of Object.keys(cond as Record<string, Value>)) {
      if (!["_eq", "_gt", "_gte", "_lt", "_lte", "_in"].includes(op)) throw new Error(`gql: operator ${op}`);
    }
  }
}

/** Checks a selection set against the schema, whatever the data: every field exists, objects have selections. */
function check(schema: Schema, entity: string, sel: readonly Field[]): void {
  const fs = schema.entities.get(entity);
  if (!fs) throw new Error(`gql: no entity ${entity}`);
  for (const f of sel) {
    if (relationColumn(schema, entity, f.name)) {
      if (f.sel || Object.keys(f.args).length) throw new Error(`gql: ${entity}.${f.name} is a scalar`);
      continue;
    }
    const def = fs.get(f.name);
    if (!def) throw new Error(`gql: ${entity} has no field ${f.name}`);
    const isObject = schema.entities.has(def.type);
    if (isObject !== (f.sel !== null)) throw new Error(`gql: ${entity}.${f.name} ${isObject ? "needs a selection" : "is a scalar"}`);
    if (Object.keys(f.args).length && !def.derivedFrom) throw new Error(`gql: ${entity}.${f.name} takes no arguments`);
    checkArgs(schema, def.type, f.args);
    if (f.sel) check(schema, def.type, f.sel);
  }
}
function checkArgs(schema: Schema, entity: string, args: Record<string, Value>): void {
  for (const [k, v] of Object.entries(args)) {
    if (k === "where") checkWhere(schema, entity, v);
    else if (k === "order_by") for (const c of Object.keys(v as Record<string, Value>)) column(schema, entity, c);
    else if (k !== "limit") throw new Error(`gql: argument ${k}`);
  }
}

/** Runs one parsed query over the entities; returns { <root field>: rows }. */
export function run(schema: Schema, data: Data, q: Query, vars: Record<string, unknown>): Record<string, Row[]> {
  for (const v of q.vars) if (!(v in vars)) throw new Error(`gql: ${q.name} needs $${v}`);
  for (const f of q.sel) {
    checkArgs(schema, f.name, f.args);
    check(schema, f.name, f.sel ?? []);
  }
  const out: Record<string, Row[]> = {};
  for (const f of q.sel) {
    const args = resolve(f.args as Value, vars) as Record<string, unknown>;
    out[f.name] = list(schema, f.name, data[f.name] ?? [], args).map((r) => project(schema, data, f.name, r, f.sel ?? [], vars));
  }
  return out;
}
