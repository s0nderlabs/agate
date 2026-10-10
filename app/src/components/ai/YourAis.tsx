"use client";
// "Your AIs" on the Positions page (wallet spec 8.1): one row per connected AI, leading to its card. Their positions
// belong to their pockets and show on those cards; the payouts land in this account. With none yet, one row leads to
// Connected AIs, where connecting starts.
import Link from "next/link";
import { useGrants, usePocket } from "@/lib/account/ai";
import { isLive } from "@/lib/account/aiView";
import type { Grant } from "@/lib/account/api";
import { usd0 } from "@/lib/format";
import { useLinkQuery } from "@/lib/mock/store";

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M4.5 2.5l3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

function Row({ g }: { g: Grant }) {
  const q = useLinkQuery();
  const pocket = usePocket(g.pocket);
  const left = pocket.data?.balance;
  return (
    <Link href={`/app/ai/${encodeURIComponent(g.id)}${q}`}>
      <span>
        {g.label} trades from its own pocket{left === undefined ? "." : `: ${usd0(left)} left.`}
      </span>
      <span>
        <Chevron />
      </span>
    </Link>
  );
}

export function YourAis({ className, titleClass }: { className?: string; titleClass?: string }) {
  const q = useLinkQuery();
  const grants = useGrants();
  const live = (grants.data ?? []).filter((g) => isLive(g));
  return (
    <section className={className} aria-labelledby="your-ais-h">
      <h2 id="your-ais-h" className={titleClass}>
        Your AIs
      </h2>
      <div className="ag-rows" data-tall style={{ marginTop: 8 }}>
        {live.length ? (
          live.map((g) => <Row key={g.id} g={g} />)
        ) : (
          <Link href={`/app/ai${q}`}>
            <span>{grants.isError ? "Can't check your AIs right now." : "Let an AI trade for you, from its own pocket."}</span>
            <span>
              Connected AIs
              <Chevron />
            </span>
          </Link>
        )}
      </div>
    </section>
  );
}
