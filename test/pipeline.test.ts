import { expect, test } from 'vitest';
import { autoGrid, ImportModel } from '../src/core/model';
import { loadPng } from './helpers';

test('macaw end to end', () => {
  const img = loadPng('test/fixtures/macaw.png');
  const g = autoGrid(img)!;
  const m = new ImportModel(img, g.grid, g.legend);
  const b = m.build(m.suggestedColors, m.suggestedCleanup, true);
  const counts = new Array(b.palette.length).fill(0);
  b.cells.forEach((v) => v && counts[v - 1]++);
  expect(g.grid.cols).toBe(28);
  expect(g.grid.rows).toBe(56);
  expect(b.removed).toBeGreaterThan(0);
  // every legend colour is used somewhere in the chart
  expect(b.palette).toHaveLength(15);
  expect(counts.every((n) => n > 0)).toBe(true);
});
