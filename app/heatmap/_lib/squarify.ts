/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk). Pure math, no deps:
 * splits a rectangle into tiles whose areas are proportional to the input
 * values, keeping tiles as close to square as possible (readable labels).
 */

export interface TreemapItem {
  id: string;
  value: number;
}

export interface TreemapRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Worst (largest) aspect ratio a row of areas would have against `side`. */
function worstAspect(areas: number[], side: number): number {
  const sum = areas.reduce((a, b) => a + b, 0);
  if (sum <= 0 || side <= 0) return Number.POSITIVE_INFINITY;
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

/** Average aspect ratio of a full-width row of areas laid out left→right. */
function rowAvgAspect(areas: number[], w: number): number {
  const rowArea = areas.reduce((a, b) => a + b, 0);
  if (rowArea <= 0 || w <= 0) return Number.POSITIVE_INFINITY;
  const rowH = rowArea / w;
  let sum = 0;
  for (const a of areas) {
    const ww = rowH > 0 ? a / rowH : 0;
    sum += ww > 0 ? Math.max(ww / rowH, rowH / ww) : Number.POSITIVE_INFINITY;
  }
  return sum / areas.length;
}

/**
 * Order-PRESERVING strip treemap. Unlike squarify() (which sorts by value so the
 * biggest tile lands top-left), this lays tiles out in the EXACT input order —
 * left→right within a row, rows top→bottom — while still sizing each by value.
 *
 * The heatmap uses it for the sector bands: feed sectors pre-sorted by % change
 * and the map reads best→worst top-to-bottom, yet each band's area still encodes
 * its turnover. Rows are grown greedily while the average aspect ratio improves.
 */
export function squarifyOrdered(items: TreemapItem[], x: number, y: number, w: number, h: number): TreemapRect[] {
  const out: TreemapRect[] = [];
  const positive = items.filter((i) => i.value > 0); // preserves order — no sort
  const total = positive.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || w <= 0 || h <= 0) return out;

  const scale = (w * h) / total;
  const areas = positive.map((i) => ({ id: i.id, area: i.value * scale }));

  let i = 0;
  let cy = y;
  let remainingH = h;
  while (i < areas.length) {
    // Grow the row while adding the next tile lowers the average aspect ratio.
    let count = 1;
    let best = rowAvgAspect([areas[i].area], w);
    while (i + count < areas.length) {
      const next = rowAvgAspect(
        areas.slice(i, i + count + 1).map((a) => a.area),
        w,
      );
      if (next <= best) {
        best = next;
        count++;
      } else break;
    }

    const row = areas.slice(i, i + count);
    const rowArea = row.reduce((s, r) => s + r.area, 0);
    // Last row absorbs any rounding slack so the strip fills to the bottom edge.
    const isLast = i + count >= areas.length;
    const rowH = isLast ? remainingH : Math.min(remainingH, rowArea / w);
    let xx = x;
    for (const r of row) {
      const ww = rowH > 0 ? r.area / rowH : 0;
      out.push({ id: r.id, x: xx, y: cy, w: ww, h: rowH });
      xx += ww;
    }
    cy += rowH;
    remainingH -= rowH;
    i += count;
  }

  return out;
}

export function squarify(items: TreemapItem[], x: number, y: number, w: number, h: number): TreemapRect[] {
  const out: TreemapRect[] = [];
  const positive = items.filter((i) => i.value > 0);
  const total = positive.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || w <= 0 || h <= 0) return out;

  const scale = (w * h) / total;
  let rest = positive
    .slice()
    .sort((a, b) => b.value - a.value)
    .map((i) => ({ id: i.id, area: i.value * scale }));

  let cx = x;
  let cy = y;
  let cw = w;
  let ch = h;

  while (rest.length > 0) {
    const side = Math.min(cw, ch);
    // Grow the row while it improves (lowers) the worst aspect ratio.
    let count = 1;
    let best = worstAspect([rest[0].area], side);
    while (count < rest.length) {
      const next = worstAspect(
        rest.slice(0, count + 1).map((r) => r.area),
        side,
      );
      if (next <= best) {
        best = next;
        count++;
      } else break;
    }

    const row = rest.slice(0, count);
    rest = rest.slice(count);
    const rowArea = row.reduce((s, r) => s + r.area, 0);
    const thickness = side > 0 ? rowArea / side : 0;

    if (cw >= ch) {
      // Vertical strip on the left; tiles stacked top → bottom.
      let yy = cy;
      for (const r of row) {
        const hh = thickness > 0 ? r.area / thickness : 0;
        out.push({ id: r.id, x: cx, y: yy, w: thickness, h: hh });
        yy += hh;
      }
      cx += thickness;
      cw -= thickness;
    } else {
      // Horizontal strip on top; tiles laid left → right.
      let xx = cx;
      for (const r of row) {
        const ww = thickness > 0 ? r.area / thickness : 0;
        out.push({ id: r.id, x: xx, y: cy, w: ww, h: thickness });
        xx += ww;
      }
      cy += thickness;
      ch -= thickness;
    }
  }

  return out;
}
