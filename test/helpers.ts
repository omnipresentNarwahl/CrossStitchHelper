import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import type { Raster } from '../src/core/raster';

export function loadPng(path: string): Raster {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: png.data };
}
