// Read-only: which series are listed on Monad testnet now (real and demo factory), with market and asks.
import { createAgateClient, monthLabel, TESTNET_DEPLOYMENTS } from "@agate/client";

const demo = { index: "0xfBc7C6913a37749244b081cCF96190C00C165B5E", dollar: TESTNET_DEPLOYMENTS.dollar, tag: "demo", factory: "0xC60f3c52FADd5f376A4874083cf0679723210c2e", router: "0x6481B01fb722efD55019d9A2c8501735a3BefC37", tPend: 210, startBlock: 68038240 };
const deployments = { ...TESTNET_DEPLOYMENTS, factories: { ...TESTNET_DEPLOYMENTS.factories, demo } };
for (const factory of ["real", "demo"]) {
  const c = createAgateClient({ graphqlUrl: null, deployments: deployments as never, factory });
  const month = await c.currentMonth();
  console.log(factory, "currentMonth", monthLabel(month));
  for (const gpu of ["H100", "H200", "B200"] as const) {
    for (const m of [month, month + 1, month + 2]) {
      const s = await c.seriesAt(gpu, monthLabel(m)).catch((e: Error) => e.message);
      if (typeof s === "string") console.log(" ", gpu, monthLabel(m), "->", s);
      else console.log(" ", gpu, monthLabel(m), "series", s.terms.series, "market", s.market, "asks", s.book?.asks.length ?? null, "bids", s.book?.bids.length ?? null);
    }
  }
}
