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

function fitAxis(p: Float32Array): AxisFit | null {
  const n = p.length;
  let total = 0;
  for (const v of p) total += v;
  if (total <= 0) return null;
  const mean = total / n;
  const q = Float32Array.from(p, (v) => v - mean);

  const tMin = 4;
  const tMax = Math.min(150, n / 3);
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

/** Finds the regular grid in a chart image, or null if nothing grid-like is there. */
export function detectLattice(img: Raster): Lattice | null {
  const g = lumaPlane(img);
  const fx = fitAxis(lineProfile(g, img.width, img.height, 'x'));
  const fy = fitAxis(lineProfile(g, img.width, img.height, 'y'));
  if (!fx || !fy) return null;
  return {
    cw: fx.period,
    ch: fy.period,
    ox: fx.phase,
    oy: fy.phase,
    confidence: Math.min(fx.confidence, fy.confidence),
  };
}
