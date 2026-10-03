// Raw logs (a capture's) to Envio simulate items, registering series, tokens and markets the way the config does:
// static addresses from the deployments file, dynamic ones from SeriesListed and MarketRecorded (venue KURU_V1).
// Logs of other contracts and events the config does not index (Approval, MarketRegistered) are left out.
import { decodeEventLog, type Hex } from "viem";
import { CONTRACT_EVENTS, type Deployments } from "../scripts/config-gen.ts";
import { abiOf, itemFromLog, type ContractName, type RawLog } from "./ev.ts";

const INDEXED = new Map(CONTRACT_EVENTS.map((c) => [c.name, new Set(c.events)]));

export function itemsFromLogs(d: Deployments, logs: readonly RawLog[]) {
  const role = new Map<string, ContractName>();
  for (const f of d.factories) {
    role.set(f.factory, "AgateFactory");
    role.set(f.router, "AgateRouter");
    role.set(f.index, "AgateIndex");
  }
  role.set(d.dollar, "AgateDollar");
  const factories = new Set(d.factories.map((f) => f.factory));
  const items: ReturnType<typeof itemFromLog>[] = [];
  for (const l of logs) {
    const address = l.address.toLowerCase();
    const contract = role.get(address);
    if (!contract) continue;
    let name: string;
    let args: Record<string, unknown>;
    try {
      const dec = decodeEventLog({ abi: abiOf(contract), data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
      name = dec.eventName!;
      args = dec.args as unknown as Record<string, unknown>;
    } catch {
      continue; // an event this ABI does not know
    }
    if (!INDEXED.get(contract)?.has(name)) continue;
    if (contract === "AgateFactory" && factories.has(address)) {
      if (name === "SeriesListed") {
        role.set((args.series as string).toLowerCase(), "AgateSeries");
        role.set((args.token as string).toLowerCase(), "AgateToken");
      } else if (name === "MarketRecorded" && Number(args.venue) === 1) {
        role.set((args.market as string).toLowerCase(), "KuruOrderBook");
      }
    }
    items.push(itemFromLog(contract, l));
  }
  return items;
}
