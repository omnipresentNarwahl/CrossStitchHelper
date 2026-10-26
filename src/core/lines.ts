import { luma, type Raster } from './raster';
import type { GridSpec } from './sample';

/** Where each grid line really is (scans drift a little) and which ones are the heavy every-tenth lines. */
export interface Lines {
  xs: Float32Array;
  ys: Float32Array;
  boldX: boolean[];
  boldY: boolean[];
}

function lumaPlane(img: Raster): Float32Array {
  const g = new Float32Array(img.width * img.height);
  for (let i = 0; i < g.length; i++) g[i] = luma(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
  return g;
}

/**
 * Snaps every grid line to the darkest column/row within a pixel or two of where the lattice
 * says it is, and flags the heavy ones. Cells next to a heavy line need extra care when sampled.
 */
export function refineLines(img: Raster, grid: GridSpec): Lines {
  const { width: w, height: h } = img;
  const g = lumaPlane(img);
  const at = (x: number, y: number) => g[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];

  const refine = (axis: 'x' | 'y', count: number, origin: number, step: number, lo: number, hi: number) => {
    const pos = new Float32Array(count + 1);
    const strength = new Float32Array(count + 1);
    for (let k = 0; k <= count; k++) {
      const expect = origin + k * step;
      let best = expect, bestS = -1;
      for (let o = -2; o <= 2; o += 0.5) {
        const p = expect + o;
        const pi = Math.floor(p), f = p - pi;
        let s = 0, n = 0;
        for (let j = Math.ceil(lo); j < hi; j++) {
          // Dark line against its surroundings, sampled between pixels for sub-pixel placement.
          const centre = axis === 'x' ? at(pi, j) * (1 - f) + at(pi + 1, j) * f : at(j, pi) * (1 - f) + at(j, pi + 1) * f;
          const side = axis === 'x' ? (at(pi - 3, j) + at(pi + 4, j)) / 2 : (at(j, pi - 3) + at(j, pi + 4)) / 2;
          s += Math.max(0, side - centre);
          n++;
        }
        const val = n ? s / n : 0;
        if (val > bestS) {
          bestS = val;
          best = p;
        }
      }
      pos[k] = best;
      strength[k] = bestS;
    }
    const med = [...strength].sort((a, b) => a - b)[Math.floor(strength.length / 2)];
    const bold = Array.from(strength, (s) => med > 2 && s > med * 1.6);
    return { pos, bold };
  };

  const x = refine('x', grid.cols, grid.x0, grid.cw, grid.y0, grid.y0 + grid.rows * grid.ch);
  const y = refine('y', grid.rows, grid.y0, grid.ch, grid.x0, grid.x0 + grid.cols * grid.cw);
  return { xs: x.pos, ys: y.pos, boldX: x.bold, boldY: y.bold };
}
