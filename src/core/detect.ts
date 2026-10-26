import { luma, type Raster } from './raster';

/** Where the grid lines of a chart image sit along both axes. */
export interface Lattice {
  /** Cell size in image pixels. */
  cw: number;
  ch: number;
  /** Position of some grid line (in [0, cw) / [0, ch)); others are at ox + k*cw. */
  ox: number;
  oy: number;
  /** 0..1, how strongly the image looks like a regular grid. */
  confidence: number;
}

interface AxisFit {
  period: number;
  phase: number;
  confidence: number;
}

function lumaPlane(img: Raster): Float32Array {
  const n = img.width * img.height;
  const g = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) g[i] = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  return g;
}

/**
 * How "line-like" each column (axis 'x') or row ('y') is: the average amount by which
 * it is darker than the pixels three steps to either side. Thin grid lines light up,
 * flat colour areas and sparse backstitch don't.
 */
function lineProfile(g: Float32Array, w: number, h: number, axis: 'x' | 'y'): Float32Array {
  const n = axis === 'x' ? w : h;
  const m = axis === 'x' ? h : w;
  const p = new Float32Array(n);
  const at = (i: number, j: number) => (axis === 'x' ? g[j * w + i] : g[i * w + j]);
  for (let i = 3; i < n - 3; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) {
      const dip = (at(i - 3, j) + at(i + 3, j)) / 2 - at(i, j);
      if (dip > 0) s += dip;
    }
    p[i] = s / m;
  }
  return p;
}

/** `range` limits the cell sizes considered (pixels), e.g. when the user hinted roughly how big a square is. */
/**
 * For charts drawn without grid lines: how strongly colours change between the pixels either
 * side of each column or row. Square edges line up on the grid, so they repeat with its period.
 */
function edgeProfile(img: Raster, axis: 'x' | 'y'): Float32Array {
  const { width: w, height: h, data: d } = img;
  const n = axis === 'x' ? w : h;
  const m = axis === 'x' ? h : w;
  const p = new Float32Array(n);
  const idx = (i: number, j: number) => (axis === 'x' ? j * w + i : i * w + j) * 4;
  for (let i = 1; i < n - 1; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) {
      const a = idx(i - 1, j), b = idx(i + 1, j);
      s += Math.max(Math.abs(d[a] - d[b]), Math.abs(d[a + 1] - d[b + 1]), Math.abs(d[a + 2] - d[b + 2]));
    }
    p[i] = s / m;
  }
  return p;
}

function fitAxis(p: Float32Array, range?: [number, number]): AxisFit | null {
  const n = p.length;
  let total = 0;
  for (const v of p) total += v;
  if (total <= 0) return null;
  const mean = total / n;
  const q = Float32Array.from(p, (v) => v - mean);

  const tMin = Math.max(4, range?.[0] ?? 4);
  const tMax = Math.min(range?.[1] ?? 150, n / 2.5);
  if (tMax <= tMin) return null;
  const periods: number[] = [];
  const mags: number[] = [];
  for (let t = tMin; t <= tMax; t *= 1.002) {
    let re = 0, im = 0;
    const k = (2 * Math.PI) / t;
    for (let i = 0; i < n; i++) {
      re += q[i] * Math.cos(k * i);
      im -= q[i] * Math.sin(k * i);
    }
    periods.push(t);
    mags.push(Math.hypot(re, im));
  }
  let best = 0;
  for (let i = 1; i < mags.length; i++) if (mags[i] > mags[best]) best = i;
  const maxMag = mags[best];

  // A grid of period T also scores at T/2, T/3...: take the longest strong period.
  let pick = best;
  for (let i = 1; i < mags.length - 1; i++) {
    const isPeak = mags[i] >= mags[i - 1] && mags[i] >= mags[i + 1];
    if (isPeak && mags[i] >= 0.7 * maxMag && periods[i] > periods[pick]) pick = i;
  }

  // Refine the period on a fine local scan, then read off the phase.
  let period = periods[pick];
  let bestMag = 0;
  let bestRe = 0, bestIm = 0;
  for (let t = period * 0.99; t <= period * 1.01; t *= 1.00005) {
    let re = 0, im = 0;
    const k = (2 * Math.PI) / t;
    for (let i = 0; i < n; i++) {
      re += q[i] * Math.cos(k * i);
      im -= q[i] * Math.sin(k * i);
    }
    const m = Math.hypot(re, im);
    if (m > bestMag) {
      bestMag = m;
      period = t;
      bestRe = re;
      bestIm = im;
    }
  }
  const theta = Math.atan2(bestIm, bestRe);
  let phase = (-theta * period) / (2 * Math.PI);
  phase = ((phase % period) + period) % period;
  return { period, phase, confidence: Math.min(1, bestMag / total) };
}

