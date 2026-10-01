// TS port of DateLib (BUILD-SPEC 3): calendar math on dayId, integers only, dayIds >= 0.

export function civilFromDays(z0: number): [number, number, number] {
  const z = z0 + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

export function daysFromCivil(y0: number, m: number, d: number): number {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

export function monthOf(day: number): number {
  const [y, m] = civilFromDays(day);
  return y * 12 + (m - 1);
}
export function firstDayOf(month: number): number {
  return daysFromCivil(Math.floor(month / 12), (month % 12) + 1, 1);
}
export function daysIn(month: number): number {
  return firstDayOf(month + 1) - firstDayOf(month);
}
export function isFirstOfMonth(d: number): boolean {
  return d === firstDayOf(monthOf(d));
}
export function isoOfDay(d: number): string {
  const [y, m, dd] = civilFromDays(d);
  return `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}
