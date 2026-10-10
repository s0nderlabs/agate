import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppProviders } from "@/components/app/AppProviders";
import { LabScreen } from "@/components/lab/LabScreen";
import { MOCK_CONTROLS, parseConfig } from "@/lib/mock/config";

export const metadata: Metadata = { title: "Agate · Asset lab" };

// Judging only: the asset lab never ships to a hosted build. Its assets draw the live testnet unless the URL picks the
// example data (?source=example), so every number on it is real.
export default async function LabPage({ searchParams }: PageProps<"/lab">) {
  if (!MOCK_CONTROLS) notFound();
  const initial = parseConfig({ source: "live", ...(await searchParams) });
  return (
    <AppProviders initial={initial}>
      <LabScreen />
    </AppProviders>
  );
}
