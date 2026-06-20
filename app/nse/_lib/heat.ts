/**
 * Shared display helpers for the NSE module (heatmap + movers).
 *
 * Finviz-style color scale: deep neutral at 0%, saturated green/red at ±3%.
 * Kept in the NSE module so the whole feature is self-contained — independent of
 * the Dhan /heatmap page (which has its own copy).
 */

const COLOR_STOPS: [number, [number, number, number]][] = [
  [-3, [246, 53, 56]],
  [-2, [191, 64, 69]],
  [-1, [139, 68, 78]],
  [0, [65, 69, 84]],
  [1, [53, 118, 78]],
  [2, [47, 158, 79]],
  [3, [48, 204, 90]],
];

export function heatColor(pct: number): string {
  const v = Math.max(-3, Math.min(3, pct));
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const [p0, c0] = COLOR_STOPS[i];
    const [p1, c1] = COLOR_STOPS[i + 1];
    if (v <= p1) {
      const k = (v - p0) / (p1 - p0);
      const c = c0.map((f, j) => Math.round(f + (c1[j] - f) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  const last = COLOR_STOPS[COLOR_STOPS.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

export const LEGEND_GRADIENT = `linear-gradient(to right, ${COLOR_STOPS.map(
  ([p, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${((p + 3) / 6) * 100}%`,
).join(', ')})`;

/** Indian-format number, max 2 decimals. */
export const fmtNum = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** ₹ in crore from a rupee amount. */
export const fmtCr = (rupees: number) => `₹${(rupees / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;

/** Tailwind text color for a signed %. */
export const pctClass = (pct: number) =>
  pct > 0 ? 'text-emerald-600 dark:text-emerald-400' : pct < 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground';

/** "+1.23%" / "−0.45%". */
export const fmtPct = (pct: number) => `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
