"use client";
// The AI side of the account: Agate's server (api.ts), the pockets on the chain, and the trading key for the AIs,
// behind one backend, plus the reads the AI screens share (TanStack Query, so /ai, the AI card, the account sheet
// and Positions share one read and poll it). Example data runs it all on the pretend server (fakeServer.ts) and moves
// the pretend wallet's dollars in and out of pockets.
//
// ===== SEAM: live (build steps 9 to 11) =====
// Live swaps three things and nothing on screen: the transport becomes a fetch to NEXT_PUBLIC_AGATE_SERVER with a
// fresh Bearer sessionToken(client); pocket() becomes agate.getWallet(pocket); fund, takeBack and the key calls become
// @agate/wallet's fundPocketCalls (sent from the main account), the pocket client's transfer home,
// ensureAssistantWallet, delegateAssistant, requestStepUp / confirmStepUp, createPocketPermission and revokeAssistant,
// all through lib/account/dynamic.ts and main.ts. Until those land, live uses the pretend backend too.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { MarketGpu } from "@/lib/mock/types";
import { useMock } from "@/lib/mock/store";
import { serverApi, type ServerApi } from "./api";
import { expireRequest, fakeChain, fakeKey, fakeTransport, fakeWorld, forgetWorld, takeOwed, type PocketRead } from "./fakeServer";
import { PRETEND_ADDRESS } from "./pretend";
import { realAiBackend } from "./realAi";
import { useAccount } from "./index";

/** What a pocket's key may do, as signed: the routers in /api/config's order, dollars, unix seconds. */
export interface PermissionAsk {
  routers: string[];
  perTradeCap: number;
  tradesPerDay: number;
  validUntil: number;
}

export interface AiBackend {
  /** what the caches are keyed by: a new person or a new pretend world reads afresh */
  key: string;
  api: ServerApi;
  /** getWallet(pocket): its test dollars and positions */
  pocket: (pocket: string) => Promise<PocketRead>;
  /** test dollars from the main account into a pocket (one operation) */
  fund: (pocket: string, dollars: number) => Promise<void>;
  /** everything in a pocket back to the main account; answers how much moved */
  takeBack: (pocket: string) => Promise<number>;
  tradingKey: {
    /** address: the Assistant's, once made (delegated or not; /api/me lists only delegated ones) */
    state: () => { hasAssistant: boolean; address: string | null; delegated: boolean; canDelegate: boolean };
    ensureAssistant: () => Promise<string>;
    delegate: () => Promise<void>;
    stepUpSend: () => Promise<void>;
    stepUpVerify: (code: string) => Promise<void>;
    /** createPocketPermission: the main wallet signs the pocket's onchain limits once (validUntil in unix seconds,
     *  the same one the grant is registered with) */
    signPermission: (index: number, ask: PermissionAsk) => Promise<{ pocket: string; approval: string; pocketBalance: number }>;
    revoke: () => Promise<void>;
  };
  /** example only: the request runs out mid-way (the "expired" connect outcome) */
  expireRequest: (requestId: string) => void;
  /** make the pretend world now (it is otherwise made by the first read) */
  touch: () => void;
  example: boolean;
  /** the answers come from the pretend server (example data, and live until the real server lands): its redirects
   *  and links are made up, so the browser never follows them */
  fake: boolean;
}

interface AiCtx {
  backend: AiBackend;
  /** reads run only for a signed-in person */
  enabled: boolean;
}

const Ctx = createContext<AiCtx | null>(null);

