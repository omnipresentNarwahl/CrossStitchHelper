import type { RGB } from './core/raster';

export interface PaletteEntry {
  rgb: RGB;
  /** What the user calls it, typically the thread number from the chart legend. */
  label: string;
}

/** Where the original chart image sits relative to the stitch grid, in image pixels. */
export interface ImageGrid {
  x0: number;
  y0: number;
  cw: number;
  ch: number;
}

export interface ViewState {
  /** Grid coordinates at the centre of the screen. */
  cx: number;
  cy: number;
  /** Screen pixels per cell. */
  scale: number;
}

export interface Pattern {
  id: string;
  name: string;
  cols: number;
  rows: number;
  palette: PaletteEntry[];
  /** Palette index + 1 per cell, 0 for no stitch. Row-major. */
  cells: Uint8Array;
  /** 1 once stitched. Same layout as `cells`. */
  done: Uint8Array;
  imageW: number;
  imageH: number;
  imageGrid: ImageGrid;
  view?: ViewState;
  /** Cell index of the stitch most recently crossed off, so you can see where you left off. */
  lastStitch?: number;
  created: number;
  updated: number;
}
