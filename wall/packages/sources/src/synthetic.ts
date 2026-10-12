// Hand-written minimal pages in each source's structure (never copies of the real pages): the parsers' structural
// anchors and nothing else. Used by the tests (every row state) and by the replay server's scripted pages.
import type { GpuModel } from "@agate/report/types";
import { MICRO, parseMicro } from "./pure/money.ts";
import { GPUS } from "./pure/recipe.ts";

export type SynthGpu =
  | { price: string; count?: 1 | 8 } // per-GPU native price; the page shows it per instance where the source does
  | { raw: string; count: number } // the exact text in the price cell (absurd values, too many decimals, ...)
  | { instance: string; count: number } // a native price as the page states it (per instance where it quotes so)
  | { state: "not-rentable" | "missing" | "garbled" };

export interface SynthOptions {
  /** Break the source's structural anchor (a renamed header, a moved section): the parser must refuse. */
  broken?: boolean;
  /** A second synthetic layout (the same for every source, never a copy of a real page) that every "/1" parser reads
   * as NO_ROW for every GPU: the replay's "redesigned" page step (7.9), for the repair agent's loop (15.2). */
  redesigned?: boolean;
  /** Nebius only: a dated change, "from <date>" block with the main prices, "before" block with these. */
  dated?: { date: string; before: Partial<Record<GpuModel, string>> };
  /** Nebius only: the USD table as these dated blocks, in order (the layout since Oct 8 2026: "from X", then
   *  "from X until Y", then "before X"). Each head is the phrase after "Item -"; prices per GPU (default 1.00). */
  blocks?: { head: string; prices: Partial<Record<GpuModel, string>> }[];
}

