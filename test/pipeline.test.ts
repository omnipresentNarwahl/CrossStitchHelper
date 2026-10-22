import { expect, test } from 'vitest';
import { autoGrid, ImportModel } from '../src/core/model';
import { loadPng } from './helpers';

test('macaw end to end', () => {
  const img = loadPng('test/fixtures/macaw.png');
  const g = autoGrid(img)!;
  const m = new ImportModel(img, g.grid);
  const b = m.build(m.suggestedColors, m.suggestedCleanup);
  const counts = new Array(b.palette.length).fill(0);
  b.cells.forEach((v) => v && counts[v - 1]++);
  console.log(b.palette.map((p, i) => `${p.join(',')}:${counts[i]}`).join('  '));
  expect(g.grid.cols).toBe(28);
  expect(g.grid.rows).toBe(56);
  expect(b.removed).toBeGreaterThan(0);
});
