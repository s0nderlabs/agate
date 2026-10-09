import type { Metadata } from "next";
import { AppProviders } from "@/components/app/AppProviders";
import { PrivacyScreen } from "@/components/privacy/PrivacyScreen";
import { pageConfig } from "@/lib/mock/savedTheme";

export const metadata: Metadata = { title: "Privacy · Agate" };

export default async function PrivacyPage({ searchParams }: PageProps<"/privacy">) {
  const initial = await pageConfig(searchParams);
  return (
    <AppProviders initial={initial}>
      <PrivacyScreen />
    </AppProviders>
  );
}