export type SynthPage = Partial<Record<GpuModel, SynthGpu>>;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Exact decimal times an integer, at least 2 decimals ("3.99" x 8 = "31.92"). */
export function times(price: string, n: number): string {
  const v = parseMicro(price) * BigInt(n);
  const int = v / MICRO;
  let frac = (v % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${int}.${frac}`;
}

interface Cellish {
  text: string; // what the price cell shows
  count: number;
}

/** The cell text and the instance size for one GPU, or null for "missing". perInstance: the page quotes per instance. */
function cellOf(g: SynthGpu | undefined, perInstance: boolean, fmt: (amount: string) => string, notRentable: string): Cellish | null {
  if (!g || ("state" in g && g.state === "missing")) return null;
  if ("state" in g) return { text: g.state === "not-rentable" ? notRentable : "call us maybe", count: 8 };
  if ("raw" in g) return { text: g.raw, count: g.count };
  if ("instance" in g) return { text: fmt(g.instance), count: g.count };
  const count = g.count ?? 8;
  return { text: fmt(perInstance ? times(g.price, count) : g.price), count };
}

const usd = (a: string) => `$${a}`;

function verda(p: SynthPage, o: SynthOptions): string {
  // Other models, never read: the confidential-computing B300, the 40 GB A100, GB300 and two older cards.
  const rows: unknown[] = [
    ["B300 CC", "B300 CC SXM6 268GB"],
    ["A100 40GB", "A100 SXM4 40GB"],
    ["GB300", "GB300 SXM6 288GB"],
    ["RTX A6000", "RTX A6000 48GB"],
    ["Tesla V100", "Tesla V100 16GB"],
  ].map(([model, name], i) => ({
    model,
    name,
    currency: "usd",
    price_per_hour: `1.${i}0`,
    spot_price: "0.50",
    gpu: { number_of_gpus: 1, description: `1x ${name}` },
  }));
  const rowOf: Record<GpuModel, [string, string]> = {
    H100: ["H100", "H100 SXM5 80GB"],
    H200: ["H200", "H200 SXM5 141GB"],
    B200: ["B200", "B200 SXM6 180GB"],
    B300: ["B300", "B300 SXM6 268GB"],
    A100: ["A100 80GB", "A100 SXM4 80GB"],
    L40S: ["L40S", "L40S 48GB"],
  };
  for (const g of GPUS) {
    const c = cellOf(p[g], true, (a) => a, "0");
    if (!c) continue;
    const st = p[g] && "state" in p[g]! ? (p[g] as { state: string }).state : undefined;
    if (st === "not-rentable") continue; // the API has no stock state
    const [model, name] = rowOf[g];
    rows.push({
      model,
      name,
      currency: "usd",
      price_per_hour: st === "garbled" ? "call us" : c.text,
      spot_price: "0.99",
      dynamic_price: null,
      gpu: { number_of_gpus: c.count, description: `${c.count}x ${name}` },
    });
  }
  return o.broken ? JSON.stringify({ data: rows }) : JSON.stringify(rows);
}

function nebiusDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return `${MONTHS[m! - 1]} ${day}, ${y}`;
}

function nebius(p: SynthPage, o: SynthOptions): string {
  const R = "\u00ae";
  const D = "\u2014";
  const parts = [
    "# Compute pricing in Nebius AI Cloud",
    "",
    o.broken ? "Prices in euros apply to all customers." : "Prices in US dollars (USD, \\$) apply to all customers.",
    "",
    "All prices are shown without any applicable taxes, including VAT.",
    "",
  ];
  for (const g of [...GPUS].reverse()) {
    const c = cellOf(p[g], false, (a) => `\\$${a}`, "N/A");
    if (!c) continue;
    const item = `NVIDIA${R} ${g} NVLink`;
    const table = (head: string, price: string) => [
      `    | **${head}** | **Price** | **Per** |`,
      ...(head.startsWith("Item") && !head.includes("before") ? ["    | - | - | - |"] : []),
      `    | ${item} | ${price} | 1 GPU hour |`,
      `    | Preemptible ${item} | \\$0.99 | 1 GPU hour |`,
    ];
    const usdLines = o.blocks
      ? o.blocks.flatMap((b, i) => {
          const t = table(`Item ${D} ${b.head}`, `\\$${b.prices[g] ?? "1.00"}`);
          // the page's divider follows only the first header
          return i === 0 ? [t[0]!, "    | - | - | - |", ...t.slice(1).filter((l) => !l.includes("| - |"))] : t.filter((l) => !l.includes("| - |"));
        })
      : o.dated
        ? [...table(`Item ${D} from ${nebiusDate(o.dated.date)}`, c.text), ...table(`Item ${D} before ${nebiusDate(o.dated.date)}`, `\\$${o.dated.before[g] ?? "1.00"}`)]
        : table("Item", c.text);
    parts.push(
      `#### NVIDIA${R} ${g} NVLink`,
      "",
      "<Tabs>",
      '  <Tab title="USD">',
      ...usdLines,
      "  </Tab>",
      "",
      '  <Tab title="ILS">',
      `    | **Item** | **Price** | **Per** |`,
      "    | - | - | - |",
      `    | ${item} | \u20aa9.99 | 1 GPU hour |`,
      "  </Tab>",
      "</Tabs>",
      "",
    );
  }
  parts.push("### Volumes", "", "Disks.");
  return parts.join("\n");
}

function lambda(p: SynthPage, o: SynthOptions): string {
  const plans: Partial<Record<GpuModel, [string, string]>> = { H100: ["NVIDIA H100 SXM", "80 GB"], B200: ["NVIDIA B200 SXM6", "80 GB"], A100: ["NVIDIA A100 SXM", "80 GB"] };
  const tab = (label: string) => {
    const rows = (Object.entries(plans) as [GpuModel, [string, string]][])
      .map(([g, [plan, vram]]) => {
        const c = cellOf(p[g], false, usd, "Sold out");
        if (!c || String(c.count) + "x" !== label) return "";
        return `<tr class="row" data-plan="${plan}"><th scope="row" data-label="Plan">${plan}</th><td data-label="VRAM/GPU">${vram}</td><td data-label="vCPUs">26</td><td data-label="RAM">225 GiB</td><td data-label="STORAGE">1 TiB SSD</td><td data-label="PRICE/GPU/HR*">${c.text}</td></tr>`;
      })
      .join("");
    // the 40 GB A100 shares its plan name with the 80 GB one (never read)
    const filler = `<tr class="row" data-plan="NVIDIA A100 SXM"><th scope="row" data-label="Plan">NVIDIA A100 SXM</th><td data-label="VRAM/GPU">40 GB</td><td data-label="vCPUs">30</td><td data-label="RAM">220 GiB</td><td data-label="STORAGE">1 TiB SSD</td><td data-label="PRICE/GPU/HR*">$1.99</td></tr>`;
    const price = o.broken ? "PRICE/HR" : "PRICE/GPU/HR*";
    return `<div role="tabpanel" id="tp-${label}" aria-labelledby="t-${label}"><table><thead><tr><th scope="col"><span>Plan</span></th><th scope="col">VRAM/GPU</th><th scope="col">vCPUs</th><th scope="col">RAM</th><th scope="col">STORAGE</th><th scope="col">${price}</th></tr></thead><tbody>${rows}${filler}</tbody></table></div>`;
  };
  const labels = ["8x", "4x", "2x", "1x"];
  return `<!doctype html><html><body><h2>1-Click Clusters</h2><table><tr data-plan="NVIDIA H100 SXM"><td>$2.00</td></tr></table>
<h2 class="t">Instances pricing</h2><div class="tabs"><div role="tablist">${labels
    .map((l) => `<button role="tab" aria-controls="tp-${l}" id="t-${l}">${l}</button>`)
    .join("")}</div><div class="panels">${labels.map(tab).join("")}</div></div></body></html>`;
}