export interface DetectOptions {
  /** Roughly how big one square is, in pixels, if the user told us. */
  cellHint?: { w: number; h: number };
}

const HINT_SLACK = 0.3;

function fitPair(img: Raster, g: Float32Array, kind: 'lines' | 'edges', opts: DetectOptions): Lattice | null {
  const px = kind === 'lines' ? lineProfile(g, img.width, img.height, 'x') : edgeProfile(img, 'x');
  const py = kind === 'lines' ? lineProfile(g, img.width, img.height, 'y') : edgeProfile(img, 'y');
  const hint = opts.cellHint;
  const fx = fitAxis(px, hint ? [hint.w * (1 - HINT_SLACK), hint.w * (1 + HINT_SLACK)] : undefined);
  const fy = fitAxis(py, hint ? [hint.h * (1 - HINT_SLACK), hint.h * (1 + HINT_SLACK)] : undefined);
  if (!fx || !fy) return null;
  return { cw: fx.period, ch: fy.period, ox: fx.phase, oy: fy.phase, confidence: Math.min(fx.confidence, fy.confidence) };
}

/**
 * Finds the regular grid in a chart image, or null if nothing grid-like is there. Looks for faint
 * grid lines first and falls back to the edges between coloured squares.
 */
export function detectLattice(img: Raster, opts: DetectOptions = {}): Lattice | null {
  const g = lumaPlane(img);
  const lines = fitPair(img, g, 'lines', opts);
  if (lines && lines.confidence >= 0.25) return lines;
  const edges = fitPair(img, g, 'edges', opts);
  if (edges && (!lines || edges.confidence > lines.confidence)) return edges;
  return lines;
}

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Copies a rectangle of an image out as its own image. */
export function cropRaster(img: Raster, r: Region): Raster {
  const x0 = Math.max(0, Math.floor(r.x0)), y0 = Math.max(0, Math.floor(r.y0));
  const x1 = Math.min(img.width, Math.ceil(r.x1)), y1 = Math.min(img.height, Math.ceil(r.y1));
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

/**
 * Detects the grid using only the part of the image the user pointed at (and optionally how
 * big a square is). The result's offsets are in whole-image pixels.
 */
export function detectLatticeIn(img: Raster, region: Region, opts: DetectOptions = {}): Lattice | null {
  const sub = cropRaster(img, region);
  if (sub.width < 12 || sub.height < 12) return null;
  const lat = detectLattice(sub, opts);
  if (!lat) return null;
  const wrap = (v: number, period: number) => ((v % period) + period) % period;
  return { ...lat, ox: wrap(lat.ox + Math.floor(region.x0), lat.cw), oy: wrap(lat.oy + Math.floor(region.y0), lat.ch) };
}

/** Rounds a user-drawn rectangle to the nearest grid lines. Returns null if it is smaller than one square. */
export function snapRegionToLattice(lat: Lattice, r: Region): { x0: number; y0: number; cols: number; rows: number } | null {
  const c0 = Math.round((r.x0 - lat.ox) / lat.cw), c1 = Math.round((r.x1 - lat.ox) / lat.cw);
  const r0 = Math.round((r.y0 - lat.oy) / lat.ch), r1 = Math.round((r.y1 - lat.oy) / lat.ch);
  if (c1 <= c0 || r1 <= r0) return null;
  return { x0: lat.ox + c0 * lat.cw, y0: lat.oy + r0 * lat.ch, cols: c1 - c0, rows: r1 - r0 };
}
