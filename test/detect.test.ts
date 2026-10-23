import { expect, test } from 'vitest';
import { detectLattice } from '../src/core/detect';
import { loadPng } from './helpers';

test('finds the macaw grid', () => {
  const img = loadPng('test/fixtures/macaw.png');
  const lat = detectLattice(img)!;
  expect(lat).not.toBeNull();
});
