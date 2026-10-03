// The shared shapes of @agate/market (BOTS-SPEC 2, 3, 4), shared by every bot; change them in one place. Amounts are bigint in u (dollars) or token base units; days, months, k are numbers.
import type { Abi, Address, Hex, Log } from "viem";

export type Side = 0 | 1; // LONG, SHORT
export type VenueId = 0 | 1 | 2; // NONE, KURU_V1, OTHER

export interface FactoryEntry {
  name: string;
  index: Address;
  dollar: Address;
  tag: string;
  factory: Address;
  router: Address;
  tPend: number;
  startBlock: bigint;
}
export interface Deployments {
  chainId: number;
  dollar: Address;
  kuru: { router: Address; marginAccount: Address };
  factories: Record<string, FactoryEntry>;
}

export interface SeriesTerms {
  index: Address;
  dollar: Address;
  factory: Address;
  router: Address;
  gpuId: Hex;
  recipeHash: Hex;
  month: number;
  startDay: number;
  n: number;
  startTs: bigint;
  day: number;
  lastResort: bigint;
  floor: bigint;
  cap: bigint;
  x0: bigint;
  bandGrade: number;
  anchorCarried: number;
  anchorMinFresh: number;
  anchorLate: boolean;
}
export interface SeriesState {
  k: number;
  sum: bigint;
  lastX: bigint;
  walked: boolean;
  appliedReal: boolean;
  ledger: bigint;
  nextId: bigint;
  shortSupply: bigint;
}
export interface PositionInfo {
  id: bigint;
  owner: Address;
  payee: Address;
  operator: Address;
  side: Side;
  q: bigint;
  paid: bigint;
  daily: boolean;
  openedK: number;
  open: boolean;
}
export interface IndexRecordView {
  exists: boolean;
  isFinal: boolean;
  value: bigint;
  status: number;
  source?: Address; // the writer whose value it is (absent: unknown, a fake)
  attestedAt?: bigint; // 0: not attested (the attester may still select another writer's value, BOTS-SPEC 3.2)
}
export type KuruOrderStatus = "ACTIVE" | "FILLED" | "CANCELED";
export interface KuruOrder {
  id: bigint;
  owner: Address;
  isBuy: boolean;
  price: bigint; // pricePrecision units = u per token
  remaining: bigint; // size units (x LOT for base units)
  status: KuruOrderStatus;
}
export interface L2Book {
  block: bigint;
  bids: [price: bigint, size: bigint][]; // best first
  asks: [price: bigint, size: bigint][]; // best first
}
export type ListingCheck = { ok: true; floor: bigint; cap: bigint } | { ok: false; error: string };

/** Every view the bots read. The viem implementation batches through Multicall3 at `latest`; fakes implement the
 *  same interface for unit tests. A view that reverts returns null where the type allows it. */
export interface MarketReads {
  blockTime(): Promise<bigint>;
  monBalance(who: Address): Promise<bigint>;
  erc20Balance(token: Address, who: Address): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  currentMonth(factory: Address): Promise<number>;
  gpuIds(factory: Address): Promise<Hex[]>;
  labelOf(factory: Address, gpuId: Hex): Promise<string>;
  kuruRouterOf(factory: Address): Promise<Address>;
  seriesOf(factory: Address, gpuId: Hex, month: number): Promise<Address>; // zero address: not listed
  marketOf(factory: Address, series: Address): Promise<{ market: Address; venue: VenueId }>;
  routerCanUse(factory: Address, series: Address): Promise<boolean>;
  previewListing(factory: Address, gpuId: Hex, month: number): Promise<ListingCheck>;
  terms(series: Address): Promise<SeriesTerms>;
  token(series: Address): Promise<Address>;
  state(series: Address): Promise<SeriesState>;
  previewSync(series: Address): Promise<{ k: number; sum: bigint }>;
  shortOf(series: Address, who: Address): Promise<bigint>;
  position(series: Address, id: bigint): Promise<PositionInfo | null>;
  claimable(series: Address, id: bigint): Promise<bigint | null>;
  indexRecord(index: Address, gpuId: Hex, day: number): Promise<IndexRecordView>;
  indexHead(index: Address, gpuId: Hex): Promise<number | null>; // null: reverted (MockIndex) or failed
  indexClocks(index: Address): Promise<{ day: number; closeGrace: number; tPend: number }>; // cached forever by callers
  indexDayStart(index: Address, day: number): Promise<bigint>;
  kuruMarketState(market: Address): Promise<number | null>;
  kuruBook(market: Address): Promise<L2Book>;
  kuruOrders(market: Address, ids: readonly bigint[]): Promise<KuruOrder[]>; // status by Kuru's rule (BOTS-SPEC 3.6)
  kuruOrderIdCounter(market: Address): Promise<bigint>;
  marginBalance(marginAccount: Address, who: Address, token: Address): Promise<bigint>;
}

export type Shape =
  | "series.mint"
  | "series.redeem"
  | "series.sync"
  | "series.claimMany"
  | "series.settle"
  | "factory.list"
  | "factory.createMarket"
  | "erc20.approve"
  | "kuru.deposit"
  | "kuru.withdraw"
  | "kuru.batchUpdate";

export interface SendSpec {
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  shape: Shape;
  c?: number; // index calls a sync-bearing call makes (BOTS-SPEC 2.4)
  n?: number; // ids in a claimMany
  adds?: number; // orders a batchUpdate places
  cancels?: number; // orders a batchUpdate cancels
  safety?: boolean; // P1's safety actions: ignore the daily budget, respect the floor (BOTS-SPEC 2.6)
  splitsOnCap?: boolean; // the caller answers GAS_CAP with smaller calls: logged, no GAS_CAP alert (BOTS-SPEC 2.9)
  label?: string; // logs only
}
export interface SimResult {
  ok: boolean;
  result?: unknown; // the decoded return value
  error?: string; // decoded error name and arguments; never a URL
}
export interface SendResult {
  ok: boolean;
  sent: boolean; // false: the simulation reverted, a guard refused (GAS_CAP, budget, floor) or dry run
  txHash?: Hex;
  gasLimit?: bigint;
  costWei?: bigint; // gasLimit x effectiveGasPrice (Monad bills the limit)
  logs?: readonly Log[];
  error?: string;
}
export interface Sender {
  readonly from: Address;
  simulate(s: SendSpec): Promise<SimResult>;
  send(s: SendSpec): Promise<SendResult>;
  resetNonce(): void;
}

/** One budget day (UTC calendar day of chain time), persisted as budget-<YYYY-MM-DD>.json. */
export interface BudgetDay {
  day: string;
  budgetWei: bigint;
  spentWei: bigint;
  safetyWei: bigint;
  sends: number;
}
