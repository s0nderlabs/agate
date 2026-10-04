// One pocket operation at a time per AI connection (the MCP tools and the autopilot share it): two operations signed
// at once would race for the same Kernel nonce and the same daily count.
const locks = new Map<string, Promise<void>>();

export async function serial<T>(key: string, f: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev.catch(() => {});
  try {
    return await f();
  } finally {
    release();
    // the last one out removes the entry (comparing the stored chain, not `mine`, so the map does not grow)
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/** test seam: how many connections hold or wait for the lock */
export const lockCount = () => locks.size;