function coreweave(p: SynthPage, o: SynthOptions): string {
  const prods: Record<GpuModel, [string, string]> = {
    H100: ["hgx-h100", "NVIDIA HGX H100"],
    H200: ["hgx-h200", "NVIDIA HGX H200"],
    B200: ["nvidia-b200", "NVIDIA HGX B200"],
    B300: ["nvidia-b300", "NVIDIA HGX B300"],
    A100: ["nvidia-a100", "NVIDIA A100"],
    L40S: ["nvidia-l40s", "NVIDIA L40S"],
  };
  const cols = ["GPU Count", "VRAM (GB)", "vCPUs", "System RAM<br/>(GB)", "Local Storage<br/>(TB)", o.broken ? "Price" : "On-Demand Price (Per Hour)", "Spot Price (Per Hour)"];
  const head =
    '<div class="table-v2-cell table-v2-cell--name"><div class="table-header-text">GPU Model</div></div>' +
    cols.map((h) => `<div class="table-v2-cell"><div class="table-header-text">${h}</div></div>`).join("");
  const row = (slug: string, name: string, c: Cellish, vram = "80") => {
    const isPrice = /^\$/.test(c.text);
    const cell = isPrice ? `<div>${c.text}</div><a href="" class="table-pricing-url"></a>` : `<div></div><a href="/contact-us" class="table-pricing-url">${c.text}</a>`;
    return `<div role="listitem" class="table-row-v2"><div class="table-grid">
<div class="table-v2-cell table-v2-cell--name"><h3 data-product="${slug}" class="table-model-name">${name}</h3></div>
<div class="table-v2-cell"><div>${c.count}</div></div>
<div class="table-v2-cell"><div>${vram}</div></div>
<div class="table-v2-cell"><div>128</div></div>
<div class="table-v2-cell"><div>2,048</div></div>
<div class="table-v2-cell"><div>61.44</div></div>
<div class="table-v2-cell">${cell}</div>
<div class="table-cell-column table-cell-column-left"><h3 data-product="${slug}" class="table-model-name">${name}</h3>
<div class="table-meta-value"><span class="instance-price">On-Demand Price: <span class="item-value">${isPrice ? c.text : ""}</span> / Hour<br/></span><span class="spot-price">Spot Price: <span class="item-value">$9.99</span> / Hour</span></div></div>
<div class="table-v2-cell"><div>$9.99</div></div>
<div class="table-cell-column table-cell-column-right"><div class="table-meta-text"><div class="table-meta-value">${c.count}</div><div>GPU Count</div></div></div>
</div></div>`;
  };
  // Europe shows other prices ($1.00 per instance) so a test can tell which region was read.
  const region = (label: string, eu: boolean) =>
    `<h5><strong class="eyebrow">REGION: ${label}</strong></h5><div class="table-v2"><div class="table-v2-header"><div class="table-grid">${head}</div></div><div role="list">${GPUS.map((g) => {
      const c = cellOf(p[g], true, usd, "Contact sales");
      if (!c) return "";
      return row(prods[g][0], prods[g][1], eu && /^\$/.test(c.text) ? { ...c, text: "$1.00" } : c);
    }).join("")}${row("nvidia-l40", "NVIDIA L40", { text: "$9.20", count: 8 }, "48")}</div></div>`; // the L40: another card, never read
  return `<!doctype html><html><body><section><h1>CoreWeave Cloud Pricing</h1></section>
<section class="section"><header><h2 class="heading">On-demand GPU instances</h2></header><div class="section-content">${region("NORTH AMERICA", false)}</div><div class="section-content">${region("EUROPE", true)}</div></section>
<section><h2>On-demand CPU instances</h2><h5><strong class="eyebrow">REGION: NORTH AMERICA</strong></h5></section></body></html>`;
}

