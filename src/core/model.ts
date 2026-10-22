import { labDist, rgbToLab } from './color';
import { detectLattice } from './detect';
import { ColorTree, distinctColors } from './quantize';
import type { Raster, RGB } from './raster';
import { sampleGrid, type CellSample, type GridSpec } from './sample';

/** What the importer produces: one palette index (+1) per cell, 0 meaning "no stitch". */
export interface BuiltPattern {
  cols: number;
  rows: number;
  cells: Uint8Array;
  palette: RGB[];
  /** Cells dropped by the clean-up (legend swatches, labels, scanning noise). */
  removed: number;
}

/** How to treat separate islands of stitches: keep all, drop tiny ones, or keep only the biggest piece. */
export type Cleanup = 'none' | 'small' | 'main';

const PAPER_TOLERANCE = 7;
/** Colours covering fewer cells than this are blurred edges rather than real threads; they join their nearest neighbour. */
const MIN_COLOR_CELLS = 3;

/** The page colour: the most common near-white/grey colour among cells with no symbol on them. */
function findPaper(samples: CellSample[]): RGB | null {
  const plain = samples.filter((s) => s.valid && !s.symbol).map((s) => s.rgb);
  const { colors, weights } = distinctColors(plain);
  let best = -1;
  for (let i = 0; i < colors.length; i++) {
    const [r, g, b] = colors[i];
    const pale = Math.min(r, g, b) > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 24;
    if (pale && (best < 0 || weights[i] > weights[best])) best = i;
  }
  return best < 0 ? null : colors[best];
}

/** Cells that carry a stitch: everything valid that isn't blank paper (a symbol on paper is a white stitch). */
function stitchMask(samples: CellSample[], paper: RGB | null): Uint8Array {
  const mask = new Uint8Array(samples.length);
  const paperLab = paper ? rgbToLab(paper) : null;
  samples.forEach((s, i) => {
    if (!s.valid) return;
    const blank = paperLab && labDist(rgbToLab(s.rgb), paperLab) < PAPER_TOLERANCE && !s.symbol;
    mask[i] = blank ? 0 : 1;
  });
  return mask;
}

/** Connected groups of stitch cells, treating gaps of one blank cell as connected. */
function components(mask: Uint8Array, cols: number, rows: number): number[][] {
  const seen = new Uint8Array(mask.length);
  const groups: number[][] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const group: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      group.push(i);
      const c = i % cols, r = (i / cols) | 0;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const j = nr * cols + nc;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    groups.push(group);
  }
  return groups.sort((a, b) => b.length - a.length);
}

/** Looks for the grid and the chart inside the image; null if the image doesn't look like a chart. */
export function autoGrid(img: Raster): { grid: GridSpec; confidence: number } | null {
  const lat = detectLattice(img);
  if (!lat) return null;
  const cols = Math.floor((img.width - lat.ox) / lat.cw);
  const rows = Math.floor((img.height - lat.oy) / lat.ch);
  if (cols < 2 || rows < 2) return null;
  const samples = sampleGrid(img, { x0: lat.ox, y0: lat.oy, cw: lat.cw, ch: lat.ch, cols, rows });
  const mask = stitchMask(samples, findPaper(samples));
  const main = components(mask, cols, rows)[0];
  if (!main) return null;
  let c0 = cols, c1 = 0, r0 = rows, r1 = 0;
  for (const i of main) {
    const c = i % cols, r = (i / cols) | 0;
    c0 = Math.min(c0, c);
    c1 = Math.max(c1, c);
    r0 = Math.min(r0, r);
    r1 = Math.max(r1, r);
  }
  return {
    confidence: lat.confidence,
    grid: {
      x0: lat.ox + c0 * lat.cw,
      y0: lat.oy + r0 * lat.ch,
      cw: lat.cw,
      ch: lat.ch,
      cols: c1 - c0 + 1,
      rows: r1 - r0 + 1,
    },
  };
}

/** Holds the colour analysis of a chosen grid so the sliders can re-run cheaply. */
export class ImportModel {
  readonly cols: number;
  readonly rows: number;
  private readonly samples: CellSample[];
  private readonly mask: Uint8Array;
  private readonly tree: ColorTree | null;
  /** Index into the tree's distinct colours for each stitch cell (-1 for none). */
  private readonly colorOf: Int32Array;
  readonly suggestedColors: number;
  readonly maxColors: number;
  readonly suggestedCleanup: Cleanup;

  constructor(img: Raster, readonly grid: GridSpec) {
    this.cols = grid.cols;
    this.rows = grid.rows;
    this.samples = sampleGrid(img, grid);
    this.mask = stitchMask(this.samples, findPaper(this.samples));
    const idx: number[] = [];
    const colors: RGB[] = [];
    this.colorOf = new Int32Array(this.mask.length).fill(-1);
    this.mask.forEach((m, i) => {
      if (m) {
        idx.push(i);
        colors.push(this.samples[i].rgb);
      }
    });
    if (!idx.length) {
      this.tree = null;
      this.suggestedColors = 0;
      this.maxColors = 0;
      this.suggestedCleanup = 'none';
      return;
    }
    const d = distinctColors(colors);
    idx.forEach((cell, k) => (this.colorOf[cell] = d.index[k]));
    this.tree = new ColorTree(d.colors, d.weights);
    this.maxColors = Math.min(60, d.colors.length);
    this.suggestedColors = Math.min(this.maxColors, this.tree.countForDistance(12));
    const groups = components(this.mask, this.cols, this.rows);
    this.suggestedCleanup = groups.length > 1 && groups[0].length >= idx.length * 0.7 ? 'main' : 'none';
  }

  build(colorCount: number, cleanup: Cleanup): BuiltPattern {
    const cells = new Uint8Array(this.mask.length);
    if (!this.tree) return { cols: this.cols, rows: this.rows, cells, palette: [], removed: 0 };
    const { assign, palette } = this.tree.cut(colorCount, MIN_COLOR_CELLS);
    for (let i = 0; i < cells.length; i++) if (this.colorOf[i] >= 0) cells[i] = assign[this.colorOf[i]] + 1;

    let removed = 0;
    if (cleanup !== 'none') {
      const groups = components(cells, this.cols, this.rows);
      const biggest = groups[0]?.length ?? 0;
      for (const g of groups.slice(1)) {
        if (cleanup === 'main' || (g.length <= 8 && g.length < biggest * 0.02)) {
          for (const i of g) cells[i] = 0;
          removed += g.length;
        }
      }
    }
    // Drop palette entries that ended up unused (e.g. after speck removal) and renumber.
    const used = new Set(cells);
    const remap = new Map<number, number>();
    const finalPalette: RGB[] = [];
    palette.forEach((rgb, i) => {
      if (used.has(i + 1)) {
        remap.set(i + 1, finalPalette.length + 1);
        finalPalette.push(rgb);
      }
    });
    for (let i = 0; i < cells.length; i++) if (cells[i]) cells[i] = remap.get(cells[i])!;
    return { cols: this.cols, rows: this.rows, cells, palette: finalPalette, removed };
  }
}
