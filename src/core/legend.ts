import { luma, type Raster, type RGB } from './raster';
import { sampleCell } from './sample';

/** One legend entry: what a stitch of this thread looks like in the chart. */
export interface Swatch {
  rgb: RGB;
  /** Symbol picture, in the same form as `CellSample.sig`. */
  sig: Float32Array;
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
export function inkBoxes(img: Raster): Box[] {
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

/** Area-averages a region of the image down to outW x outH pixels. */
function shrink(img: Raster, x0: number, y0: number, w: number, h: number, outW: number, outH: number): Raster {
  const data = new Uint8ClampedArray(outW * outH * 4);
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const xa = x0 + (ox * w) / outW, xb = x0 + ((ox + 1) * w) / outW;
      const ya = y0 + (oy * h) / outH, yb = y0 + ((oy + 1) * h) / outH;
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = Math.floor(ya); y < Math.ceil(yb); y++) {
        for (let x = Math.floor(xa); x < Math.ceil(xb); x++) {
          if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
          const wgt = (Math.min(x + 1, xb) - Math.max(x, xa)) * (Math.min(y + 1, yb) - Math.max(y, ya));
          if (wgt <= 0) continue;
          const i = (y * img.width + x) * 4;
          sum[0] += img.data[i] * wgt;
          sum[1] += img.data[i + 1] * wgt;
          sum[2] += img.data[i + 2] * wgt;
          n += wgt;
        }
      }
      const o = (oy * outW + ox) * 4;
      data[o] = sum[0] / Math.max(n, 1e-6);
      data[o + 1] = sum[1] / Math.max(n, 1e-6);
      data[o + 2] = sum[2] / Math.max(n, 1e-6);
      data[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data };
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

interface Cand {
  x: number;
  y: number;
  w: number;
  h: number;
  rgb: RGB;
  paper: boolean;
  /** Most of the inside is one flat colour, as a swatch is (lettering is mostly gaps and strokes). */
  solid: boolean;
}

/** Share of the middle of a rectangle that is within a few grey levels of `rgb`. */
function flatShare(img: Raster, x0: number, y0: number, w: number, h: number, rgb: RGB): number {
  const xa = Math.ceil(x0 + w * 0.2), xb = Math.floor(x0 + w * 0.8);
  const ya = Math.ceil(y0 + h * 0.2), yb = Math.floor(y0 + h * 0.8);
  let near = 0, n = 0;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4;
      n++;
      if (Math.abs(img.data[i] - rgb[0]) < 30 && Math.abs(img.data[i + 1] - rgb[1]) < 30 && Math.abs(img.data[i + 2] - rgb[2]) < 30) near++;
    }
  }
  return n ? near / n : 0;
}

/**
 * Finds the colour swatches of a chart's legend: little squares a cell or two wide, lined up in a
 * column or row (often touching, so a stack of them shows up as one tall blob that we split).
 * Each swatch is read the way a chart cell is, so colour and symbol can both be matched.
 * Returns null when no legend is visible.
 */
export function findLegend(img: Raster, cellW: number, cellH = cellW): Swatch[] | null {
  const cell = (cellW + cellH) / 2;
  // Legend swatches are noticeably bigger than a chart cell (about 1.7 times); chart cells themselves are not swatches.
  const lo = cell * 1.35, hi = cell * 2.9;
  const cands: Cand[] = [];
  const push = (x0: number, y0: number, w: number, h: number) => {
    const s = sampleCell(img, x0, y0, x0 + w, y0 + h);
    if (s.valid) cands.push({ x: x0 + w / 2, y: y0 + h / 2, w, h, rgb: s.rgb, paper: isPaperLike(s.rgb), solid: flatShare(img, x0, y0, w, h, s.rgb) >= 0.45 });
  };
  for (const b of inkBoxes(img)) {
    const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
    if (w < lo || h < lo || w > hi * 1.2 && h > hi * 1.2) continue;
    if (w <= hi && h <= hi && w / h >= 0.65 && w / h <= 1.55) {
      if (b.area / (w * h) >= 0.25) push(b.x0, b.y0, w, h);
    } else if (w <= hi && h > w * 1.6 && h <= w * 12 && b.area / (w * h) >= 0.45) {
      // A stack of touching swatches.
      const n = Math.round(h / w);
      for (let k = 0; k < n; k++) push(b.x0, b.y0 + (k * h) / n, w, h / n);
    } else if (h <= hi && w > h * 1.6 && w <= h * 12 && b.area / (w * h) >= 0.6) {
      const n = Math.round(w / h);
      for (let k = 0; k < n; k++) push(b.x0 + (k * w) / n, b.y0, w / n, h);
    }
  }

  const chosen = new Set<Cand>();
  for (const axis of ['x', 'y'] as const) {
    const cross = axis === 'x' ? 'y' : 'x';
    const sorted = [...cands].sort((a, b) => a[axis] - b[axis]);
    const clusters: Cand[][] = [];
    for (const c of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(c[axis] - last[0][axis]) <= cell * 0.3) last.push(c);
      else clusters.push([c]);
    }
    for (const cl of clusters) {
      const coloured = cl.filter((c) => !c.paper && c.solid);
      if (cl.length < 3 || coloured.length < 2) continue;
      const size = median(cl.map((c) => c.w));
      const same = cl.filter((c) => Math.abs(c.w - size) <= size * 0.3);
      if (same.length < 3) continue;
      same.sort((a, b) => a[cross] - b[cross]);
      const gaps = same.slice(1).map((c, i) => c[cross] - same[i][cross]);
      const step = median(gaps);
      // Swatches sit at a steady spacing; stray lettering that happens to line up doesn't.
      for (const c of same) {
        const k = (c[cross] - same[0][cross]) / step;
        if (Math.abs(k - Math.round(k)) >= 0.25) continue;
        if ((!c.paper && c.solid) || c.paper) chosen.add(c);
      }
    }
  }
  if (chosen.size < 3) return null;
  const size = median([...chosen].map((c) => c.w));
  const accepted = [...chosen].filter((c) => Math.abs(c.w - size) <= size * 0.25 && Math.abs(c.h - size) <= size * 0.25);
  if (accepted.length < 3) return null;

  // Short columns of one or two swatches share a row or column with the longer ones.
  for (const c of cands) {
    if (accepted.includes(c) || Math.abs(c.w - size) > size * 0.25 || Math.abs(c.h - size) > size * 0.25) continue;
    if (c.solid && !c.paper && accepted.some((a) => Math.abs(a.y - c.y) <= cell * 0.3)) accepted.push(c);
  }

  return accepted
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((c) => {
      // A swatch is a chart cell drawn bigger. Skip its outline, shrink what's inside to the size the
      // inside of a chart cell has, so the symbol is as soft as the ones in the chart, and read it the same way.
      const inset = 0.22 * Math.min(c.w, c.h);
      const side = Math.max(3, Math.round(cell - 3));
      const small = shrink(img, c.x - c.w / 2 + inset, c.y - c.h / 2 + inset, c.w - 2 * inset, c.h - 2 * inset, side, side);
      const s = sampleCell(small, 0, 0, small.width, small.height, undefined, 0);
      return { rgb: s.valid ? s.rgb : c.rgb, sig: s.sig, x: c.x, y: c.y, w: c.w, h: c.h };
    });
}
