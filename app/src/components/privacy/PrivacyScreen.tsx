"use client";
// The privacy page Google's sign-in consent screen points at (Oct 6 2026). The words are agate's, kept as written
// (only the name capitalised, as everywhere in the app); a change here is a change to the published policy, so
// update "Last updated" with it. Plain text, no tracking, both themes.
import { useScreenTheme } from "@/components/ai/shared";
import { BottomDock } from "@/components/shell/Dock";
import { NavBar } from "@/components/shell/Shell";
import { DocsFooter } from "@/components/docs/DocsFooter";
import { SiteBar } from "@/components/site/SiteBar";
import { useMock } from "@/lib/mock/store";
import s from "./privacy.module.css";

const CONTACT = "alkautsarsol22@gmail.com";

export function PrivacyScreen() {
  const { config } = useMock();
  const tone = useScreenTheme();
  const mail = <a href={`mailto:${CONTACT}`}>{CONTACT}</a>;
  return (
    <div className={`${s.screen} ${tone}`} data-phone={config.phone}>
      {config.siteNav === "before" ? <NavBar active={null} site /> : <SiteBar />}
      <main className={s.main}>
        <article className={s.doc}>
          <h1 className={`${s.title} font-display`}>Privacy</h1>
          <p className={s.updated}>Last updated: October 6, 2026</p>
          <p>Agate is a market for the price of GPU compute. It runs on the Monad test network: everything here uses test dollars, and nothing on Agate is real money.</p>

          <h2>What we keep</h2>
          <ul>
            <li>
              <strong>Your sign-in.</strong> When you sign in with your email or Google account, our sign-in provider, Dynamic, checks it and gives you a wallet. We receive your email address and your wallet addresses. We use them only to run your account.
            </li>
            <li>
              <strong>Your trades.</strong> Trades, positions and payouts are recorded on the Monad test network. Anything recorded there is public by design and cannot be removed by us or anyone else.
            </li>
            <li>
              <strong>Your AI connections.</strong> If you connect an AI app, our server keeps the limits you set, the requests it makes and your approvals, so it can enforce them.
            </li>
          </ul>

          <h2>What we don't do</h2>
          <ul>
            <li>We don't sell your information or share it for advertising.</li>
            <li>We don't use advertising or tracking cookies. The app stores only what it needs to keep you signed in and to remember your settings.</li>
          </ul>

          <h2>Who helps us run Agate</h2>
          <p>Dynamic (sign-in and wallets), ZeroDev (paying network fees for you), Vercel (hosting the app), Vultr (our server), Alchemy (our connection to the network) and Envio (reading the network for history and charts). Each sees only what its job needs.</p>

          <h2>Your choices</h2>
          <p>You can disconnect any AI app at any time from the app. To have your email and account details removed from our systems, write to us at {mail}. Records on the test network stay public.</p>

          <h2>Contact</h2>
          <p>{mail}</p>
        </article>
      </main>
      <DocsFooter />
      {config.phone === "new" && config.siteNav === "before" && <BottomDock active={null} />}
    </div>
  );
}
