/** ₹ formatting helpers for the backtest views (Indian digit grouping). */

/** e.g. 12345 → "₹12,345"; -2000 → "-₹2,000". */
export function inr(n: number): string {
  const r = Math.round(n);
  return (r < 0 ? '-₹' : '₹') + Math.abs(r).toLocaleString('en-IN');
}

/** Always shows a sign: 500 → "+₹500"; -300 → "-₹300". */
export function signedInr(n: number): string {
  const r = Math.round(n);
  return (r < 0 ? '-₹' : '+₹') + Math.abs(r).toLocaleString('en-IN');
}
