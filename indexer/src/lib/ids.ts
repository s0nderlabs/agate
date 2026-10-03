// Entity ids (BOTS-SPEC 5.4): addresses lowercase, joins with a hyphen, event rows <block>-<logIndex>.
import { ZERO_ADDRESS } from "./math.ts";

export const low = (a: string): string => a.toLowerCase();
export const isZero = (a: string): boolean => low(a) === ZERO_ADDRESS;
/** null for the zero address (an optional relation or a "none" field), else the lowercase address. */
export const orNone = (a: string): string | undefined => (isZero(a) ? undefined : low(a));

export const eventId = (block: number, logIndex: number): string => `${block}-${logIndex}`;
export const pairId = (a: string, b: string | bigint | number): string => `${low(a)}-${typeof b === "string" ? low(b) : b.toString()}`;
export const positionKey = (series: string, id: bigint): string => `${low(series)}-${id.toString()}`;
export const forwardId = (factory: string, gpuId: string): string => `${low(factory)}-${low(gpuId)}`;
export const fixId = (index: string, gpuId: string, day: number): string => `${low(index)}-${low(gpuId)}-${day}`;
export const orderKey = (market: string, orderId: bigint): string => `${low(market)}-${orderId.toString()}`;
export const levelKey = (market: string, isBuy: boolean, price: bigint): string => `${low(market)}-${isBuy ? "bid" : "ask"}-${price.toString()}`;
export const candleId = (series: string, dayId: number): string => `${low(series)}-${dayId}`;
export const seriesDayId = (series: string, k: number): string => `${low(series)}-${k}`;
