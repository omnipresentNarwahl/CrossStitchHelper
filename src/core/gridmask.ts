import { luma, type Raster } from './raster';
import type { GridSpec } from './sample';

/**
 * Which cells sit on the chart proper? Chart cells have faint grid lines around them; legends,
 * captions and margins don't. Returns 1 per cell with grid lines, or null when the image has no
 * grid lines at all (a clean chart), in which case nothing can be ruled out this way.
 */
export function griddedCells(img: Raster, grid: GridSpec): Uint8Array | null {
  const { width: w, height: h, data } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = luma(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 255 : lum[y * w + x]);

  /** How much darker a 1-pixel line is than what's two or three pixels either side, tolerating a pixel of misplacement. */
  const vDip = (x: number, y: number) => {
    let best = 0;
    for (let o = -1; o <= 1; o++) {
      const xi = Math.round(x) + o;
      const dip = (at(xi - 3, y) + at(xi + 3, y)) / 2 - Math.min(at(xi - 1, y), at(xi, y), at(xi + 1, y));
      if (dip > best) best = dip;
    }
    return best;
  };
  const hDip = (x: number, y: number) => {
    let best = 0;
    for (let o = -1; o <= 1; o++) {
      const yi = Math.round(y) + o;
      const dip = (at(x, yi - 3) + at(x, yi + 3)) / 2 - Math.min(at(x, yi - 1), at(x, yi), at(x, yi + 1));
      if (dip > best) best = dip;
    }
    return best;
  };

  // A real grid line is dark all along a cell's edge. Lettering has strokes that look like a line
  // for a pixel or two but not for the whole edge, so measure how much of the edge is line-like.
  const LINE = 14;
  const strength = new Float32Array(grid.cols * grid.rows);
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const x0 = grid.x0 + c * grid.cw, y0 = grid.y0 + r * grid.ch;
      let v = 0, n = 0, hh = 0, m = 0;
      for (let y = Math.ceil(y0 + 1); y < y0 + grid.ch - 1; y++) {
        if (vDip(x0, y) >= LINE) v++;
        n++;
      }
      for (let x = Math.ceil(x0 + 1); x < x0 + grid.cw - 1; x++) {
        if (hDip(x, y0) >= LINE) hh++;
        m++;
      }
      strength[r * grid.cols + c] = Math.min(n ? v / n : 0, m ? hh / m : 0);
    }
  }

  // Judge a neighbourhood, not a single cell: lettering throws up the odd line-like cell, and a
  // flat patch of colour inside a drawing can lack lines, but a legend box has none for a whole area.
  const R = 2;
  const smooth = new Float32Array(strength.length);
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      let sum = 0, n = 0;
      for (let dr = -R; dr <= R; dr++) {
        for (let dc = -R; dc <= R; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= grid.rows || cc >= grid.cols) continue;
          sum += strength[rr * grid.cols + cc];
          n++;
        }
      }
      smooth[r * grid.cols + c] = sum / n;
    }
  }

  const sorted = [...smooth].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length * 0.6)];
  // Charts with grid lines have most cells outlined most of the way round.
  if (typical < 0.35) return null;
  const mask = new Uint8Array(smooth.length);
  let gridded = 0;
  for (let i = 0; i < smooth.length; i++) {
    if (smooth[i] >= 0.3) {
      mask[i] = 1;
      gridded++;
    }
  }
  return gridded >= smooth.length * 0.3 ? mask : null;
}
