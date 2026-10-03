// The recipe as typed data (BUILD-SPEC 7.1 to 7.3): one page per cloud, how each GPU's row is found, the per-GPU
// rule, currency and bounds. Every field of a rule enters recipeHash; change a parser's behaviour => bump its
// parserVersion (a new recipeHash), change the method => bump the spec version (a new gpuId).
import type { GpuModel } from "@agate/report/types";
import type { ExtractionRule, SourceDef } from "../types.ts";

export const GPUS: readonly GpuModel[] = ["H100", "H200", "B200"];
export const SPEC_VERSION = 1;
export const specOf = (gpu: GpuModel, version = SPEC_VERSION): string => `${gpu}-SXM/on-demand-list/neocloud/v${version}`;

/** Bounds of rule 7 in u (10^-6 USD) per GPU-hour. */
export const BOUNDS: readonly [number, number] = [100_000, 1_000_000_000];
export const FX_RECIPE = {
  source: "ECB eurofxref-hist-90d",
  rule: "last ECB business day strictly before the page's UTC date",
  base: "USD per EUR",
} as const;
export const ROUNDING = "per-GPU, then FX, cent half-up once";

export const ECB = { id: "fx_ecb", url: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml" } as const;

const BASE = {
  priceClass: "on-demand",
  instance: "per-GPU of the 8-GPU instance, else of the 1-GPU instance",
  rentable: "assumed-rentable",
  effectiveDate: "a price shown from date X counts from 00:00 UTC of X",
  tax: "excluding VAT",
} as const;

const rule = (product: string, form: ExtractionRule["form"], notes: string): ExtractionRule => ({ ...BASE, product, form, notes });

const NOT_ORDERABLE = "A price cell showing N/A, sold out, waitlist, contact sales or coming soon is NOT_RENTABLE.";

const verda = (model: string, name: string) =>
  rule(
    name,
    "SXM",
    `JSON array of instance types. Rows with model == "${model}" exactly (never "${model} CC") whose name contains SXM and currency == "usd". ` +
      "Size from gpu.number_of_gpus (must match the Nx prefix of gpu.description): 8, else 1, never 2 or 4. " +
      "Read price_per_hour (a decimal string; never spot_price, dynamic_price, max_dynamic_price or serverless_*), " +
      "per instance, divided by the GPU count. Rows of the chosen size must agree.",
  );

const nebius = (gpu: GpuModel) =>
  rule(
    `NVIDIA ${gpu} NVLink`,
    "NVLink",
    `Markdown. Sections headed "#### NVIDIA(R) ${gpu} NVLink" (optionally ", <platform id>"); the page writes the registered sign after NVIDIA. ` +
      'Inside each, the <Tab title="USD"> table only (never ILS). Header rows "Item", "Item - from <Month D, YYYY>" or ' +
      '"Item - before <date>" split it into blocks; the block in effect at the reading time is used (from X counts from 00:00 UTC of X). ' +
      `Row item == "NVIDIA(R) ${gpu} NVLink" exactly (never Preemptible), Per == "1 GPU hour", price "\\$d.dd" per GPU-hour. ` +
      "Nebius calls its SXM platform NVLink. Every platform section must agree.",
  );

const lambda = (plan: string) =>
  rule(
    plan,
    "SXM",
    'HTML. The "Instances pricing" h2, its tab list (8x, 4x, 2x, 1x) and the tab panel each tab controls. ' +
      `The 8x panel's table row data-plan == "${plan}", else the 1x panel's; never 4x or 2x. ` +
      'Cell data-label "PRICE/GPU/HR*" ($d.dd per GPU-hour). Never the 1-Click Clusters or Superclusters tables. ' +
      NOT_ORDERABLE,
  );

const coreweave = (slug: string, name: string) =>
  rule(
    name,
    "SXM",
    'HTML. The "On-demand GPU instances" h2, then its first "REGION: NORTH AMERICA" block (never Europe, never the CPU tables). ' +
      `The row with data-product == "${slug}" and model name "${name}". Header columns must be GPU Model, GPU Count, VRAM, vCPUs, ` +
      "System RAM, Local Storage, On-Demand Price (Per Hour), Spot Price (Per Hour). GPU count from the GPU Count cell (8, else 1), " +
      "price from the On-Demand cell ($d.dd per instance-hour, never Spot or Inference), divided by the count; the mobile " +
      '"On-Demand Price:" copy and the GPU Count copy in the same row must agree. ' +
      NOT_ORDERABLE,
  );

const civo = (caption: string, row: string) =>
  rule(
    row,
    "SXM",
    `HTML. The table captioned "${caption}" (header Size, RAM, vCPU, Storage, Data Transfer, On-demand, Commitment). ` +
      `Rows "<n> x ${row.replace(/^8 x /, "")}": n = 8, else 1, never 2 or 4. The On-demand cell's hourly value ($d.dd per hour, ` +
      "per instance), divided by n; never the monthly value or any Commitment column. " +
      NOT_ORDERABLE,
  );

const hyperstack = (name: string, notNames: string) =>
  rule(
    name,
    "SXM",
    'HTML. The "On-Demand GPU Pricing" card (header GPU Model, VRAM (GB), Max pCPUs per GPU, Max RAM (GB) per GPU, Pricing Per Hour), ' +
      `row "${name}" exactly; never ${notNames}; never the Reservation or Spot VM cards. ` +
      "The card quotes per GPU-hour, read as is. " +
      NOT_ORDERABLE,
  );

const seeweb = (card: string) =>
  rule(
    card,
    "SXM",
    `HTML, EUR. The card whose name is "${card}" and whose form line reads "GPU SXM". The Standard/Spot switch must be unchecked ` +
      "(Standard = on-demand) and the card's GPU-count select must default to its first option, 1. " +
      '"Hourly Cost" (<span>d.dd</span> EUR) is per GPU-hour, read as is; never the 3, 6 or 12 month prices. ' +
      NOT_ORDERABLE,
  );

const gcore = (gpu: GpuModel) =>
  rule(
    `8x${gpu}`,
    "SXM",
    'HTML, EUR. The section id="virtual-gpu" ("Virtual GPU": pay only while powered on), currency radio EUR checked, table header ' +
      `GPU Configuration, GPU Memory, CPU/RAM, Storage, Cost per hour. Rows "<n>x${gpu}" (the page writes a multiplication sign): ` +
      "n = 8, else 1; Cost per hour (EUR d.dd per instance-hour) divided by n. Never the bare-metal table above it (its pricing " +
      'model is not stated in the served page) and never "Everywhere Inference". ' +
      NOT_ORDERABLE,
  );

export const SOURCES: readonly SourceDef[] = [
  {
    id: "p_verda",
    company: "Verda",
    url: "https://api.verda.com/v1/instance-types",
    currency: "USD",
    parserVersion: "verda/1",
    hosts: ["api.verda.com", "verda.com", "www.verda.com", "api.datacrunch.io", "datacrunch.io", "www.datacrunch.io"],
    rules: {
      H100: verda("H100", "H100 SXM5 80GB"),
      H200: verda("H200", "H200 SXM5 141GB"),
      B200: verda("B200", "B200 SXM6 180GB"),
    },
  },
  {
    id: "p_nebius",
    company: "Nebius",
    url: "https://docs.nebius.com/compute/resources/pricing.md",
    currency: "USD",
    parserVersion: "nebius/1",
    hosts: ["docs.nebius.com", "nebius.com", "www.nebius.com"],
    rules: { H100: nebius("H100"), H200: nebius("H200"), B200: nebius("B200") },
  },
  {
    id: "p_lambda",
    company: "Lambda",
    url: "https://lambda.ai/pricing",
    currency: "USD",
    parserVersion: "lambda/1",
    hosts: ["lambda.ai", "www.lambda.ai", "lambdalabs.com", "www.lambdalabs.com"],
    rules: { H100: lambda("NVIDIA H100 SXM"), B200: lambda("NVIDIA B200 SXM6") },
  },
  {
    id: "p_coreweave",
    company: "CoreWeave",
    url: "https://www.coreweave.com/pricing",
    currency: "USD",
    parserVersion: "coreweave/1",
    hosts: ["www.coreweave.com", "coreweave.com", "docs.coreweave.com"],
    rules: {
      H100: coreweave("hgx-h100", "NVIDIA HGX H100"),
      H200: coreweave("hgx-h200", "NVIDIA HGX H200"),
      B200: coreweave("nvidia-b200", "NVIDIA HGX B200"),
    },
  },
  {
    id: "p_civo",
    company: "Civo",
    url: "https://www.civo.com/pricing",
    currency: "USD",
    parserVersion: "civo/1",
    hosts: ["www.civo.com", "civo.com"],
    rules: {
      H100: civo("NVIDIA H100 SXM GPU pricing", "8 x NVIDIA H100 - 80GB"),
      H200: civo("NVIDIA H200 SXM GPU pricing", "8 x NVIDIA H200 - 141GB HBM3e"),
      B200: civo("NVIDIA B200 GPU pricing", "8 x NVIDIA B200 - 180GB"),
    },
  },
  {
    id: "p_hyperstack",
    company: "Hyperstack",
    url: "https://www.hyperstack.cloud/gpu-pricing",
    currency: "USD",
    parserVersion: "hyperstack/1",
    hosts: ["www.hyperstack.cloud", "hyperstack.cloud"],
    rules: {
      H100: hyperstack("NVIDIA H100 SXM", '"NVIDIA H100 NVLink" (a PCIe card with a bridge) or "NVIDIA H100" (PCIe)'),
      H200: hyperstack("NVIDIA H200 SXM", "any other H200 row"),
      B200: hyperstack("NVIDIA B200", "B300 or GB200 rows"),
    },
  },
  {
    id: "p_seeweb",
    company: "Seeweb",
    url: "https://www.seeweb.it/en/products/cloud-server-gpu",
    currency: "EUR",
    parserVersion: "seeweb/1",
    hosts: ["www.seeweb.it", "seeweb.it"],
    rules: { H100: seeweb("NVIDIA H100"), H200: seeweb("NVIDIA H200") },
  },
  {
    id: "p_gcore",
    company: "Gcore",
    url: "https://gcore.com/pricing/ai",
    currency: "EUR",
    parserVersion: "gcore/1",
    hosts: ["gcore.com", "www.gcore.com"],
    rules: { H100: gcore("H100"), H200: gcore("H200") },
  },
];

/** Measured facts that drive the panel defaults (14.1 items 3 to 5). Sizes are decoded bodies, one live fetch each. */
export interface SourceMeta {
  bytes: number;
  measuredAt: string;
  narrowerUrlsTried: readonly { url: string; bytes: number; hasRows: boolean }[];
}

/** CRE's response cap (BUILD-SPEC 7.8), taken as 250,000 bytes of the decoded body (the conservative reading of 250 KB). */
export const CRE_CAP_BYTES = 250_000;

export const SOURCE_META: Readonly<Record<string, SourceMeta>> = {
  p_verda: { bytes: 129_729, measuredAt: "2026-10-01T06:45Z", narrowerUrlsTried: [] },
  p_nebius: { bytes: 14_177, measuredAt: "2026-10-01T06:45Z", narrowerUrlsTried: [] },
  p_lambda: { bytes: 86_216, measuredAt: "2026-10-01T06:45Z", narrowerUrlsTried: [] },
  p_coreweave: {
    bytes: 436_664,
    measuredAt: "2026-10-01T06:45Z",
    narrowerUrlsTried: [
      { url: "https://www.coreweave.com/pricing/classic", bytes: 354_579, hasRows: true },
      { url: "https://www.coreweave.com/products/hgx-h100-h200", bytes: 263_381, hasRows: false },
    ],
  },
  p_civo: { bytes: 196_542, measuredAt: "2026-10-01T06:45Z", narrowerUrlsTried: [] },
  p_hyperstack: { bytes: 159_190, measuredAt: "2026-10-01T06:45Z", narrowerUrlsTried: [] },
  p_seeweb: { bytes: 63_277, measuredAt: "2026-10-01T06:45Z", narrowerUrlsTried: [] },
  p_gcore: {
    bytes: 463_866,
    measuredAt: "2026-10-01T06:45Z",
    narrowerUrlsTried: [
      { url: "https://gcore.com/gpu-cloud", bytes: 484_717, hasRows: false },
      { url: "https://gcore.com/pricing/cloud", bytes: 541_783, hasRows: false },
    ],
  },
  fx_ecb: { bytes: 69_506, measuredAt: "2026-10-01T06:45Z", narrowerUrlsTried: [] },
};

// ------------------------------------------------------------------ sources that must never be read

/** Refused in writing or forbidden by terms (7.1, data-sources memory): never a slot, never fetched. */
export const FORBIDDEN = ["runpod", "ccir", "crusoe", "ornn"] as const;
/** Held out until the operator rules (7.1). */
export const HELD_OUT = ["together", "scaleway", "deepinfra", "amazonaws", "aws.amazon", "azure", "microsoft", "cloud.google", "googleapis", "oracle"] as const;
/** Trackers are display only (7.1): never a slot, never an index input. */
export const TRACKERS = ["gpuprice.fyi", "gputable", "gpu.ai", "gpueconomy", "getdeploying"] as const;

/** Throws when a source id, company, URL or allowed host names a forbidden, held-out or tracker source. */
export function assertAllowed(def: Pick<SourceDef, "id" | "company" | "url"> & { hosts?: readonly string[] }): void {
  const hay = `${def.id} ${def.company} ${def.url} ${(def.hosts ?? []).join(" ")}`.toLowerCase();
  for (const bad of [...FORBIDDEN, ...HELD_OUT, ...TRACKERS]) {
    if (hay.includes(bad)) throw new Error(`source ${def.id} names ${bad}, which must never be an index input (BUILD-SPEC 7.1)`);
  }
}

for (const s of SOURCES) assertAllowed(s);
