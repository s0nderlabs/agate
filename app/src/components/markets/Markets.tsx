"use client";
import { getMarket } from "@/lib/mock/data";
import { useMock } from "@/lib/mock/store";
import { VariantEditorial } from "./VariantEditorial";
import { VariantObject } from "./VariantObject";
import { VariantStatement } from "./VariantStatement";

/** The Markets screen; the mock controls pick which reference grammar draws it. */
export function Markets() {
  const { config } = useMock();
  const market = getMarket(config.gpu, config.data);
  if (config.v === "b") return <VariantObject market={market} />;
  if (config.v === "c") return <VariantStatement market={market} />;
  return <VariantEditorial market={market} />;
}
