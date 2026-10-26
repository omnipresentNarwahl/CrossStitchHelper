import type { Lines } from './lines';
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

/** The symbol inside a cell is summarised on a SIG_N × SIG_N grid. */
export const SIG_N = 5;

export interface CellSample {
  /** Dominant fill colour. */
  rgb: RGB;
  /** False when the cell lies (mostly) outside the image. */
  valid: boolean;
  /**
   * How each part of the cell differs from its fill: -1 (much darker, like a black symbol) to
   * +1 (much lighter, like a white symbol on black thread). All zeros for a plain cell.
   */
  sig: Float32Array;
  /** A compact dark mark sits in the middle of the cell, like a chart symbol (not a line crossing it). */
  symbol: boolean;
}

const DARK = 90;

const blankSig = () => new Float32Array(SIG_N * SIG_N);

/**
 * Looks at one cell: its dominant fill colour (ignoring small dark symbols, backstitch and grid
 * lines) and a coarse picture of the symbol on it.
 */
/** Extra margin (pixels) to keep clear of each side, e.g. next to a heavy grid line. */
export interface Margins {
  l: number;
  t: number;
  r: number;
  b: number;
}

export function sampleCell(img: Raster, x0: number, y0: number, x1: number, y1: number, extra?: Margins, inset?: number): CellSample {
  const inx = inset ?? Math.max(1.5, (x1 - x0) * 0.18);
  const iny = inset ?? Math.max(1.5, (y1 - y0) * 0.18);
  // Interior of the cell, kept clear of the grid lines (and of heavy lines' blur).
  const ax0 = x0 + inx + (extra?.l ?? 0), ax1 = x1 - inx - (extra?.r ?? 0);
  const ay0 = y0 + iny + (extra?.t ?? 0), ay1 = y1 - iny - (extra?.b ?? 0);
  const inside = Math.max(0, Math.min(img.width, ax1) - Math.max(0, ax0)) * Math.max(0, Math.min(img.height, ay1) - Math.max(0, ay0));
  if (ax1 - ax0 < 0.5 || ay1 - ay0 < 0.5 || inside < 0.6 * (ax1 - ax0) * (ay1 - ay0)) {
    return { rgb: [255, 255, 255], valid: false, sig: blankSig(), symbol: false };
  }
  // At least a 2x2 window, even for tiny cells.
  const xa = Math.max(0, Math.round(ax0)), ya = Math.max(0, Math.round(ay0));
  const xb = Math.min(img.width, Math.max(xa + 2, Math.round(ax1)));
  const yb = Math.min(img.height, Math.max(ya + 2, Math.round(ay1)));
  if (xb <= xa || yb <= ya) return { rgb: [255, 255, 255], valid: false, sig: blankSig(), symbol: false };

  const d = img.data;
  const w = xb - xa, h = yb - ya;
  const n = w * h;
  const px = new Uint8Array(n * 3);
  const lum = new Float32Array(n);
  const counts = new Map<number, number>();
  let k = 0;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++, k++) {
      const i = (y * img.width + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      px[k * 3] = r;
      px[k * 3 + 1] = g;
      px[k * 3 + 2] = b;
      lum[k] = luma(r, g, b);
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  // Most common colour. A dark one only wins if it fills most of the cell: thin backstitch
  // lines can be dark too, but a black thread fills the square.
  let bestKey = -1, bestCount = -1, bestLight = -1, bestLightCount = -1;
  for (const [key, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      bestKey = key;
    }
    const lr = ((key >> 8) << 4) + 8, lg = (((key >> 4) & 15) << 4) + 8, lb = ((key & 15) << 4) + 8;
    if (luma(lr, lg, lb) >= DARK && c > bestLightCount) {
      bestLightCount = c;
      bestLight = key;
    }
  }
  const darkWins = luma(((bestKey >> 8) << 4) + 8, (((bestKey >> 4) & 15) << 4) + 8, ((bestKey & 15) << 4) + 8) < DARK;
  if (darkWins && bestLight >= 0 && bestCount < n * 0.55 && bestLightCount >= n * 0.25) bestKey = bestLight;

  const br = bestKey >> 8, bg = (bestKey >> 4) & 15, bb = bestKey & 15;
  const sum = [0, 0, 0];
  let m = 0;
  for (let i = 0; i < n; i++) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    if (Math.abs((r >> 4) - br) <= 1 && Math.abs((g >> 4) - bg) <= 1 && Math.abs((b >> 4) - bb) <= 1) {
      sum[0] += r;
      sum[1] += g;
      sum[2] += b;
      m++;
    }
  }
  const rgb = sum.map((s) => Math.round(s / Math.max(1, m))) as RGB;
  const fillLuma = luma(rgb[0], rgb[1], rgb[2]);

  // Symbol picture: how far each region of the cell departs from the fill.
  const binSum = new Float32Array(SIG_N * SIG_N);
  const binCount = new Uint16Array(SIG_N * SIG_N);
  k = 0;
  for (let y = 0; y < h; y++) {
    const by = Math.min(SIG_N - 1, Math.floor(((y + 0.5) / h) * SIG_N));
    for (let x = 0; x < w; x++, k++) {
      const bx = Math.min(SIG_N - 1, Math.floor(((x + 0.5) / w) * SIG_N));
      binSum[by * SIG_N + bx] += lum[k];
      binCount[by * SIG_N + bx]++;
    }
  }
  const sig = new Float32Array(SIG_N * SIG_N);
  for (let b = 0; b < sig.length; b++) {
    const mean = binCount[b] ? binSum[b] / binCount[b] : fillLuma;
    sig[b] = Math.max(-1, Math.min(1, (mean - fillLuma) / 70));
  }
  // "Symbol on a plain cell": clearly dark pixels huddled in the middle, none out near the edges
  // (a backstitch line or the heavy grid would reach the edges).
  let darkCenter = 0, darkRing = 0;
  const cx0 = xa + w * 0.25, cx1 = xb - w * 0.25, cy0 = ya + h * 0.25, cy1 = yb - h * 0.25;
  k = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++, k++) {
      if (lum[k] >= DARK) continue;
      if (xa + x >= cx0 && xa + x < cx1 && ya + y >= cy0 && ya + y < cy1) darkCenter++;
      else darkRing++;
    }
  }
  return { rgb, valid: true, sig, symbol: fillLuma >= DARK && darkCenter >= 2 && darkRing <= 1 };
}

/** Samples every cell of the grid. Returns cols*rows samples, row-major. */
export function sampleGrid(img: Raster, grid: GridSpec, lines?: Lines): CellSample[] {
  const out: CellSample[] = [];
  const bold = 1.6; // heavy lines are wider and blur further into the cell
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      if (lines) {
        const extra: Margins = {
          l: lines.boldX[c] ? bold : 0,
          r: lines.boldX[c + 1] ? bold : 0,
          t: lines.boldY[r] ? bold : 0,
          b: lines.boldY[r + 1] ? bold : 0,
        };
        out.push(sampleCell(img, lines.xs[c], lines.ys[r], lines.xs[c + 1], lines.ys[r + 1], extra));
      } else {
        const x0 = grid.x0 + c * grid.cw;
        const y0 = grid.y0 + r * grid.ch;
        out.push(sampleCell(img, x0, y0, x0 + grid.cw, y0 + grid.ch));
      }
    }
  }
  return out;
}
