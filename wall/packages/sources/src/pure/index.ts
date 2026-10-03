// The pure layer (BUILD-SPEC 7.7): runs in CRE's WASM and in bun alike. No Node, Bun or DOM APIs, no floats in the
// price path. Satisfies SourcesPureApi (../types.ts); the extra exports serve the panel tool, the watcher and tests.
import type { SourcesPureApi } from "../types.ts";
import { parseEcb } from "./ecb.ts";
import { toValueU } from "./money.ts";
import { gpuIdOf, recipeHash, slotValues } from "./panel.ts";
import { parse, parseWith } from "./parse.ts";
import { PARSER_VERSIONS, readerAllowed, readerInForce, readerProblem, sourceOfVersion } from "./readers.ts";
import { SOURCES } from "./recipe.ts";

export { asciiBytes, CanonicalError, canonicalJson } from "./canonical.ts";
export { dayNumber, FX_MAX_AGE_DAYS, fxUsableFor, parseEcb } from "./ecb.ts";
export { centValueU, DecimalError, fxMicro, inBounds, parseMicro, toValueU } from "./money.ts";
export { checkPanel, gpuIdOf, PanelError, recipeHash, recipeObject, slotValues } from "./panel.ts";
export { EXTRACTORS, installed, MAX_BODY_CHARS, parse, parseWith, priceRow, type Reason, REASONS, reasonOf } from "./parse.ts";
export { EXTRACTORS_BY_VERSION } from "./parsers/index.ts";
export { httpsHost, isRegistered, PARSER_VERSIONS, readerAllowed, readerInForce, readerProblem, registeredReader, sourceOfVersion, swapInForce } from "./readers.ts";
export {
  assertAllowed,
  BOUNDS,
  CRE_CAP_BYTES,
  ECB,
  FORBIDDEN,
  FX_RECIPE,
  GPUS,
  HELD_OUT,
  ROUNDING,
  SOURCE_META,
  SOURCES,
  type SourceMeta,
  SPEC_VERSION,
  specOf,
  TRACKERS,
} from "./recipe.ts";

/** The whole pure API as one object (what the writers' asSourcesApi checks). */
export const sourcesApi: SourcesPureApi = {
  SOURCES,
  parse,
  parseEcb,
  toValueU,
  slotValues,
  recipeHash,
  gpuIdOf,
  PARSER_VERSIONS,
  sourceOfVersion,
  parseWith,
  readerAllowed,
  readerProblem,
  readerInForce,
};
