// A test-installed reader "lambda/2" for the reader-swap scenario (BUILD-SPEC 4.15, 7.7, 17.2 Integrate): it reads the
// replay's redesigned Lambda layout (7.9, the on-demand card, never the spot one) and the old layout through lambda/1,
// like a repair draft that passed its gates (15.2). It is added to the parser registry in memory for one scenario and
// removed after; nothing is written into the sources package.
import type { GpuModel } from "@agate/report/types";
import { EXTRACTORS_BY_VERSION } from "@agate/sources/pure";
import type { Extractor } from "@agate/sources/types";
import { extractLambda } from "../../packages/sources/src/pure/parsers/lambda.ts";
import { type Cell, classifyPrice, elements, firstElement, textOf } from "../../packages/sources/src/pure/text.ts";

export const LAMBDA_V2 = "lambda/2";

function cards(body: string): Partial<Record<GpuModel, Cell>> {
  const out: Partial<Record<GpuModel, Cell>> = {};
  for (const card of elements(body, /<article class="gpu-card" data-model="([A-Z0-9]+)">/g, "</article>")) {
    const g = card.open[1] as GpuModel;
    if (g !== "H100" && g !== "B200") continue;
    const cell = textOf(firstElement(card.inner, /<dd class="gpu-card__price gpu-card__price--ondemand">/g, "</dd>") ?? "");
    let m = /^\$(\d[\d,]*(?:\.\d+)?) per GPU per hour$/.exec(cell);
    if (m) {
      out[g] = { kind: "price", raw: m[1]!, gpuCount: 1, where: "card" };
      continue;
    }
    m = /^\$(\d[\d,]*(?:\.\d+)?) per hour for (\d+) GPUs$/.exec(cell);
    if (m) {
      out[g] = { kind: "price", raw: m[1]!, gpuCount: Number(m[2]), where: "card" };
      continue;
    }
    out[g] = classifyPrice(cell, /^\$(\d[\d,]*(?:\.\d+)?)$/, 1, "card", "USD");
  }
  return out;
}

export const extractLambdaV2: Extractor = (body, ctx) => (body.includes('class="gpu-cards"') ? cards(body) : extractLambda(body, ctx));

type Registry = Record<string, { sourceId: string; extract: Extractor }>;

/** Installs lambda/2 for the life of one scenario; the returned function removes it. */
export function installLambdaV2(): () => void {
  const reg = EXTRACTORS_BY_VERSION as Registry;
  const had = Object.prototype.hasOwnProperty.call(reg, LAMBDA_V2);
  if (!had) reg[LAMBDA_V2] = { sourceId: "p_lambda", extract: extractLambdaV2 };
  return () => {
    if (!had) delete reg[LAMBDA_V2];
  };
}
