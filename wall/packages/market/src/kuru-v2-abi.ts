// Kuru Spot V2 testnet: the subset the market maker uses. Signatures from Kuru's SDK (@toxicflow-labs/ts-sdk 0.3.0,
// contracts auditFixes cdac5ae) and proven live on Oct 10 2026 against the V2 MON/USDC book (deposit, batch place,
// cancel-and-place in one batch with the freed slot reused, cancelAllOrders, withdraw).
// The deployment (docs "Testnet Deployments", markets upgraded Sep 29 2026): AccountCore below; markets are listed by
// Kuru's governance only, quote token Kuru's test USDC 0xA402B424f392EAA05DBc8779e4502A1F6A96fEF1 (no public faucet).
import { type Address, parseAbi } from "viem";

export const KURU_V2_ACCOUNT_CORE: Address = "0xdbaaDe7B42c95399bb1E9614D51B5B9e2cf78038";

/** NativeOrder enums (ISpotOrderBook). */
export const V2_SIDE = { BUY: 0, SELL: 1 } as const;
export const V2_TIF = { GTC: 0, IOC: 1, FOK: 2 } as const;
export const V2_EXEC = { NONE: 0, POST_ONLY: 1 } as const;
/** Slots per maker page; a batch takes at most 62 unique cancels (Relay docs). */
export const V2_SLOTS = 256;
export const V2_MAX_CANCELS = 62;
export const V2_MARKET_ACTIVE = 0;

export const kuruV2OrderBookAbi = parseAbi([
  "struct NativeOrder { uint8 side; uint96 quantity; uint32 price; uint8 tif; uint8 executionInstruction; uint32 minSizeAfterBlock; }",
  "function batch(uint40 userId, NativeOrder[] orders, uint8[] cancelSlotIdxs)",
  "function cancelAllOrders(uint40 userId)",
  "function getOrderId(uint40 userId, uint8 slotIdx) view returns (uint64)",
  "function makerLockedReserves(uint40 userId) view returns (uint256, uint256)",
  "function getL2Book(uint256 levels) view returns (uint32[], uint96[], uint32[], uint96[])",
  "function getMarketParams() view returns (uint32, uint96, uint32, uint96, uint96, uint256, uint256)",
  "function marketState() view returns (uint8)",
  "function baseToken() view returns (address)",
  "function quoteToken() view returns (address)",
  "function quoteTokenDecimals() view returns (uint8)",
  "error PriceError()",
  "error SizeError()",
  "error InsufficientBalance()",
  "error PostOnlyError()",
  "error OrderSlotOccupied()",
]);

export const kuruV2AccountCoreAbi = parseAbi([
  "function deposit(address rootOwner, address token, uint256 amount) payable",
  "function withdraw(uint40 rootAccountId, address token, uint256 amount, address recipient)",
  "function rootAccountIdOf(address) view returns (uint40)",
  "function getBalance(uint40 accountId, address token) view returns (uint256)",
  "function getSpotReservedBalance(uint40 accountId, address token) view returns (uint256)",
  "function isAssetEnabledForSpot(address token) view returns (bool)",
  "error AssetNotEnabled()",
  "error InsufficientBalance()",
  "error AccountNotFound()",
]);
