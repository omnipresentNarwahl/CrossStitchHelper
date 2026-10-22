import { expect, test } from 'vitest';
import { detectLattice } from '../src/core/detect';
import { loadPng } from './helpers';

test('finds the macaw grid', () => {
  const img = loadPng('test/fixtures/macaw.png');
  const t0 = Date.now();
  const lat = detectLattice(img)!;
  console.log(lat, Date.now() - t0, 'ms');
  expect(lat).not.toBeNull();
});
