// The ticket's numbers as an Order and as what it showed. Interim: build step 6 moves the order into TradeNumbers
// itself (useTrade.ts), with the typed unit and the band-capped live walk; until then the Review sheet's Confirm
// builds them here. Amounts are decimal strings, cents and 0.0001 GPU-hour steps, never in the buyer's disfavor.
import type { TradeNumbers } from "@/components/markets/useTrade";
import { floorCents, floorHours } from "@/lib/size";
import type { Order, TicketShown } from "./types";

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
  return { side: n.side, gpuHours: n.hours, price: n.price, floor: n.series.floor, cap: n.series.cap, daily: n.daily };
}
