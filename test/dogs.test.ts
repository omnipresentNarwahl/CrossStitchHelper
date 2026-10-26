import { expect, test } from 'vitest';
import { findLegend } from '../src/core/legend';
import { autoGrid, ImportModel } from '../src/core/model';
import { correctShading } from '../src/core/shading';
import { luma } from '../src/core/raster';
import { loadPng } from './helpers';

const rowLevel = (img: { width: number; data: Uint8ClampedArray | Uint8Array }, y: number) => {
  const v: number[] = [];
  for (let x = Math.floor(img.width * 0.2); x < img.width * 0.8; x++) {
    const i = (y * img.width + x) * 4;
    v.push(luma(img.data[i], img.data[i + 1], img.data[i + 2]));
  }
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length * 0.9)];
};

test('a screenshot shadow band across the top is brightened away', () => {
  const raw = loadPng('test/fixtures/labrador.png');
  expect(rowLevel(raw, 45)).toBeLessThan(160); // dim band under the page toolbar
  const fixed = correctShading(raw);
  expect(rowLevel(fixed, 45)).toBeGreaterThan(235);
  expect(rowLevel(fixed, 120)).toBeCloseTo(rowLevel(raw, 120), 0); // below the band: untouched
});

test('a chart without a shadow is left alone', () => {
  const raw = loadPng('test/fixtures/macaw.png');
  expect(correctShading(raw)).toBe(raw);
});

test('reads the swatches of a one-column legend', () => {
  const img = correctShading(loadPng('test/fixtures/westie.png'));
  const sw = findLegend(img, 7.48, 7.42)!;
  expect(sw).toHaveLength(12);
  // all in one column, evenly stacked
  expect(new Set(sw.map((s) => Math.round(s.x))).size).toBe(1);
});

for (const [name, cols, rows] of [['labrador', 80, 112], ['golden', 84, 114], ['cavalier', 80, 111], ['poodle', 80, 110], ['westie', 83, 114]] as const) {
  test(`imports the ${name} chart`, () => {
    const img = correctShading(loadPng(`test/fixtures/${name}.png`));
    const a = autoGrid(img)!;
    // The grid hugs the chart frame, not the caption or the dark screen border.
    expect(Math.abs(a.grid.cols - cols)).toBeLessThanOrEqual(4);
    expect(Math.abs(a.grid.rows - rows)).toBeLessThanOrEqual(4);
    expect(a.legend && a.legend.length).toBeGreaterThanOrEqual(10);

    const m = new ImportModel(img, a.grid, a.legend);
    const b = m.build(m.suggestedColors, m.suggestedCleanup, !!m.legend);
    const stitches = b.cells.reduce((n, v) => n + (v ? 1 : 0), 0);
    expect(stitches).toBeGreaterThan(2500);
    expect(stitches).toBeLessThan(6500);
    expect(b.palette.length).toBeGreaterThanOrEqual(10);
    expect(b.palette.length).toBeLessThanOrEqual(30);

    // Without the legend, grouping by appearance still gives a sensible pattern.
    const auto = new ImportModel(img, a.grid, null);
    const ab = auto.build(12, auto.suggestedCleanup);
    expect(ab.palette.length).toBeLessThanOrEqual(12);
    expect(ab.cells.reduce((n, v) => n + (v ? 1 : 0), 0)).toBeGreaterThan(2000);
  });
}
