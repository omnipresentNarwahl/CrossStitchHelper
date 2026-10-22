import { luma, type Raster, type RGB } from './raster';

/** Rectangle of grid cells laid over an image (all values in image pixels). */
export interface GridSpec {
  /** Top-left corner of the first cell. */
  x0: number;
  y0: number;
  /** Cell size. */
  cw: number;
  ch: number;
  cols: number;
  rows: number;
}

export interface CellSample {
  rgb: RGB;
  /** False when the cell lies (mostly) outside the image. */
  valid: boolean;
  /** A compact dark mark sits in the middle of the cell, like a chart symbol (not a line crossing it). */
  symbol: boolean;
}

const DARK = 90;

/**
 * Dominant colour of one cell. Symbols, backstitch and grid lines are small and dark,
 * so we ignore near-black pixels and take the most common colour of what's left.
 */
export function sampleCell(img: Raster, x0: number, y0: number, x1: number, y1: number): CellSample {
  const inx = Math.max(1.5, (x1 - x0) * 0.18);
  const iny = Math.max(1.5, (y1 - y0) * 0.18);
  const xa = Math.max(0, Math.ceil(x0 + inx));
  const xb = Math.min(img.width, Math.floor(x1 - inx));
  const ya = Math.max(0, Math.ceil(y0 + iny));
  const yb = Math.min(img.height, Math.floor(y1 - iny));
  const expected = Math.max(1, (x1 - x0 - 2 * inx) * (y1 - y0 - 2 * iny));
  if (xb <= xa || yb <= ya || ((xb - xa) * (yb - ya)) / expected < 0.6) return { rgb: [255, 255, 255], valid: false, symbol: false };

  const d = img.data;
  const counts = new Map<number, number>();
  const all: number[] = [];
  let light = 0;
  let darkCenter = 0, darkRing = 0;
  const cx0 = xa + (xb - xa) * 0.25, cx1 = xb - (xb - xa) * 0.25;
  const cy0 = ya + (yb - ya) * 0.25, cy1 = yb - (yb - ya) * 0.25;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * img.width + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      all.push(r, g, b);
      if (luma(r, g, b) < DARK) {
        if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) darkCenter++;
        else darkRing++;
        continue;
      }
      light++;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const n = all.length / 3;
  if (light < n * 0.12) {
    // A solid dark cell (black/charcoal thread): average everything.
    const sum = [0, 0, 0];
    for (let i = 0; i < all.length; i += 3) for (let c = 0; c < 3; c++) sum[c] += all[i + c];
    return { rgb: sum.map((s) => Math.round(s / n)) as RGB, valid: true, symbol: false };
  }

  let bestKey = 0, bestCount = -1;
  for (const [k, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      bestKey = k;
    }
  }
  const br = bestKey >> 8, bg = (bestKey >> 4) & 15, bb = bestKey & 15;
  const sum = [0, 0, 0];
  let m = 0;
  for (let i = 0; i < all.length; i += 3) {
    const r = all[i], g = all[i + 1], b = all[i + 2];
    if (luma(r, g, b) < DARK) continue;
    if (Math.abs((r >> 4) - br) <= 1 && Math.abs((g >> 4) - bg) <= 1 && Math.abs((b >> 4) - bb) <= 1) {
      sum[0] += r;
      sum[1] += g;
      sum[2] += b;
      m++;
    }
  }
  return { rgb: sum.map((s) => Math.round(s / m)) as RGB, valid: true, symbol: darkCenter >= 2 && darkRing <= 1 };
}

/** Samples every cell of the grid. Returns cols*rows samples, row-major. */
export function sampleGrid(img: Raster, grid: GridSpec): CellSample[] {
  const out: CellSample[] = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const x0 = grid.x0 + c * grid.cw;
      const y0 = grid.y0 + r * grid.ch;
      out.push(sampleCell(img, x0, y0, x0 + grid.cw, y0 + grid.ch));
    }
  }
  return out;
}
