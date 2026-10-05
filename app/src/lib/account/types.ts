// The one account every screen reads (wallet spec 2.1): who is signed in, what they hold, and what they can do.
// Two implementations sit behind it: the pretend account over the example wallet (pretend.tsx) and the real account
// (Dynamic sign-in, the Kernel main account), which lands with the wallet packages. Types and constants only: nothing
// here pulls the sign-in SDK or @agate/wallet into a bundle.
import type { Gpu, Position, Side } from "@/lib/mock/types";

/** The faucet's drip (AgateDollar.drip): test dollars, once a day per account. */
export const DRIP = 10_000;

/** Where sign-in stands (spec 3.1). Writes are allowed only in "ready". */
export type SignInStatus = "signedOut" | "restoring" | "sendingCode" | "codeSent" | "verifying" | "creating" | "ready" | "signingOut" | "error";

/** Why a code did not sign in: it does not match, it ran out of time, too many tries, or the check could not run. */
export type CodeProblem = "wrong" | "expired" | "tooMany" | "network";

/** The two parts of setting up a new account: making the wallet, then the first 10,000 test dollars. */
export type CreatingPart = "wallet" | "dollars";

/** The step that failed, so "Try again" reruns that one. */
export type SignInErrorAt = "init" | "sendCode" | "verify" | "google" | "wallet";

/** The sign-in machine's step, with what that step carries (spec 3.1). */
export type SignInStep =
  /** email: kept in the field after "Use a different email" */
  | { status: "signedOut"; email?: string }
  /** a restore hint was found on load: the nav shows a skeleton balance, never a "Sign in" flash */
  | { status: "restoring" }
  | { status: "sendingCode"; email: string; resend: boolean }
  /** resent: a new code went out, so the one before no longer works */
  | { status: "codeSent"; email: string; sentAt: number; resent: boolean; problem?: CodeProblem }
  | { status: "verifying"; email: string; via: "code" | "google" }
  /** once per new person: the wallet, then the first drip */
  | { status: "creating"; email: string; part: CreatingPart; startedAt: number }
  /** firstDripFailed: the account is ready but the first test dollars did not arrive */
  | { status: "ready"; firstDripFailed?: boolean }
  | { status: "signingOut" }
  | { status: "error"; at: SignInErrorAt; message: string; email?: string };

/** A decimal string: every amount handed to the client's plan builders (never a JS number). */
export type Decimal = string;

interface OnMarket {
  gpu: Gpu;
  /** "2026-11" */
  month: string;
}

/** What a trade asks for (spec 2.8), one kind per plan builder. The app never passes a payee: it defaults to the
 * account. Guards are optional: a retry after "The price moved" or "Only part of this fills" sets them. */
export type Order =
  | ({ kind: "buyLong"; dollars: Decimal; minGpuHours?: Decimal; maxPrice?: Decimal; slippageBps?: number } & OnMarket)
  | ({ kind: "openLongDaily"; dollars: Decimal; parts: 1; minGpuHours?: Decimal; maxPrice?: Decimal; slippageBps?: number } & OnMarket)
  | ({ kind: "openShort"; gpuHours: Decimal; parts: 1; daily: boolean; minDollars?: Decimal; minPrice?: Decimal; slippageBps?: number } & OnMarket)
  | ({ kind: "sellLong"; gpuHours: Decimal; minDollars?: Decimal } & OnMarket)
  | ({ kind: "closeLongDaily"; positionIds: string[]; minDollars?: Decimal } & OnMarket)
  | ({ kind: "closeShort"; positionIds: string[]; maxDollars?: Decimal } & OnMarket)
  | { kind: "drip" };

/** The client's TradeSummary actions (plan.ts). */
export type TradeAction = "openLong" | "openLongDaily" | "closeLong" | "openShort" | "closeShort" | "closeLongDaily" | "drip";

/** One call of the batch. */
export interface PlanCall {
  to: string;
  value: bigint;
  data: string;
  /** what it does, in plain words ("approve tUSD to the router", "openLong") */
  label: string;
}

/** A planned trade: the one batch to send and what it will do. Shaped like @agate/client's Plan<TradeSummary>
 * (plan.ts) so the real account hands the client's plan through as is; switch to that type once it is on main. */
