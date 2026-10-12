// The parser registry (BUILD-SPEC 7.7): every installed parser version, "<name>/<N>", with the source it reads.
// The "/1" versions are the registered ones (inside each recipeHash). A reader swap (4.15) can name a later version
// only once it is installed here: `repair install` (15.2) writes src/pure/parsers/<name>.v<N>.ts (which exports one
// `extract`), adds its import as the last line of the import block below
// (`import { extract as extractLambdaV2 } from "./lambda.v2.ts";`) and one entry between the repair markers.
import type { Extractor } from "../../types.ts";
import { extractCivo } from "./civo.ts";
import { extractCoreWeave } from "./coreweave.ts";
import { extractGcore } from "./gcore.ts";
import { extractHyperstack } from "./hyperstack.ts";
import { extractLambda } from "./lambda.ts";
import { extractNebius } from "./nebius.ts";
import { extractSeeweb } from "./seeweb.ts";
import { extractVerda } from "./verda.ts";
import { extract as extractNebiusV2 } from "./nebius.v2.ts";

export const EXTRACTORS_BY_VERSION: Readonly<Record<string, { sourceId: string; extract: Extractor }>> = {
  "verda/1": { sourceId: "p_verda", extract: extractVerda },
  "nebius/1": { sourceId: "p_nebius", extract: extractNebius },
  "lambda/1": { sourceId: "p_lambda", extract: extractLambda },
  "coreweave/1": { sourceId: "p_coreweave", extract: extractCoreWeave },
  "civo/1": { sourceId: "p_civo", extract: extractCivo },
  "hyperstack/1": { sourceId: "p_hyperstack", extract: extractHyperstack },
  "seeweb/1": { sourceId: "p_seeweb", extract: extractSeeweb },
  "gcore/1": { sourceId: "p_gcore", extract: extractGcore },
  // repair:begin
  "nebius/2": { sourceId: "p_nebius", extract: extractNebiusV2 },
  // repair:end
};
