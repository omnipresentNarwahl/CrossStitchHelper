import { expect, test } from 'vitest';
import { detectLattice } from '../src/core/detect';
import { findLegend } from '../src/core/legend';
import { loadPng } from './helpers';

test('finds the macaw legend swatches', () => {
  const img = loadPng('test/fixtures/macaw.png');
  const lat = detectLattice(img)!;
  const sw = findLegend(img, lat.cw)!;
  expect(sw).toHaveLength(15);
});
