"use client";
// The time now, read again every `ms` while mounted: countdowns ("Send a new code in 0:24", "In 18h 32m.",
// "This request ends in 1:40") and end dates that pass while the page is open.
import { useEffect, useState, useSyncExternalStore } from "react";

export function useNow(ms = 1_000, on = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, on]);
  return now;
}

const never = () => () => {};

/** False on the server and while the page hydrates, true after: text built from the clock to the minute waits for
 *  it, so the server's render and the browser's first one always match. */
export function useHydrated() {
  return useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
}
