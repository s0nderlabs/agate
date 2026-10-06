// The one @agate/client of this tab: created on first use, in the browser only, through a dynamic import so viem and
// the ABIs stay out of the first chunk and off the server. The client memoizes what never changes (clocks, GPU ids,
// series terms) for its life, and the public RPC rate-limits hard, so a page must never hold two.
import type { AgateClient } from "@agate/client";

let client: Promise<AgateClient> | null = null;

export function getAgate(): Promise<AgateClient> {
  if (typeof window === "undefined") return Promise.reject(new Error("@agate/client is created in the browser only"));
  if (!client) {
    client = import("@agate/client").then(({ createAgateClient }) => {
      // literal process.env reads, so Next inlines them at build time. Without a GraphQL URL a page on localhost asks
      // the local indexer and a hosted page reads the chain only (the client decides; README). The snapshot (Agate's
      // server: every market and listed month's book in one read) answers markets and books while it is fresh; the
      // client falls back to the chain without it. The RPC may be a comma list (the client falls back down it).
      const graphqlUrl = process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL;
      const rpcUrl = process.env.NEXT_PUBLIC_AGATE_RPC_URL;
      const snapshotUrl = process.env.NEXT_PUBLIC_AGATE_SNAPSHOT_URL;
      return createAgateClient({ ...(graphqlUrl ? { graphqlUrl } : {}), ...(rpcUrl ? { rpcUrl } : {}), ...(snapshotUrl ? { snapshotUrl } : {}) });
    });
    // a failed import (a dropped chunk) is retried on the next call instead of failing forever
    client.catch(() => {
      client = null;
    });
  }
  return client;
}
