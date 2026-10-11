// Agate runs on Monad's test network, said on every top bar (the app's, the landing's, the site pages'): a hairline
// after the wordmark, then "Testnet" in a quieter ink, so it reads as part of the lockup. It opens Limits, whose first
// line is "Testnet only". href: that page with the bar's own link query.
import Link from "next/link";
import t from "./testnet.module.css";

export function TestnetTag({ href }: { href: string }) {
  return (
    <Link href={href} className={t.tag} aria-label="Testnet, what that means">
      <span>Testnet</span>
    </Link>
  );
}
