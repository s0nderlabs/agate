// localStorage that never throws: private windows, blocked site data and previews make the accessor throw.
// bigint values are stored as {"$big":"123"}.
const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? { $big: v.toString() } : v);
const reviver = (_: string, v: unknown) =>
  v && typeof v === "object" && "$big" in (v as object) ? BigInt((v as { $big: string }).$big) : v;

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw, reviver) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value, replacer));
  } catch {
    // storage unavailable: the page still works for this visit
  }
}

export function remove(key: string) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // ignore
  }
}
