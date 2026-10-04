export const usd = (n: number, digits = 2) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** whole dollars for totals: $5,832 */
export const usd0 = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

export const int = (n: number) => Math.round(n).toLocaleString("en-US");

export const signedUsd = (n: number) => (n >= 0 ? "+" : "−") + usd(Math.abs(n));

export function shortDate(iso: string) {
  const d = new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
