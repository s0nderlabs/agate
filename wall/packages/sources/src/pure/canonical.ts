// Canonical JSON for recipeHash (BUILD-SPEC 7.6). The whole definition, so anyone can re-implement it:
//  - output is UTF-8; every string (keys included) must be printable ASCII (0x20..0x7E), else it is refused, so the
//    only escapes ever needed are \" and \\ (no unicode or control escaping rules to agree on);
//  - objects: keys sorted by byte order at every level, written as "key":value, no whitespace anywhere;
//  - arrays keep their order;
//  - integers (safe integers) are JSON numbers in plain decimal; any other number is refused;
//  - booleans are the strings "true" and "false" ("everything else strings"); null and undefined are refused.
// Python equivalent: json.dumps(convert(obj), sort_keys=True, separators=(",", ":")) after the same checks,
// where convert maps booleans to "true"/"false".

export class CanonicalError extends Error {
  override name = "CanonicalError";
}

function str(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) throw new CanonicalError(`non printable-ASCII character at ${i} in ${JSON.stringify(s.slice(0, 40))}`);
  }
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function canonicalJson(v: unknown): string {
  if (typeof v === "string") return str(v);
  if (typeof v === "boolean") return str(v ? "true" : "false");
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new CanonicalError(`not a safe integer: ${v}`);
    return Object.is(v, -0) ? "0" : String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys
      .map((k) => {
        const x = (v as Record<string, unknown>)[k];
        if (x === undefined) throw new CanonicalError(`undefined value at key ${k}`);
        return `${str(k)}:${canonicalJson(x)}`;
      })
      .join(",")}}`;
  }
  throw new CanonicalError(`cannot encode ${v === null ? "null" : typeof v}`);
}

/** Bytes of a printable-ASCII string (UTF-8 and ASCII agree there). No TextEncoder, so it runs in any JS runtime. */
export function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) throw new CanonicalError(`non printable-ASCII character at ${i}`);
    out[i] = c;
  }
  return out;
}
