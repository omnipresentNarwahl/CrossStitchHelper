import { expect, test } from 'vitest';
import { detectLattice, detectLatticeIn, snapRegionToLattice } from '../src/core/detect';
import type { Raster } from '../src/core/raster';
import { loadPng } from './helpers';

/** A chart with no grid lines at all: random coloured blocks on a white page. */
function blockChart(cell: number, cols: number, rows: number, pad: number): Raster {
  const w = Math.round(cols * cell + 2 * pad), h = Math.round(rows * cell + 2 * pad);
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const palette = [[230, 60, 40], [250, 190, 20], [30, 160, 220], [120, 190, 60], [90, 60, 160], [20, 20, 20]];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const choice = Array.from({ length: cols * rows }, () => (rnd() < 0.25 ? -1 : Math.floor(rnd() * palette.length)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = Math.floor((x - pad) / cell), r = Math.floor((y - pad) / cell);
      if (c < 0 || r < 0 || c >= cols || r >= rows || choice[r * cols + c] < 0) continue;
      data.set([...palette[choice[r * cols + c]], 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

test('finds a grid with no lines from the edges between squares', () => {
  const img = blockChart(9.4, 24, 18, 20);
  const lat = detectLattice(img)!;
  expect(lat).not.toBeNull();
  expect(lat.cw).toBeCloseTo(9.4, 0);
  expect(lat.ch).toBeCloseTo(9.4, 0);
  // Lines should land on the real square edges (20 + k * 9.4).
  const off = ((lat.ox - 20) % 9.4 + 9.4) % 9.4;
  expect(Math.min(off, 9.4 - off)).toBeLessThan(0.8);
});

test('a size hint steers detection to the right period', () => {
  const img = loadPng('test/fixtures/macaw.png');
  const lat = detectLatticeIn(img, { x0: 30, y0: 45, x1: 370, y1: 700 }, { cellHint: { w: 12, h: 12 } })!;
  expect(lat.cw).toBeCloseTo(11.44, 1);
  expect(lat.ch).toBeCloseTo(11.44, 1);
  // Offsets are in whole-image pixels and agree with the full-image answer (mod one cell).
  const full = detectLattice(img)!;
  const d = Math.abs(lat.ox - full.ox) % full.cw;
  expect(Math.min(d, full.cw - d)).toBeLessThan(0.6);
});

test('snaps a rough rectangle to grid lines', () => {
  const img = loadPng('test/fixtures/macaw.png');
  const lat = detectLattice(img)!;
  const snapped = snapRegionToLattice(lat, { x0: lat.ox + 3 * lat.cw + 2, y0: lat.oy + 2 * lat.ch - 3, x1: lat.ox + 13 * lat.cw - 1, y1: lat.oy + 12 * lat.ch + 2 })!;
  expect(snapped.cols).toBe(10);
  expect(snapped.rows).toBe(10);
  expect(snapped.x0).toBeCloseTo(lat.ox + 3 * lat.cw, 3);
});
