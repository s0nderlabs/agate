import type { Metadata } from "next";
import { AppProviders } from "@/components/app/AppProviders";
import { LandingScreen } from "@/components/landing/LandingScreen";
import { parseConfig } from "@/lib/mock/config";
import { withSavedTheme } from "@/lib/mock/savedTheme";

export const metadata: Metadata = { title: "Agate · The price of compute, made tradable" };

export default async function LandingPage({ searchParams }: PageProps<"/">) {
  // live testnet numbers unless the URL picks the example data (?source=example), in the theme picked before
  const initial = parseConfig({ source: "live", ...(await withSavedTheme(searchParams)) });
  return (
    <AppProviders initial={initial}>
      <LandingScreen />
    </AppProviders>
  );
}
