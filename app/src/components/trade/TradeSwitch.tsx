"use client";
// Picks the trade screen build from mock controls: round 4 (latest) or the frozen round 3 snapshot.
import { useMock } from "@/lib/mock/store";
import { TradeScreen } from "./TradeScreen";
import { TradeScreen as TradeScreenR3 } from "./r3/TradeScreen";

export function TradeSwitch() {
  const { config } = useMock();
  return config.pass === "r3" ? <TradeScreenR3 /> : <TradeScreen />;
}
