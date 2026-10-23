import { luma, type Raster, type RGB } from './raster';
import { sampleCell } from './sample';

export interface Swatch {
  rgb: RGB;
  /** Centre and size in image pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

const isPaperLike = ([r, g, b]: RGB) => Math.min(r, g, b) > 232 && Math.max(r, g, b) - Math.min(r, g, b) < 16;

/** Bounding boxes of 8-connected groups of "ink" pixels (anything that isn't blank paper). */
function inkBoxes(img: Raster): Box[] {
  const { width: w, height: h, data: d } = img;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    ink[i] = luma(r, g, b) < 215 || Math.max(r, g, b) - Math.min(r, g, b) > 20 ? 1 : 0;
  }
  const seen = new Uint8Array(w * h);
  const boxes: Box[] = [];
  const stack: number[] = [];
  for (let s = 0; s < ink.length; s++) {
    if (!ink[s] || seen[s]) continue;
    const box: Box = { x0: w, y0: h, x1: 0, y1: 0, area: 0 };
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      box.area++;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (ink[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    boxes.push(box);
  }
  return boxes;
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

/**
 * Finds the colour swatches of a chart's legend: little squares about the size of a chart
 * cell, lined up in a column or row. Returns null when no legend is visible.
 */
export function findLegend(img: Raster, cellSize: number): Swatch[] | null {
  const lo = cellSize * 0.55, hi = cellSize * 2.6;
  const cands: (Swatch & { paper: boolean })[] = [];
  for (const b of inkBoxes(img)) {
    const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
    if (w < lo || h < lo || w > hi || h > hi) continue;
    if (w / h < 0.65 || w / h > 1.55 || b.area / (w * h) < 0.25) continue;
    const s = sampleCell(img, b.x0, b.y0, b.x1 + 1, b.y1 + 1);
    if (!s.valid) continue;
    cands.push({ rgb: s.rgb, x: (b.x0 + b.x1 + 1) / 2, y: (b.y0 + b.y1 + 1) / 2, w, h, paper: isPaperLike(s.rgb) });
  }

  const chosen = new Set<(typeof cands)[number]>();
  for (const axis of ['x', 'y'] as const) {
    const cross = axis === 'x' ? 'y' : 'x';
    const sorted = [...cands].sort((a, b) => a[axis] - b[axis]);
    const clusters: (typeof cands)[] = [];
    for (const c of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(c[axis] - last[0][axis]) <= cellSize * 0.3) last.push(c);
      else clusters.push([c]);
    }
    for (const cl of clusters) {
      const coloured = cl.filter((c) => !c.paper);
      if (coloured.length < 3) continue;
      const size = median(coloured.map((c) => c.w));
      const same = coloured.filter((c) => Math.abs(c.w - size) <= size * 0.3);
      if (same.length < 3) continue;
      same.sort((a, b) => a[cross] - b[cross]);
      const gaps = same.slice(1).map((c, i) => c[cross] - same[i][cross]);
      const step = median(gaps);
      same.forEach((c) => chosen.add(c));
      // A white swatch is just an outline, so only accept it where the list's rhythm says there should be one.
      for (const c of cl) {
        if (!c.paper || Math.abs(c.w - size) > size * 0.3) continue;
        const k = (c[cross] - same[0][cross]) / step;
        if (Math.abs(k - Math.round(k)) < 0.2) chosen.add(c);
      }
    }
  }
  // Swatches are all the same size; stray lettering that happened to line up is not.
  const all = [...chosen];
  if (all.length < 3) return null;
  const size = median(all.map((c) => c.w));
  const swatches = all.filter((c) => Math.abs(c.w - size) <= size * 0.25 && Math.abs(c.h - size) <= size * 0.25);
  if (swatches.length < 3) return null;
  return swatches
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map(({ rgb, x, y, w, h }) => ({ rgb, x, y, w, h }));
}
