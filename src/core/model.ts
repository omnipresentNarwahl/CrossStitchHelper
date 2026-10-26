import { look, lookDist, LookTree, type Look } from './appearance';
import { labDist, rgbToLab } from './color';
import { detectLattice } from './detect';
import { griddedCells } from './gridmask';
import { refineLines, type Lines } from './lines';
import { findLegend, type Swatch } from './legend';
import { distinctColors } from './quantize';
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

/**
 * Cells that carry a stitch: everything valid that isn't blank paper (a symbol on paper is a
 * white stitch) and isn't inside a legend or caption box.
 */
export function analyseCells(samples: CellSample[], cols: number, rows: number, gridded: Uint8Array | null, exclude?: Uint8Array | null) {
  const paper = findPaper(samples);
  const paperLab = paper ? rgbToLab(paper) : null;
  const paperLike = samples.map((s) => !!paperLab && s.valid && labDist(rgbToLab(s.rgb), paperLab) < PAPER_TOLERANCE);
  const boxed = gridded ? legendBoxes(gridded, paperLike, samples, cols, rows) : null;
  const frame = gridded ? chartFrame(gridded, cols, rows) : null;
  /** Cells that could hold a stitch: on the chart, not in a legend or caption box. */
  const candidate = new Uint8Array(samples.length);
  /** Candidates that aren't blank paper (a symbol on paper counts as a white stitch). */
  const mask = new Uint8Array(samples.length);
  samples.forEach((s, i) => {
    if (!s.valid || boxed?.[i] || exclude?.[i]) return;
    if (frame) {
      const c = i % cols, r = (i / cols) | 0;
      if (c < frame.c0 || c > frame.c1 || r < frame.r0 || r > frame.r1) return;
    }
    candidate[i] = 1;
    mask[i] = paperLike[i] && !s.symbol ? 0 : 1;
  });
  fillWhiteGaps(mask, candidate, paperLike, cols, rows);
  return { paper, paperLike, candidate, mask };
}

/**
 * White thread looks like blank paper unless its symbol shows up clearly. A blank-looking cell
 * that is mostly surrounded by stitches is white thread, not a gap in the design.
 */
function fillWhiteGaps(mask: Uint8Array, candidate: Uint8Array, paperLike: boolean[], cols: number, rows: number): void {
  for (let pass = 0; pass < 2; pass++) {
    const fill: number[] = [];
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] || !candidate[i] || !paperLike[i]) continue;
      const c = i % cols, r = (i / cols) | 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nc = c + dc, nr = r + dr;
          if (nc >= 0 && nr >= 0 && nc < cols && nr < rows) n += mask[nr * cols + nc];
        }
      }
      if (n >= 6) fill.push(i);
    }
    for (const i of fill) mask[i] = 1;
  }
}

/** Cells covered by the legend: each swatch plus the label text to its right. */
function legendZone(swatches: Swatch[] | null, lines: Lines, cols: number, rows: number, cellW: number, cellH: number): Uint8Array | null {
  if (!swatches?.length) return null;
  const zone = new Uint8Array(cols * rows);
  for (const sw of swatches) {
    const x0 = sw.x - sw.w / 2 - cellW, x1 = sw.x + sw.w / 2 + 8 * cellW;
    const y0 = sw.y - sw.h / 2 - 0.3 * cellH, y1 = sw.y + sw.h / 2 + 0.3 * cellH;
    for (let r = 0; r < rows; r++) {
      const cy = (lines.ys[r] + lines.ys[r + 1]) / 2;
      if (cy < y0 || cy > y1) continue;
      for (let c = 0; c < cols; c++) {
        const cx = (lines.xs[c] + lines.xs[c + 1]) / 2;
        if (cx >= x0 && cx <= x1) zone[r * cols + c] = 1;
      }
    }
  }
  return zone;
}

/** The run of columns/rows where grid lines are present: the chart's frame, excluding margins and captions. */
function chartFrame(gridded: Uint8Array, cols: number, rows: number): { c0: number; c1: number; r0: number; r1: number } | null {
  const run = (frac: number[]) => {
    let best: [number, number] | null = null;
    let start = -1, gap = 0;
    for (let i = 0; i <= frac.length; i++) {
      const on = i < frac.length && frac[i] >= 0.2;
      if (on) {
        if (start < 0) start = i;
        gap = 0;
      } else if (start >= 0) {
        gap++;
        if (gap > 3 || i === frac.length) {
          const end = i - gap;
          if (!best || end - start > best[1] - best[0]) best = [start, end];
          start = -1;
          gap = 0;
        }
      }
    }
    return best;
  };
  const colFrac = Array.from({ length: cols }, (_, c) => {
    let n = 0;
    for (let r = 0; r < rows; r++) n += gridded[r * cols + c];
    return n / rows;
  });
  const rowFrac = Array.from({ length: rows }, (_, r) => {
    let n = 0;
    for (let c = 0; c < cols; c++) n += gridded[r * cols + c];
    return n / cols;
  });
  const cr = run(colFrac), rr = run(rowFrac);
  return cr && rr ? { c0: cr[0], c1: cr[1], r0: rr[0], r1: rr[1] } : null;
}

