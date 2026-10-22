import { savePattern } from '../db';
import type { RGB as RGBTuple } from '../core/raster';
import type { Pattern, ViewState } from '../types';

interface Op {
  idx: number[];
  cell0: number[];
  done0: number[];
  cell1: number[];
  done1: number[];
}

const MAX_HISTORY = 300;

/** A pattern being worked on: applies changes, keeps undo history, counts progress and saves itself. */
export class Session {
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private saveTimer = 0;
  private dirty = false;
  /** Unfinished stitches per palette colour. */
  left: number[] = [];
  total: number[] = [];
  leftAll = 0;
  totalAll = 0;
  /** Bumps whenever the pattern is edited, so callers can tell whether anything changed. */
  revision = 0;
  onChange: () => void = () => undefined;

  constructor(readonly pattern: Pattern, private readonly persist = true) {
    this.recount();
  }

  recount(): void {
    const p = this.pattern;
    this.left = new Array(p.palette.length).fill(0);
    this.total = new Array(p.palette.length).fill(0);
    for (let i = 0; i < p.cells.length; i++) {
      const v = p.cells[i];
      if (!v) continue;
      this.total[v - 1]++;
      if (!p.done[i]) this.left[v - 1]++;
    }
    this.totalAll = this.total.reduce((a, b) => a + b, 0);
    this.leftAll = this.left.reduce((a, b) => a + b, 0);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Starts a batch of changes (one finger stroke or one tap) that undo treats as a single step. */
  begin(): Stroke {
    return new Stroke(this);
  }

  /** @internal */
  commit(op: Op): void {
    if (!op.idx.length) return;
    this.undoStack.push(op);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.revision++;
    this.changed();
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    this.apply(op.idx, op.cell0, op.done0);
    this.redoStack.push(op);
    this.revision++;
    this.changed();
  }

  redo(): void {
    const op = this.redoStack.pop();
    if (!op) return;
    this.apply(op.idx, op.cell1, op.done1);
    this.undoStack.push(op);
    this.revision++;
    this.changed();
  }

  /** @internal */
  apply(idx: number[], cells: number[], done: number[]): void {
    const p = this.pattern;
    for (let k = 0; k < idx.length; k++) {
      p.cells[idx[k]] = cells[k];
      p.done[idx[k]] = done[k];
    }
    this.recount();
  }

  setView(v: ViewState): void {
    this.pattern.view = v;
    this.scheduleSave();
  }

  changed(): void {
    this.recount();
    this.scheduleSave();
    this.onChange();
  }

  /** Palette edits (labels, new colours) that don't go through undo. */
  paletteChanged(): void {
    this.revision++;
    this.recount();
    this.scheduleSave();
    this.onChange();
  }

  /** Folds colour `from` into colour `to` (palette indices) and removes `from`. Clears undo history. */
  mergeColor(from: number, to: number): void {
    if (from === to) return;
    const p = this.pattern;
    const remap = (v: number): number => {
      if (!v) return 0;
      const k = v - 1 === from ? to : v - 1;
      return (k > from ? k - 1 : k) + 1;
    };
    for (let i = 0; i < p.cells.length; i++) p.cells[i] = remap(p.cells[i]);
    p.palette.splice(from, 1);
    this.undoStack = [];
    this.redoStack = [];
    this.revision++;
    this.changed();
  }

  /** Adds a colour to the palette and returns its index. */
  addColor(rgb: RGBTuple): number {
    this.pattern.palette.push({ rgb, label: '' });
    this.paletteChanged();
    return this.pattern.palette.length - 1;
  }

  private scheduleSave(): void {
    if (!this.persist) return;
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 400);
  }

  async flush(): Promise<void> {
    if (!this.persist) return;
    clearTimeout(this.saveTimer);
    if (!this.dirty) return;
    this.dirty = false;
    this.pattern.updated = Date.now();
    await savePattern(this.pattern);
  }
}

export class Stroke {
  private readonly op: Op = { idx: [], cell0: [], done0: [], cell1: [], done1: [] };
  private readonly seen = new Set<number>();

  constructor(private readonly s: Session) {}

  private touch(i: number): boolean {
    if (this.seen.has(i)) return false;
    this.seen.add(i);
    const p = this.s.pattern;
    this.op.idx.push(i);
    this.op.cell0.push(p.cells[i]);
    this.op.done0.push(p.done[i]);
    return true;
  }

  private finish(i: number): void {
    const p = this.s.pattern;
    this.op.cell1.push(p.cells[i]);
    this.op.done1.push(p.done[i]);
  }

  /** Marks a stitch done or not done. Cells with no stitch are ignored. */
  setDone(i: number, value: 0 | 1): void {
    const p = this.s.pattern;
    if (!p.cells[i] || p.done[i] === value || this.seen.has(i)) return;
    this.touch(i);
    p.done[i] = value;
    this.finish(i);
    this.s.recount();
    this.s.onChange();
  }

  /** Repaints a cell with palette colour `color` (0 clears it). */
  setCell(i: number, color: number): void {
    const p = this.s.pattern;
    if (p.cells[i] === color || this.seen.has(i)) return;
    this.touch(i);
    p.cells[i] = color;
    if (!color) p.done[i] = 0;
    this.finish(i);
    this.s.recount();
    this.s.onChange();
  }

  end(): void {
    this.s.commit(this.op);
  }

  /** Throws the stroke away, restoring every cell it touched. */
  cancel(): void {
    this.s.apply(this.op.idx, this.op.cell0, this.op.done0);
    this.s.onChange();
  }
}
