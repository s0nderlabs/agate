"use client";
// What a polite live region reads out: the words, and a way to say new ones. Each is cleared first and set on the
// next frame, so the same words twice in a row (a second Copy, a second # link) are still read out.
import { useCallback, useEffect, useRef, useState } from "react";

export function useSay(): [string, (text: string) => void] {
  const [said, setSaid] = useState("");
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const say = useCallback((text: string) => {
    setSaid("");
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setSaid(text));
  }, []);
  return [said, say];
}
