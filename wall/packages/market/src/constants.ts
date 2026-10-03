// BOTS-SPEC 1: the market's constants for the bots. Amounts bigint, counts number.
import type { Address } from "viem";

export const U = 1_000_000n; // base units per token, u per dollar
export const LOT = 100n; // token base units per Kuru size unit
export const TICK = 10_000n; // $0.01, the Kuru tick
export const GRID = 50_000n;
export const CENT = 10_000n; // the payer's $0.01 threshold
export const KURU_SIZE_PRECISION = 10_000n;
export const KURU_PRICE_PRECISION = 1_000_000n;
export const KURU_MIN_SIZE = 10_000n; // one token
export const KURU_MAX_SIZE = 10_000_000_000n;
export const KURU_VAULT_PRECISION = 10n ** 18n; // Trade.price = price * 10^12
export const MAX_CLAIM_IDS = 50;
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const MAX_UINT256 = 2n ** 256n - 1n; // the approvals of BOTS-SPEC 3.6

export const VENUE = { NONE: 0, KURU_V1: 1, OTHER: 2 } as const;
export const SIDE = { LONG: 0, SHORT: 1 } as const;
export const KURU_STATE = { ACTIVE: 0, SOFT_PAUSED: 1, HARD_PAUSED: 2 } as const;
export const CLOSE_KIND = { FINAL: 0, WITH_TOKEN: 1, UNSTREAMED: 2 } as const;
