import type { Metadata } from "next";
import { AppProviders } from "@/components/app/AppProviders";
import { PrivacyScreen } from "@/components/privacy/PrivacyScreen";
import { parseConfig } from "@/lib/mock/config";

export const metadata: Metadata = { title: "Privacy · Agate" };

export default async function PrivacyPage({ searchParams }: PageProps<"/privacy">) {
  const initial = parseConfig(await searchParams);
  return (
    <AppProviders initial={initial}>
      <PrivacyScreen />
    </AppProviders>
  );
}