function civo(p: SynthPage, o: SynthOptions): string {
  const tables: Partial<Record<GpuModel, [string, string]>> = {
    H100: ["NVIDIA H100 SXM GPU pricing", "NVIDIA H100 - 80GB"],
    H200: ["NVIDIA H200 SXM GPU pricing", "NVIDIA H200 - 141GB HBM3e"],
    B200: ["NVIDIA B200 GPU pricing", "NVIDIA B200 - 180GB"],
    B300: ["NVIDIA B300 GPU pricing", "NVIDIA B300"],
    L40S: ["NVIDIA L40S 48GB GPU pricing", "NVIDIA L40S - 48GB"],
  };
  const heads = ["Size", "RAM", "vCPU", "Storage", "Data Transfer", "On-demand", o.broken ? "Reserved" : "Commitment"].map((h) => `<th width="10%">${h}</th>`).join("\n");
  const tr = (count: number, label: string, text: string) => `<tr>
<td data-title="Size">Small<div class="product-detail">${count} x ${label}</div></td>
<td data-title="RAM">184 GB</td><td data-title="vCPU">23 </td><td data-title="Storage">200GB <span>NVMe</span></td><td data-title="Data Transfer">FREE</td>
<td data-title="On-demand price" class="pricing-data on-demand-pricing">
<div id="price-value-hourly" data-option="hourly" class="price-value">${text}<span>per hour</span></div>
<div id="price-value-monthly" data-option="monthly" class="price-value hidden">$1,000.00<span>per month</span></div>
</td>
<td data-title="Commitment price" class="pricing-data commitment-pricing"><div id="12_months"><div id="price-value-hourly" data-option="hourly" class="price-value">$1.00<span>per hour</span></div></div></td>
</tr>`;
  // Civo's A100 80GB table: no rule (its form is not stated), never read.
  const out: string[] = [`<table class="pricing-table"><caption>NVIDIA A100 80GB GPU pricing</caption><thead><tr>${heads}</tr></thead><tbody>${tr(1, "NVIDIA A100 - 80GB", "$1.79")}${tr(8, "NVIDIA A100 - 80GB", "$14.32")}</tbody></table>`];
  for (const g of GPUS) {
    const c = cellOf(p[g], true, usd, "N/A");
    const t = tables[g];
    if (!c || !t) continue;
    const [caption, label] = t;
    const rows = c.count === 8 ? tr(1, label, "$9.99") + tr(8, label, c.text) : tr(1, label, c.text);
    out.push(`<table class="pricing-table"><caption>${caption}</caption><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>`);
  }
  return `<!doctype html><html><body>${out.join("\n")}</body></html>`;
}

