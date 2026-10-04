"use client";
// The data source in effect, set by DataProvider (provider.tsx) and read by the hooks (hooks.ts).
import { createContext, useContext } from "react";
import type { DataSource } from "./source";

export const SourceCtx = createContext<DataSource | null>(null);

export function useSource(): DataSource {
  const s = useContext(SourceCtx);
  if (!s) throw new Error("useSource outside DataProvider");
  return s;
}
