// The ABIs the indexer reads (BOTS-SPEC 0.2 item 7, 5.7 item 1): the market contracts and the index interface from a
// Foundry build, and Kuru's OrderBook subset of BOTS-SPEC Appendix C. Pure (node fs only), shared by gen-abis.ts and
// the drift test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi } from "viem";

/** abis/<file>.json <- <forge out>/<sol>/<contract>.json */
export const FORGE_ABIS = {
  AgateFactory: "AgateFactory.sol/AgateFactory.json",
  AgateSeries: "AgateSeries.sol/AgateSeries.json",
  AgateToken: "AgateToken.sol/AgateToken.json",
  AgateRouter: "AgateRouter.sol/AgateRouter.json",
  AgateDollar: "AgateDollar.sol/AgateDollar.json",
  IAgateIndex: "IAgateIndex.sol/IAgateIndex.json",
} as const;

// Kuru V1 testnet, BOTS-SPEC Appendix C (every selector and topic found in the deployed implementation, Appendix D).
export const kuruOrderBookAbi = parseAbi([
  "function addBuyOrder(uint32 _price, uint96 size, bool _postOnly)",
  "function addSellOrder(uint32 _price, uint96 _size, bool _postOnly)",
  "function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)",
  "function batchCancelOrders(uint40[] _orderIds)",
  "function batchCancelOrdersNoRevert(uint40[] _orderIds)",
  "function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function getL2Book() view returns (bytes)",
  "function getL2Book(uint32 _bidPricePoints, uint32 _askPricePoints) view returns (bytes)",
  "function bestBidAsk() view returns (uint256, uint256)",
  "function marketState() view returns (uint8)",
  "function getMarketParams() view returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)",
  "function s_orders(uint40) view returns (address ownerAddress, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)",
  "function s_buyPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "function s_sellPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "function s_orderIdCounter() view returns (uint40)",
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
  "event OrderCanceled(uint40 orderId, address owner, uint32 price, uint96 size, bool isBuy)",
  "event OrdersCanceled(uint40[] orderId, address owner)",
  "event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)",
  "event FlipOrderCreated(uint40 orderId, uint40 flippedId, address owner, uint96 size, uint32 price, uint32 flippedPrice, bool isBuy)",
  "event FlippedOrderCreated(uint40 orderId, uint40 flippedId, address owner, uint96 size, uint32 price, uint32 flippedPrice, bool isBuy)",
  "event FlipOrderUpdated(uint40 orderId, uint96 size)",
  "event FlipOrdersCanceled(uint40[] orderIds, address owner)",
  "event MarketStateUpdated(uint8 previousState, uint8 newState)",
  "error MarketStateError()",
  "error OnlyOwnerAllowedError()",
  "error OrderAlreadyFilledOrCancelled()",
  "error PostOnlyError()",
  "error PriceError()",
  "error SizeError()",
  "error TickSizeError()",
  "error LengthMismatch()",
  "error InsufficientLiquidity()",
  "error SlippageExceeded()",
]);

/** The forge out folder: AGATE_FORGE_OUT (a builder's own FOUNDRY_OUT), else contracts/out. */
export function forgeOut(): string {
  return process.env.AGATE_FORGE_OUT ?? join(import.meta.dirname, "../../contracts/out");
}

/** Every abis/*.json, keyed by file name without .json. */
export function buildAbis(out = forgeOut()): Record<string, readonly unknown[]> {
  const abis: Record<string, readonly unknown[]> = {};
  for (const [name, rel] of Object.entries(FORGE_ABIS)) {
    abis[name] = (JSON.parse(readFileSync(join(out, rel), "utf8")) as { abi: unknown[] }).abi;
  }
  abis.KuruOrderBook = kuruOrderBookAbi;
  return abis;
}

export function abiJson(abi: readonly unknown[]): string {
  return `${JSON.stringify(abi, null, 2)}\n`;
}
