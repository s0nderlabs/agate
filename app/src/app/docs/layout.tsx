import { AppProviders } from "@/components/app/AppProviders";
import { DocsFrame } from "@/components/docs/DocsFrame";
import { getNav } from "@/lib/docs/content";
import { parseConfig } from "@/lib/mock/config";

// The docs are static pages written at build: the shell starts from its default states here, and the saved theme and
// a link's states are applied in the browser (DocsFrame). The frame stays mounted from chapter to chapter.
export default function DocsLayout({ children }: LayoutProps<"/docs">) {
  return (
    <AppProviders initial={parseConfig({})}>
      <DocsFrame nav={getNav()}>{children}</DocsFrame>
    </AppProviders>
  );
}