export function AiProvider({ children }: { children: React.ReactNode }) {
  const { config, shift, loadedFor, resets } = useMock();
  const account = useAccount();
  const main = account.address ?? PRETEND_ADDRESS;
  const email = account.email ?? "you@example.com";
  const source = config.source;
  const example = source === "example";
  const scenario = example ? config.ais : "none";
  const connect = example ? config.connect : "normal";
  const disc = example ? config.disc : "normal";
  // a world seeded again (a reload, another Mock row) owes back the dollars its old pockets took from the wallet;
  // they wait in localStorage (fakeServer pocketOwed) until this source's wallet has loaded and is signed in, so the
  // wallet's own load never writes over them; owing only bumps a counter so the effect below looks again
  const [owedTick, setOwedTick] = useState(0);
  const owe = useCallback(() => setOwedTick((n) => n + 1), []);

  const qcLive = useQueryClient();
  const realWho = account.kind === "real" && account.owner && account.address ? { owner: account.owner, address: account.address } : null;
  const realOwner = realWho?.owner;
  const realAddress = realWho?.address;
  const backend = useMemo<AiBackend>(() => {
    // the real account talks to Agate's server and the chain; its pockets' moves change what both accounts hold
    if (realOwner && realAddress) {
      return realAiBackend({
        owner: realOwner,
        address: realAddress,
        onMoved: () => {
          const again = () => void qcLive.invalidateQueries({ queryKey: ["live"] });
          again();
          window.setTimeout(again, 4_000);
        },
      });
    }
    // example and live each get their own pretend world and their own cached reads: they never mix
    const world = () => fakeWorld({ source, scenario, main, email, connect, disc, onReseed: owe });
    return {
      key: `${source}|${scenario}|${main.toLowerCase()}`,
      api: serverApi(fakeTransport(world)),
      pocket: (p) => fakeChain.pocket(world(), p),
      fund: async (p, dollars) => {
        await fakeChain.fund(world(), p, dollars);
        shift(-dollars);
      },
      takeBack: async (p) => {
        const amount = await fakeChain.takeBack(world(), p);
        shift(amount);
        return amount;
      },
      tradingKey: {
        state: () => fakeKey.state(world()),
        ensureAssistant: () => fakeKey.ensureAssistant(world()),
        delegate: () => fakeKey.delegate(world()),
        stepUpSend: () => fakeKey.stepUpSend(),
        stepUpVerify: (code) => fakeKey.stepUpVerify(world(), code),
        signPermission: (index) => fakeKey.signPermission(world(), index),
        revoke: () => fakeKey.revoke(world()),
      },
      expireRequest: (id) => expireRequest(world(), id),
      touch: () => void world(),
      example,
      fake: true,
    };
  }, [source, scenario, main, email, connect, disc, shift, owe, example, realOwner, realAddress, qcLive]);

  // signed in: the world is made now, not at the first read, so a reload's dollars are back before any screen needs
  // them; then whatever is owed goes into the wallet
  useEffect(() => {
    if (account.ready) backend.touch();
  }, [account.ready, backend]);
  useEffect(() => {
    if (!account.ready || loadedFor !== source) return;
    const dollars = takeOwed(source);
    if (dollars) shift(dollars);
  }, [account.ready, loadedFor, source, owedTick, shift]);

  // Mock Reset: this source's AI world goes with the wallet (its pockets, and the dollars they hold or owe), and the
  // cached reads are thrown away so no screen shows the old AIs
  const qc = useQueryClient();
  const seenResets = useRef(resets);
  useEffect(() => {
    if (resets === seenResets.current) return;
    seenResets.current = resets;
    forgetWorld(source);
    qc.removeQueries({ queryKey: ["server"] });
    qc.removeQueries({ queryKey: ["live", "pocket"] });
  }, [resets, source, qc]);

  const value = useMemo(() => ({ backend, enabled: account.ready }), [backend, account.ready]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAiBackend() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAiBackend outside AiProvider");
  return c;
}

// ===== the shared reads =====

export function useGrants(opts: { poll?: boolean } = {}) {
  const { backend, enabled } = useAiBackend();
  return useQuery({ queryKey: ["server", "grants", backend.key], queryFn: () => backend.api.grants(), enabled, refetchInterval: opts.poll ? 30_000 : false, staleTime: 10_000, retry: 1, retryDelay: 2_000 });
}

export function useActivity(grantId?: string, opts: { poll?: boolean } = {}) {
  const { backend, enabled } = useAiBackend();
  return useQuery({
    queryKey: ["server", "activity", backend.key, grantId ?? "all"],
    queryFn: () => backend.api.activity({ limit: 100, grantId }),
    enabled,
    refetchInterval: opts.poll ? 15_000 : false,
    staleTime: 5_000,
    retry: 1,
    retryDelay: 2_000,
  });
}

export function usePocket(pocket: string | null | undefined) {
  const { backend, enabled } = useAiBackend();
  return useQuery({ queryKey: ["live", "pocket", backend.key, pocket ?? ""], queryFn: () => backend.pocket(pocket!), enabled: enabled && !!pocket, refetchInterval: 60_000, staleTime: 10_000, retry: 1, retryDelay: 2_000 });
}

export function useApprovals(opts: { poll?: boolean } = {}) {
  const { backend, enabled } = useAiBackend();
  return useQuery({ queryKey: ["server", "approvals", backend.key], queryFn: () => backend.api.approvals(), enabled, refetchInterval: opts.poll ? 15_000 : false, staleTime: 5_000, retry: 1, retryDelay: 2_000 });
}

export function useStandingOrders(grantId: string | undefined) {
  const { backend, enabled } = useAiBackend();
  return useQuery({ queryKey: ["server", "orders", backend.key, grantId ?? ""], queryFn: () => backend.api.standingOrders(grantId), enabled: enabled && !!grantId, staleTime: 5_000, retry: 1, retryDelay: 2_000 });
}

/** The AI apps' link for the how-to (needs no sign-in). */
export function useMcpUrl() {
  const { backend } = useAiBackend();
  return useQuery({ queryKey: ["server", "mcp", backend.key], queryFn: () => backend.api.mcpUrl(), staleTime: Infinity, retry: 1 });
}

/** After a write: read the connections, their activity, the pockets and the requests again. */
export function useAiRefresh() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["server"] });
    void qc.invalidateQueries({ queryKey: ["live", "pocket"] });
  }, [qc]);
}

/** The GPUs "Keep my hedge going" can roll (the ones with monthly markets). */
export const ROLL_GPUS: MarketGpu[] = ["H100", "H200", "B200"];