export interface AccountPlan {
  /** the account the batch is planned for */
  account: string;
  calls: PlanCall[];
  summary: {
    action: TradeAction;
    gpu?: Gpu;
    month?: string;
    /** dollars the batch may take from the account at most (0 for a sale) */
    maxSpend: number;
    /** the router's bound: GPU-hours or dollars at least received (or at most paid, for a buy-back) */
    bound: { kind: "minTokensOut" | "minDollarsOut" | "maxDollarsIn"; value: number };
    gpuHours?: number;
  };
  /** ms since epoch; Confirm plans again when this is older than 15 s */
  plannedAt: number;
}

/** The numbers the ticket showed. The real account plans from the chain and only compares against these; the pretend
 * account makes its plan from them (its bound is the ticket's own walk). */
export interface TicketShown {
  side: Side;
  /** GPU-hours that fill */
  gpuHours: number;
  /** the average fill price */
  price: number;
  floor: number;
  cap: number;
  daily: boolean;
}

/** Sending, step by step: checking the price, the wallet signing, then waiting for Monad. */
export type SendStep = "checking" | "signing" | "sending";
export type OnStep = (step: SendStep, userOpHash?: string) => void;

/** What a trade did, read from its own receipt (spec 2.8 resultOf). The pretend account fills it from the ticket. */
export interface DoneResult {
  action: TradeAction;
  /** null in the pretend account: nothing went to Monad */
  txHash: string | null;
  userOpHash: string | null;
  gpuHours?: number;
  /** dollars that left the account, refunds taken off */
  spent?: number;
  refund?: number;
  /** average price per GPU-hour */
  avg?: number;
  /** pay me daily: the floor paid back at once */
  paidNow?: number;
  received?: number;
  net?: number;
  positionIds?: string[];
  /** drip: test dollars that arrived, and when the next drip opens (ISO) */
  amount?: number;
  nextAt?: string;
}

export interface Account {
  kind: "pretend" | "real";
  /** where sign-in stands; `signIn` is the same step with what it carries (the email, a code problem, an error) */
  status: SignInStatus;
  signIn: SignInStep;
  /** signed in with an account to trade from: writes are allowed only now */
  ready: boolean;
  email: string | null;
  /** the embedded wallet's own address (the real account only, never shown); null otherwise */
  owner: string | null;
  /** the main account (Kernel v3.1, index 0), shown as "Your address"; null until known */
  address: string | null;
  /** test dollars in the account */
  balance: number;
  positions: Position[];
  /** a drip would go through now */
  canDrip: boolean;
  /** ISO time the next drip opens; null when never dripped */
  nextDrip: string | null;
  /** test dollars resting in Kuru's margin account */
  marginBalance: number;
  /** false when a live build lacks its sign-in settings; the pretend account is always set up */
  configured: boolean;

  /** email step: send a code (signedOut or error to sendingCode, then codeSent) */
  startSignIn: (email: string) => void;
  /** code step: any code moves to verifying, then ready, creating (a new person) or back to codeSent with a problem */
  verifyCode: (code: string) => void;
  /** a new code; the one before stops working */
  resendCode: () => void;
  /** back to the email step, the address kept in the field */
  otherEmail: () => void;
  /** Google instead of a code. Signing in with Google while signed in links instead, so sign out first */
  startGoogle: () => void;
  /** reruns the step that failed */
  retry: () => void;
  /** the sign-in sheet closed mid-way: back to signed out, the email kept for the field (a late answer changes nothing) */
  cancelSignIn: () => void;
  signOut: () => Promise<void>;
  /** the day's 10,000 test dollars */
  drip: () => Promise<void>;
  /** plans one trade (nothing is sent); rejects with the client's refusal (WriteError, AmountError, ReadError) */
  plan: (order: Order, shown?: TicketShown) => Promise<AccountPlan>;
  /** sends a plan as one operation and resolves with what it did */
  send: (plan: AccountPlan, onStep?: OnStep) => Promise<DoneResult>;

  /** TEMPORARY bridge (build step 3): today's one-step sign-in sheet signs in at once. It goes when the sign-in sheet
   * walks email, code and creating (build step 5); the real account never has it. */
  signInAtOnce?: (email: string) => void;
}
