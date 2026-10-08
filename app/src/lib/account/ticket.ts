// The ticket's numbers as an Order and as what it showed. Interim: build step 6 moves the order into TradeNumbers
// itself (useTrade.ts), with the typed unit and the band-capped live walk; until then the Review sheet's Confirm
// builds them here. Amounts are decimal strings, cents and 0.0001 GPU-hour steps, never in the buyer's disfavor.
// Pro's resting limits (the real account) are built here too, and listed back as the Open orders view shows them.
import type { TradeNumbers } from "@/components/markets/useTrade";
import type { OpenOrder } from "@/components/trade/OrderTicket";
import type { Gpu, Side } from "@/lib/mock/types";
import { floorCents, floorHours } from "@/lib/size";
import type { LimitOrder, Order, RestingOrder, TicketShown } from "./types";

const ceilCents = (d: number) => Math.ceil(Math.round(d * 1e6) / 1e4) / 100;

export function ticketOrder(n: TradeNumbers): Order {
  const on = { gpu: n.series.gpu, month: n.series.month };
  const gpuHours = floorHours(n.hours).toFixed(4);
  if (n.side === "long") {
    const dollars = ceilCents(n.price * n.hours).toFixed(2);
    return n.daily ? { kind: "openLongDaily", ...on, dollars, minGpuHours: gpuHours, parts: 1 } : { kind: "buyLong", ...on, dollars, minGpuHours: gpuHours };
  }
  return { kind: "openShort", ...on, gpuHours, parts: 1, daily: n.daily, minDollars: floorCents(n.price * n.hours).toFixed(2) };
}

export function ticketShown(n: TradeNumbers): TicketShown {
  return { side: n.side, gpuHours: n.hours, price: n.price, floor: n.series.floor, cap: n.series.cap, daily: n.daily, backNow: n.backNow };
}

/** Whether a price sits on Kuru's tick ($0.01). */
export const onCents = (price: number) => Math.abs(Math.round(price * 100) - price * 100) < 1e-6;

/** A resting limit from the ticket (Pro, the real account): the price in cents (the ticket refuses one off the cent
 *  before it gets here, onCents: never moved for the person), the size in 0.0001 GPU-hour steps, never more than asked. */
export function limitTicketOrder(t: { gpu: Gpu; month: string; side: Side; price: number; gpuHours: number }): LimitOrder {
  return { kind: "placeLimit", gpu: t.gpu, month: t.month, side: t.side, price: (Math.round(t.price * 100) / 100).toFixed(2), gpuHours: floorHours(t.gpuHours).toFixed(4) };
}

/** A resting order as the Open orders view lists it. hold: the test dollars it took from the balance, a bid its price
 *  and an ask the ceiling (the pairs it minted; its price comes back at Kuru when it fills) per GPU-hour. cap: the
 *  month's ceiling, 0 while the markets read is on its way. Kuru orders never pay daily. */
export function restingOpenOrder(o: RestingOrder, cap: number): OpenOrder {
  const hold = Math.round((o.side === "long" ? o.price : cap) * o.q * 100) / 100;
  return { id: o.id, gpu: o.gpu, month: o.month, side: o.side, price: o.price, q: o.q, hold, daily: false, placedAt: o.placedAt };
}