/**
 * Legends, captions and margins have no grid lines. Where a big patch of line-free cells is
 * mostly blank paper, it is a text box, so everything in it (swatches, lettering) is ignored.
 * Line-free stitched areas inside a drawing aren't paper, so they are kept.
 */
function legendBoxes(gridded: Uint8Array, paperLike: boolean[], samples: CellSample[], cols: number, rows: number): Uint8Array {
  const boxed = new Uint8Array(gridded.length);
  const seen = new Uint8Array(gridded.length);
  for (let start = 0; start < gridded.length; start++) {
    if (gridded[start] || seen[start] || !samples[start].valid) continue;
    const blob: number[] = [];
    const stack = [start];
    seen[start] = 1;
    let paper = 0;
    while (stack.length) {
      const i = stack.pop()!;
      blob.push(i);
      if (paperLike[i]) paper++;
      const c = i % cols, r = (i / cols) | 0;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const j = nr * cols + nc;
        if (!gridded[j] && !seen[j] && samples[j].valid) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (blob.length >= 12 && paper >= blob.length * 0.35) for (const i of blob) boxed[i] = 1;
  }
  return boxed;
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
export function autoGrid(img: Raster): { grid: GridSpec; confidence: number; legend: Swatch[] | null } | null {
  const lat = detectLattice(img);
  if (!lat) return null;
  const cols = Math.floor((img.width - lat.ox) / lat.cw);
  const rows = Math.floor((img.height - lat.oy) / lat.ch);
  if (cols < 2 || rows < 2) return null;
  const whole: GridSpec = { x0: lat.ox, y0: lat.oy, cw: lat.cw, ch: lat.ch, cols, rows };
  const lines = refineLines(img, whole);
  const samples = sampleGrid(img, whole, lines);
  const gridded = griddedCells(img, whole);
  const legend = findLegend(img, lat.cw, lat.ch);
  const { mask } = analyseCells(samples, cols, rows, gridded, legendZone(legend, lines, cols, rows, lat.cw, lat.ch));

  // The chart is every substantial group of stitches (a page may hold several drawings).
  const groups = components(mask, cols, rows);
  const biggest = groups[0]?.length ?? 0;
  if (!biggest) return null;
  let c0 = cols, c1 = 0, r0 = rows, r1 = 0;
  for (const g of groups) {
    if (g.length < Math.max(6, biggest * 0.04)) continue;
    for (const i of g) {
      const c = i % cols, r = (i / cols) | 0;
      c0 = Math.min(c0, c);
      c1 = Math.max(c1, c);
      r0 = Math.min(r0, r);
      r1 = Math.max(r1, r);
    }
  }
  return {
    confidence: lat.confidence,
    legend,
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

/** Legend entries that look the same (the same thread listed in several legends) are one colour. */
function dedupeLegend(swatches: Swatch[]): Look[] {
  const out: Look[] = [];
  for (const sw of swatches) {
    const l = look(sw.rgb, sw.sig);
    if (!out.some((o) => lookDist(o, l) < 9)) out.push(l);
  }
  return out;
}

/** How far a cell can be from every legend entry before we suspect the legend missed its colour. */
const UNEXPLAINED = 24;
/** Fewest cells that make a colour the legend didn't list worth adding as its own. */
const MIN_EXTRA_CELLS = 12;
/** ...and at least this share of all stitches, so blurred edges and stray marks don't each become a colour. */
const MIN_EXTRA_SHARE = 0.012;

/** Holds the colour analysis of a chosen grid so the sliders can re-run cheaply. */
export class ImportModel {
  readonly cols: number;
  readonly rows: number;
  private readonly samples: CellSample[];
  private readonly mask: Uint8Array;
  private readonly paperLike: boolean[];
  private readonly looks: (Look | null)[];
  private treeCache: { tree: LookTree; cells: number[] } | null = null;
  readonly suggestedColors: number;
  readonly suggestedCleanup: Cleanup;
  /** Colours read from the chart's legend (plus any the legend missed), if a legend was found. */
  readonly legend: Look[] | null;
  /** How many of those came straight from the legend. */
  readonly legendCount: number;
  /** Upper limit for the automatic "number of colours". */
  readonly maxColors: number;

  constructor(img: Raster, readonly grid: GridSpec, legend: Swatch[] | null = null) {
    this.cols = grid.cols;
    this.rows = grid.rows;
    const lines = refineLines(img, grid);
    this.samples = sampleGrid(img, grid, lines);
    const analysis = analyseCells(this.samples, this.cols, this.rows, griddedCells(img, grid), legendZone(legend, lines, this.cols, this.rows, grid.cw, grid.ch));
    this.mask = analysis.mask;
    this.paperLike = analysis.paperLike;
    this.looks = this.samples.map((s) => (s.valid ? look(s.rgb, s.sig) : null));

    const stitches = this.mask.reduce((n, v) => n + v, 0);
    const groups = components(this.mask, this.cols, this.rows);
    this.suggestedCleanup = groups.length > 1 ? 'small' : 'none';

    const entries = legend && legend.length >= 2 ? dedupeLegend(legend) : [];
    this.legendCount = entries.length;
    if (entries.length >= 2) {
      entries.push(...this.discoverMissing(entries));
      this.legend = entries;
      this.suggestedColors = entries.length;
    } else {
      this.legend = null;
      this.suggestedColors = stitches ? Math.min(60, this.tree().tree.countForDistance(14)) : 0;
    }
    this.maxColors = stitches ? 60 : 0;
  }

  /** A cluster tree over every stitch cell, built on first use (it is only needed without a legend). */
  private tree(): { tree: LookTree; cells: number[] } {
    if (!this.treeCache) {
      const cells: number[] = [];
      this.mask.forEach((m, i) => m && cells.push(i));
      this.treeCache = { tree: new LookTree(cells.map((i) => this.looks[i]!)), cells };
    }
    return this.treeCache;
  }

  private nearest(l: Look, entries: Look[]): { index: number; dist: number } {
    let index = 0, dist = Infinity;
    for (let k = 0; k < entries.length; k++) {
      const d = lookDist(l, entries[k]);
      if (d < dist) {
        dist = d;
        index = k;
      }
    }
    return { index, dist };
  }

  /**
   * Legends are read from an image, so one can be incomplete. Stitches that match no legend
   * entry, in a group big enough to be real, become extra colours (this is also how plain white
   * stitches marked only with a dot are picked up when their swatch was missed).
   */
  private discoverMissing(entries: Look[]): Look[] {
    const pool: number[] = [];
    for (let i = 0; i < this.mask.length; i++) {
      if (!this.mask[i]) continue;
      const { dist } = this.nearest(this.looks[i]!, entries);
      const whiteStitch = this.paperLike[i]; // blank-looking, so only here because of a symbol on it
      if (dist > UNEXPLAINED || (whiteStitch && dist > 12)) pool.push(i);
    }
    const stitches = this.mask.reduce((n, v) => n + v, 0);
    const minCells = Math.max(MIN_EXTRA_CELLS, Math.round(stitches * MIN_EXTRA_SHARE));
    // A few odd cells are blurred edges. Only when a real share of the chart goes unexplained is the legend incomplete.
    if (pool.length < minCells || pool.length < stitches * 0.14) return [];
    const tree = new LookTree(pool.map((i) => this.looks[i]!));
    const { palette, sizes } = tree.cut(tree.countForDistance(26), minCells);
    return palette.filter((_, k) => sizes[k] >= minCells).map((p) => ({ rgb: p.rgb, lab: rgbToLab(p.rgb), sig: p.sig }));
  }

  /**
   * With `useLegend`, every stitch takes the nearest legend colour. Otherwise the appearances are
   * clustered down to `colorCount` colours.
   */
  build(colorCount: number, cleanup: Cleanup, useLegend = false): BuiltPattern {
    const cells = new Uint8Array(this.mask.length);
    if (!this.mask.some((v) => v) && !this.legend) return { cols: this.cols, rows: this.rows, cells, palette: [], removed: 0 };
    let palette: RGB[];
    if (useLegend && this.legend) {
      const entries = this.legend;
      palette = entries.map((e) => e.rgb);
      for (let i = 0; i < cells.length; i++) {
        if (this.mask[i]) cells[i] = this.nearest(this.looks[i]!, entries).index + 1;
      }
    } else {
      const { tree, cells: ids } = this.tree();
      const cut = tree.cut(Math.max(1, Math.min(colorCount, tree.size)), MIN_COLOR_CELLS);
      palette = cut.palette.map((p) => p.rgb);
      ids.forEach((cell, k) => (cells[cell] = cut.assign[k] + 1));
    }

    let removed = 0;
    if (cleanup !== 'none') {
      const groups = components(cells, this.cols, this.rows);
      const biggest = groups[0]?.length ?? 0;
      for (const g of groups.slice(1)) {
        // Little islands, and thin strips only a row or two tall (lines of lettering), are noise.
        let c0 = this.cols, c1 = 0, r0 = this.rows, r1 = 0;
        for (const i of g) {
          const c = i % this.cols, r = (i / this.cols) | 0;
          c0 = Math.min(c0, c);
          c1 = Math.max(c1, c);
          r0 = Math.min(r0, r);
          r1 = Math.max(r1, r);
        }
        const strip = Math.min(c1 - c0, r1 - r0) <= 2 && g.length <= 70;
        if (cleanup === 'main' || ((g.length <= 8 || strip) && g.length < biggest * 0.1)) {
          for (const i of g) cells[i] = 0;
          removed += g.length;
        }
      }
    }
    // Drop palette entries that ended up unused (e.g. after clean-up) and renumber.
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
