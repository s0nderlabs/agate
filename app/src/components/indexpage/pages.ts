// Where each cloud's price is read, and the index contract, as fixed facts for the Index page. Each URL is the page
// the wall's reader fetches (wall/packages/sources/src/pure/recipe.ts, `url` per company), so a row's link is the
// receipt of its price, not a guess at a marketing page. A cloud missing here shows no link.

/** The index contract on Monad testnet: client/src/static.ts TESTNET_INDEXES.production (generated from
 *  contracts/deployments/10143-indexes.json). Copied, not imported: the client's entry pulls viem into the page's
 *  first chunk (lib/data/agate.ts loads it lazily for that reason). view.test.ts checks the two stay equal. */
export const INDEX_CONTRACT = "0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36";

/** Cloud family (as the panel names it) to the public page its price is read from. */
export const PRICE_PAGES: Readonly<Record<string, string>> = {
  Verda: "https://api.verda.com/v1/instance-types",
  Nebius: "https://docs.nebius.com/compute/resources/pricing.md",
  Lambda: "https://lambda.ai/pricing",
  CoreWeave: "https://www.coreweave.com/pricing",
  Civo: "https://www.civo.com/pricing",
  Hyperstack: "https://www.hyperstack.cloud/gpu-pricing",
};

export function pricePage(family: string): string | null {
  return PRICE_PAGES[family] ?? null;
}

/** "civo.com/pricing": the link as it reads in a row (no scheme, no www). */
export function pageLabel(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "");
}
