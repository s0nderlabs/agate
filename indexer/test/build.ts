// Builders for the unit tests' events: every one goes through ev() (a real ABI encoding, decoded back).
import { daysIn, firstDayOf } from "../src/lib/math.ts";
import { ev } from "./ev.ts";
import { DEMO, H100 } from "./world.ts";

export const DEMO_DAY = 600;
export const T_SEP20 = 1_790_000_000; // chain time of the demo clock's Sep 20 2026, 00:00
export const SEP20 = firstDayOf(2026 * 12 + 8) + 19;
export const DEMO_ANCHOR = BigInt(T_SEP20) - BigInt(SEP20) * BigInt(DEMO_DAY);
export const OCT = 2026 * 12 + 9;
export const NOV = 2026 * 12 + 10;
export const DEC = 2026 * 12 + 11;
/** Chain time of the start of demo day d. */
export const demoTs = (d: number) => Number(DEMO_ANCHOR + BigInt(d) * BigInt(DEMO_DAY));

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const Mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface ListOpts {
  series: string;
  token: string;
  block: number;
  ts?: number;
  month?: number;
  gpu?: string;
  label?: string;
  factory?: typeof DEMO;
  floor?: bigint;
  cap?: bigint;
  bandGrade?: number;
}

/** SeriesListed exactly as AgateFactory.list emits it (NameLib's name and symbol, the factory's clock). */
export function listed(o: ListOpts) {
  const f = o.factory ?? DEMO;
  const month = o.month ?? NOV;
  const day = f.name === "demo" ? DEMO_DAY : 86_400;
  const anchor = f.name === "demo" ? DEMO_ANCHOR : 0n;
  const startDay = firstDayOf(month);
  const label = o.label ?? "H100";
  const y = Math.floor(month / 12);
  const m = month % 12;
  const tagLetter = f.tag ? f.tag[0] : "";
  return ev(
    "AgateFactory",
    "SeriesListed",
    {
      series: o.series,
      gpuId: o.gpu ?? H100,
      month,
      token: o.token,
      startDay,
      n: daysIn(month),
      startTs: anchor + BigInt(startDay) * BigInt(day),
      day,
      lastResort: BigInt(Math.max(60 * day, 3 * 86_400)),
      floor: o.floor ?? 1_000_000n,
      cap: o.cap ?? 4_000_000n,
      x0: 2_000_000n,
      bandGrade: o.bandGrade ?? 0,
      anchorCarried: 0,
      anchorMinFresh: 5,
      anchorLate: false,
      name: `agate ${label} ${Mon[m]} ${y}${f.tag ? ` ${f.tag}` : ""}`,
      symbol: `${tagLetter}${label}-${MON[m]}${String(y % 100).padStart(2, "0")}`,
    },
    { src: f.factory, block: o.block, ts: o.ts ?? demoTs(SEP20) + 100 },
  );
}

export function recorded(o: { series: string; market: string; block: number; ts?: number; venue?: number; previous?: string; by?: string; factory?: typeof DEMO; created?: boolean }) {
  return ev(
    "AgateFactory",
    "MarketRecorded",
    {
      series: o.series,
      market: o.market,
      venue: o.venue ?? 1,
      created: o.created ?? true,
      by: o.by ?? "0x00000000000000000000000000000000000000b0",
      previous: o.previous ?? "0x0000000000000000000000000000000000000000",
    },
    { src: (o.factory ?? DEMO).factory, block: o.block, ts: o.ts ?? demoTs(SEP20) + 200 },
  );
}

