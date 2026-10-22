/** A decoded image: RGBA bytes, row-major. Compatible with the browser's ImageData. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export type RGB = [number, number, number];

export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