function hyperstack(p: SynthPage, o: SynthOptions): string {
  const names: Partial<Record<GpuModel, string>> = { H100: "NVIDIA H100 SXM", H200: "NVIDIA H200 SXM", B200: "NVIDIA B200", B300: "NVIDIA B300", A100: "NVIDIA A100 SXM" };
  const heads = ["GPU Model ", "VRAM (GB)", "Max pCPUs per GPU", "Max RAM (GB) per GPU", o.broken ? "Pricing Per Month" : "Pricing Per Hour"];
  const row = (name: string, price: string) =>
    `<div class="page-price_card_row_item df">${[name, "80", "24", "240", price]
      .map((v, i) => `<div class="page-price_card_row_item_col page-price_card_row_item_col${i + 1}">\n<span>${v}</span>\n</div>`)
      .join("\n")}</div>`;
  // PCIe cards (never read): their price cells start with a no-break space, as on the page
  const rows = [row("NVIDIA H100 NVLink", "$2.60"), row("NVIDIA H100", "$2.50"), row("NVIDIA A100 NVLink", "&nbsp;$1.40"), row("NVIDIA A100", "&nbsp;$1.35"), row("NVIDIA L40", "&nbsp;$1.00")];
  for (const g of [...GPUS].reverse()) {
    const c = cellOf(p[g], false, usd, "Sold Out");
    const name = names[g];
    if (c && name) rows.unshift(row(name, c.text));
  }
  return `<!doctype html><html><body><div class="page-price_card df sb"><h3><span>On-Demand GPU</span> Pricing</h3>
<div class="page-price_card_head df">${heads.map((h, i) => `<div class="page-price_card_head_item page-price_card_head_item${i + 1}"><span>${h}</span></div>`).join("\n")}</div>
<div class="page-price_card_row">${rows.join("\n")}</div></div>
<div class="page-price_card df sb"><h3><span>Reservation</span> Pricing</h3>${row("NVIDIA H100 SXM", "$1.00")}</div></body></html>`;
}

function seeweb(p: SynthPage, o: SynthOptions): string {
  const card = (id: number, name: string, form: string, text: string) => `<div id="gpu${id}" class="cardType featured">
<div class="card-header"><h2><span>CLOUD GPU</span> <span class="cardname">${name}</span></h2></div>
<div class="card-body"><div><div><div class="custom-select"><select class="gpu-params" name="card-number" data-os="gpu${id}">
<option value="1">1</option><option value="2">2</option><option value="4">4</option><option value="8">8</option></select></div>
${form} | <span class="gpuRam">80</span> GB GPU RAM</div></div>
<div><div class="main-price"><h3>Hourly Cost</h3>
<p class="hourly"><span>${text}</span> &euro;</p><p class="compare"><span>${text}</span> &euro;</p></div>
<div class="reservation-prices"><p class="hourly_12mnths">12 mths: <span>0.99</span> &euro;/hr</p></div></div></div></div>`;
  const cards = [card(2, "NVIDIA A100", "GPU PCI", "0.99"), card(3, "NVIDIA L4", "GPU PCI", "0.29")];
  const named: Partial<Record<GpuModel, [string, string]>> = { H100: ["NVIDIA H100", "GPU SXM"], H200: ["NVIDIA H200", "GPU SXM"], L40S: ["NVIDIA L40S", "GPU PCI"] };
  let id = 9;
  for (const g of [...GPUS].reverse()) {
    const c = cellOf(p[g], false, (a) => a, "Sold out");
    const n = named[g];
    if (c && n) cards.unshift(card(id++, n[0], n[1], c.text));
  }
  return `<!doctype html><html><body><div class="switch-container"><div class="instances-type">Standard</div>
<label class="form-switch"><input class="js-switch" type="checkbox"${o.broken ? " checked" : ""}><i></i> <div class="instances-type">Spot</div></label></div>
<div class="cont-table config">${cards.join("\n")}</div></body></html>`;
}

function gcore(p: SynthPage, o: SynthOptions): string {
  const rows: string[] = [];
  for (const g of ["H100", "H200"] as GpuModel[]) {
    const c = cellOf(p[g], true, (a) => `\u20ac${a}`, "Contact sales");
    if (!c) continue;
    const sizes = c.count === 8 ? [[1, "\u20ac9.99"], [8, c.text]] : [[1, c.text]];
    for (const [n, text] of sizes) {
      rows.push(`<tr><td><span>${n}\u00d7${g}</span></td><td><span>80&#160;GB</span></td><td><span>24&#160;vCPU / 232&#160;GB RAM</span></td><td><span>1250&#160;GB</span></td><td><span>${text}</span></td><td><a href="#">Get started</a></td></tr>`);
    }
  }
  return `<!doctype html><html><body>
<section id="gpu"><h2>GPU Cloud prices and configuration</h2><table><tr><th>H200</th></tr><tr><td>\u20ac2.73 per GPU</td></tr></table></section>
<section class="gc-compare-table-section" id="virtual-gpu"><div><h2 class="title">Virtual GPU</h2>
<input type="radio" name="currency" value="EUR"${o.broken ? "" : " checked"}><input type="radio" name="currency" value="USD"${o.broken ? " checked" : ""}></div>
<div class="gc-description"> Start with just one GPU. Pay only while powered on. </div>
<figure class="table"><table><thead><tr><th><span>GPU Configuration</span></th><th><span>GPU Memory</span></th><th><span>CPU/RAM</span></th><th><span>Storage</span></th><th><span>Cost per hour</span></th><th></th></tr></thead>
<tbody>${rows.join("")}<tr><td><span>1\u00d7L40S</span></td><td>48 GB</td><td>16 vCPU</td><td>500 GB</td><td><span>\u20ac1.08</span></td><td></td></tr></tbody></table></figure></section></body></html>`;
}

