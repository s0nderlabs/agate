// No key in the environment (BUILD-SPEC 13.1): the page check and the repair agent hold none.

/** Names of variables that look like a key: *_KEY, *_KEY_CMD, CRE_ETH_PRIVATE_KEY, and any extra names. */
export function keyVars(env: Record<string, string | undefined>, extra: readonly string[] = []): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && (/_KEY$/.test(k) || /_KEY_CMD$/.test(k) || k === "CRE_ETH_PRIVATE_KEY" || extra.includes(k)))
    .sort();
}

/** Throws (naming the variables, never their values) when any key variable is set. */
export function refuseKeys(env: Record<string, string | undefined>, who: string, extra: readonly string[] = []): void {
  const bad = keyVars(env, extra);
  if (bad.length > 0) throw new Error(`${who} holds no key and refuses to start with ${bad.join(", ")} set (BUILD-SPEC 13.1)`);
}