const RENDERERS: Record<string, (p: SynthPage, o: SynthOptions) => string> = {
  p_verda: verda,
  p_nebius: nebius,
  p_lambda: lambda,
  p_coreweave: coreweave,
  p_civo: civo,
  p_hyperstack: hyperstack,
  p_seeweb: seeweb,
  p_gcore: gcore,
};

const REDESIGN_NAMES: Record<GpuModel, string> = {
  H100: "NVIDIA H100 SXM",
  H200: "NVIDIA H200 SXM",
  B200: "NVIDIA B200",
  B300: "NVIDIA B300",
  A100: "NVIDIA A100 SXM 80GB",
  L40S: "NVIDIA L40S",
};

/** The redesigned layout: one card per GPU with the GPU count, the on-demand price per GPU-hour (or per instance-hour
 * when only that is known) and a spot price beside it (a v2 reader must pick the on-demand cell, never the spot one). */
function redesigned(sourceId: string, p: SynthPage): string {
  const cur = sourceId === "p_seeweb" || sourceId === "p_gcore" ? "\u20ac" : "$";
  const cards: string[] = [];
  for (const g of GPUS) {
    const x = p[g];
    if (!x || ("state" in x && x.state === "missing")) continue;
    let count = 8;
    let onDemand: string;
    if ("state" in x) onDemand = x.state === "not-rentable" ? "Sold out" : "call us maybe";
    else if ("raw" in x) {
      count = x.count;
      onDemand = x.raw;
    } else if ("instance" in x) {
      count = x.count;
      onDemand = x.count === 1 ? `${cur}${x.instance} per GPU per hour` : `${cur}${x.instance} per hour for ${x.count} GPUs`;
    } else {
      count = x.count ?? 8;
      onDemand = `${cur}${x.price} per GPU per hour`;
    }
    cards.push(
      `<article class="gpu-card" data-model="${g}"><h4 class="gpu-card__name">${REDESIGN_NAMES[g]}</h4><dl>` +
        `<dt>GPUs per instance</dt><dd class="gpu-card__count">${count}</dd>` +
        `<dt>On-demand</dt><dd class="gpu-card__price gpu-card__price--ondemand">${onDemand}</dd>` +
        `<dt>Spot</dt><dd class="gpu-card__price gpu-card__price--spot">${cur}0.99 per GPU per hour</dd></dl></article>`,
    );
  }
  return `<!doctype html><html><head><title>GPU cloud rates</title></head><body><main id="rates"><h1>Cloud GPU rates</h1>
<section class="gpu-cards" aria-label="On-demand and spot rates">${cards.join("\n")}</section></main></body></html>`;
}

export function renderPage(sourceId: string, page: SynthPage, o: SynthOptions = {}): string {
  const r = RENDERERS[sourceId];
  if (!r) throw new Error(`no synthetic renderer for ${sourceId}`);
  return o.redesigned ? redesigned(sourceId, page) : r(page, o);
}

/** An ECB eurofxref file (hist-90d shape) from rates by date. */
export function renderEcb(rates: Readonly<Record<string, string>>): string {
  const days = Object.keys(rates)
    .sort()
    .reverse()
    .map((d) => `<Cube time="${d}"><Cube currency="USD" rate="${rates[d]}"/><Cube currency="JPY" rate="170.00"/></Cube>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><gesmes:subject>Reference rates</gesmes:subject><gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender><Cube>${days}</Cube></gesmes:Envelope>`;
}
