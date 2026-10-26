import { detectLatticeIn, snapRegionToLattice, type Region } from '../core/detect';
import { findLegend } from '../core/legend';
import { correctShading } from '../core/shading';
import { autoGrid, ImportModel, type BuiltPattern, type Cleanup } from '../core/model';
import type { Raster } from '../core/raster';
import type { GridSpec } from '../core/sample';
import { savePattern } from '../db';
import { draw } from '../stitch/draw';
import type { Pattern } from '../types';
import { chipCanvas } from '../ui/chips';
import { confirmDialog, h, toast, withBusy, type View } from '../ui/dom';
import { createEditView } from '../stitch/editView';
import { Viewport, type DragHandler, type Rect } from '../ui/viewport';

const MAX_SIDE = 3200;

interface Loaded {
  source: CanvasImageSource;
  blob: Blob;
  raster: Raster;
  width: number;
  height: number;
}

/** Decodes the picked file, shrinking very large photos so analysis stays quick on a phone. */
async function load(file: File): Promise<Loaded> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * k), height = Math.round(bmp.height * k);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const raster = ctx.getImageData(0, 0, width, height);
  const blob = k === 1 ? file : await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.92));
  return { source: canvas, blob, raster, width, height };
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

export async function createImportView(file: File, onCreated: (id: string) => void, onCancel: () => void): Promise<View> {
  let loaded: Loaded;
  try {
    loaded = await load(file);
  } catch {
    toast('Could not open that image');
    onCancel();
    return { el: h('div'), destroy() { /* nothing */ } };
  }
  // Analysis works on a copy with any screenshot shadow band brightened away; the picture shown to the user is untouched.
  const raster = correctShading(loaded.raster);

  const auto = await withBusy('Looking for the grid…', () => autoGrid(raster));
  let legend = auto?.legend ?? null;
  /** Where grid lines are believed to be; lets the corner handles snap to them. */
  let lattice: { x0: number; y0: number; cw: number; ch: number } | null = auto && auto.confidence > 0.2 ? auto.grid : null;
  const autoFailed = !lattice;
  /** Hints the user has given for re-running detection. */
  let cellBox: Region | null = null;
  let sizeTouched = false;
  let detectNote: { text: string; kind: 'good' | 'warn' | '' } = autoFailed
    ? { text: "We couldn't find the grid automatically. Drag corners 1 and 2 around the chart, then tap “Find grid”. You can also mark one square or set how many columns and rows there are first.", kind: 'warn' }
    : { text: '', kind: '' };
  const fallbackCols = 40;
  let grid: GridSpec = auto?.grid ?? {
    x0: 0,
    y0: 0,
    cw: loaded.width / fallbackCols,
    ch: loaded.width / fallbackCols,
    cols: fallbackCols,
    rows: Math.max(1, Math.floor(loaded.height / (loaded.width / fallbackCols))),
  };
  const initialGrid = { ...grid };

  const root = h('div', { class: 'screen import' });
  let current: { destroy(): void } | null = null;
  const show = (el: HTMLElement, destroy: () => void) => {
    current?.destroy();
    current = { destroy };
    root.replaceChildren(el);
  };

  // ---------------------------------------------------------------- step 1: grid
  function showGridStep(): void {
    const canvas = h('canvas', { class: 'stage' });
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const redraw = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        paint();
      });
    };
    const bounds = (): Rect => ({ x0: 0, y0: 0, x1: loaded.width, y1: loaded.height });
    const corner = (which: 'tl' | 'br') => (which === 'tl' ? { x: grid.x0, y: grid.y0 } : { x: grid.x0 + grid.cols * grid.cw, y: grid.y0 + grid.rows * grid.ch });

    let markMode = false;

    /** Re-runs grid detection on the area between the corners, using any hints the user gave. */
    async function findGrid(): Promise<void> {
      const tl = corner('tl'), br = corner('br');
      const region: Region = { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
      let hint: { w: number; h: number } | undefined;
      if (cellBox) hint = { w: Math.abs(cellBox.x1 - cellBox.x0), h: Math.abs(cellBox.y1 - cellBox.y0) };
      else if (sizeTouched) hint = { w: (region.x1 - region.x0) / grid.cols, h: (region.y1 - region.y0) / grid.rows };
      const lat = await withBusy('Looking for the grid…', () => detectLatticeIn(raster, region, { cellHint: hint }));
      const snapped = lat ? snapRegionToLattice(lat, region) : null;
      if (!lat || !snapped || lat.confidence < 0.1) {
        detectNote = {
          text: "Still can't see a clear grid there. Try zooming in and drawing a box around one square (“Mark one square”), or enter the number of columns and rows and try again. You can also line the corners up by hand and carry on.",
          kind: 'warn',
        };
      } else {
        lattice = { x0: lat.ox, y0: lat.oy, cw: lat.cw, ch: lat.ch };
        grid = { x0: snapped.x0, y0: snapped.y0, cw: lat.cw, ch: lat.ch, cols: snapped.cols, rows: snapped.rows };
        legend = (await withBusy('Reading the legend…', () => findLegend(raster, lat.cw, lat.ch))) ?? legend;
        detectNote = {
          text: `Found a grid of ${snapped.cols} × ${snapped.rows} squares${lat.confidence < 0.3 ? ' (a weak match, so please check the pink lines sit on the chart’s lines)' : ''}. Adjust the corners if it’s not quite right.`,
          kind: lat.confidence < 0.3 ? 'warn' : 'good',
        };
      }
      updateInfo();
      updateNote();
      redraw();
    }

    const snap = (v: number, origin: number, step: number) => (lattice ? origin + Math.round((v - origin) / step) * step : v);

    function setCorner(which: 'tl' | 'br', wx: number, wy: number): void {
      const tl = corner('tl'), br = corner('br');
      const x = Math.min(loaded.width, Math.max(0, snap(wx, lattice?.x0 ?? 0, lattice?.cw ?? 1)));
      const y = Math.min(loaded.height, Math.max(0, snap(wy, lattice?.y0 ?? 0, lattice?.ch ?? 1)));
      const stepX = lattice?.cw ?? initialGrid.cw, stepY = lattice?.ch ?? initialGrid.ch;
      let x0 = tl.x, y0 = tl.y, x1 = br.x, y1 = br.y;
      if (which === 'tl') {
        x0 = Math.min(x, x1 - stepX);
        y0 = Math.min(y, y1 - stepY);
      } else {
        x1 = Math.max(x, x0 + stepX);
        y1 = Math.max(y, y0 + stepY);
      }
      const cols = Math.max(1, Math.round((x1 - x0) / stepX));
      const rows = Math.max(1, Math.round((y1 - y0) / stepY));
      grid = { x0, y0, cols, rows, cw: (x1 - x0) / cols, ch: (y1 - y0) / rows };
      updateInfo();
      redraw();
    }

    const vp = new Viewport({
      canvas,
      onChange: redraw,
      bounds,
      minScale: 0.05,
      maxScale: 40,
      beginDrag: (wx: number, wy: number, sx: number, sy: number) => {
        if (markMode) {
          cellBox = { x0: wx, y0: wy, x1: wx, y1: wy };
          const handler: DragHandler = {
            move: (x, y) => {
              cellBox = { x0: wx, y0: wy, x1: x, y1: y };
              redraw();
            },
            end: () => {
              const w = Math.abs(cellBox!.x1 - cellBox!.x0), hh = Math.abs(cellBox!.y1 - cellBox!.y0);
              markMode = false;
              syncMark();
              if (w < 4 || hh < 4) {
                cellBox = null;
                redraw();
                return;
              }
              findGrid();
            },
            cancel: () => {
              cellBox = null;
              markMode = false;
              syncMark();
              redraw();
            },
          };
          return handler;
        }
        for (const which of ['tl', 'br'] as const) {
          const c = corner(which);
          const s = vp.worldToScreen(c.x, c.y);
          if (dist(sx, sy, s.x, s.y) <= 32) {
            const grab = vp.screenToWorld(sx, sy);
            const dx = c.x - grab.x, dy = c.y - grab.y;
            const before = { ...grid };
            const handler: DragHandler = {
              move: (wx, wy) => setCorner(which, wx + dx, wy + dy),
              end: () => undefined,
              cancel: () => {
                grid = before;
                updateInfo();
                redraw();
              },
            };
            return handler;
          }
        }
        return null;
      },
    });

    function paint(): void {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#222';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(vp.dpr * vp.scale, 0, 0, vp.dpr * vp.scale, vp.dpr * vp.tx, vp.dpr * vp.ty);
      ctx.imageSmoothingEnabled = vp.scale < 3;
      ctx.drawImage(loaded.source, 0, 0);
      const tl = corner('tl'), br = corner('br');
      // Dim everything outside the chosen area.
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath();
      ctx.rect(0, 0, loaded.width, loaded.height);
      ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.fill('evenodd');
      // Grid lines.
      ctx.lineWidth = 1 / (vp.dpr * vp.scale) * 1.5;
      ctx.strokeStyle = 'rgba(255,45,149,0.85)';
      ctx.beginPath();
      if (grid.cw * vp.scale >= 4) {
        for (let c = 0; c <= grid.cols; c++) {
          ctx.moveTo(grid.x0 + c * grid.cw, tl.y);
          ctx.lineTo(grid.x0 + c * grid.cw, br.y);
        }
        for (let r = 0; r <= grid.rows; r++) {
          ctx.moveTo(tl.x, grid.y0 + r * grid.ch);
          ctx.lineTo(br.x, grid.y0 + r * grid.ch);
        }
      } else {
        ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      }
      ctx.stroke();
      if (cellBox) {
        ctx.lineWidth = 2 / vp.scale;
        ctx.strokeStyle = '#ffd400';
        ctx.strokeRect(Math.min(cellBox.x0, cellBox.x1), Math.min(cellBox.y0, cellBox.y1), Math.abs(cellBox.x1 - cellBox.x0), Math.abs(cellBox.y1 - cellBox.y0));
      }
      // Handles are drawn at a fixed screen size.
      ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
      (['tl', 'br'] as const).forEach((which, n) => {
        const c = corner(which);
        const s = vp.worldToScreen(c.x, c.y);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 14, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,45,149,0.9)';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = '700 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n + 1), s.x, s.y + 0.5);
      });
    }

    const info = h('div', { class: 'info' });
    const colsVal = h('span', { class: 'stepper-val' });
    const rowsVal = h('span', { class: 'stepper-val' });
    function updateInfo(): void {
      info.textContent = `${grid.cols} × ${grid.rows} squares`;
      colsVal.textContent = String(grid.cols);
      rowsVal.textContent = String(grid.rows);
    }

    function resize(axis: 'cols' | 'rows', d: number): void {
      sizeTouched = true;
      const n = Math.max(1, grid[axis] + d);
      if (axis === 'cols') {
        grid = lattice ? { ...grid, cols: n } : { ...grid, cols: n, cw: (grid.cols * grid.cw) / n };
      } else {
        grid = lattice ? { ...grid, rows: n } : { ...grid, rows: n, ch: (grid.rows * grid.ch) / n };
      }
      updateInfo();
      redraw();
    }
    const stepper = (label: string, val: HTMLElement, axis: 'cols' | 'rows') =>
      h('div', { class: 'stepper' },
        h('span', { text: label }),
        h('button', { class: 'icon-btn', text: '−', on: { click: () => resize(axis, -1) } }),
        val,
        h('button', { class: 'icon-btn', text: '+', on: { click: () => resize(axis, 1) } }),
      );
    const note = h('div', { class: 'note' });
    function updateNote(): void {
      note.className = `note ${detectNote.kind}`;
      note.textContent = detectNote.text;
      note.style.display = detectNote.text ? '' : 'none';
    }
    const markBtn = h('button', { class: 'btn small', on: { click: () => { markMode = !markMode; if (markMode) cellBox = null; syncMark(); redraw(); } } });
    function syncMark(): void {
      markBtn.textContent = markMode ? '▢ Drag around 1 square' : '▢ Mark one square';
      markBtn.classList.toggle('on', markMode);
    }
    syncMark();
    updateNote();
    const colsStepper = stepper('Columns', colsVal, 'cols');
    const rowsStepper = stepper('Rows', rowsVal, 'rows');

    const el = h('div', { class: 'screen-inner' },
      h('div', { class: 'topbar' },
        h('button', { class: 'icon-btn', text: '✕', attrs: { 'aria-label': 'Cancel' }, on: { click: onCancel } }),
        h('div', { class: 'title-wrap' }, h('div', { class: 'title', text: 'Step 1 of 2 · Line up the grid' })),
        h('button', { class: 'btn primary small', text: 'Next →', on: { click: () => { review = null; showReviewStep(); } } }),
      ),
      h('div', { class: 'stage-wrap' }, canvas),
      h('div', { class: 'bottom panel' },
        note,
        h('p', { class: 'muted', text: 'Drag pink corners 1 and 2 to the outer edges of the stitched area (a legend inside is fine). Pinch to zoom.' }),
        h('div', { class: 'row wrap' },
          h('button', { class: `btn small ${autoFailed ? 'primary' : ''}`, text: '🔍 Find grid here', on: { click: () => void findGrid() } }),
          markBtn,
        ),
        h('div', { class: 'row space' }, info, h('button', { class: 'btn small', text: 'Reset', on: { click: () => { grid = { ...initialGrid }; cellBox = null; sizeTouched = false; updateInfo(); redraw(); } } })),
        h('div', { class: 'row space' }, colsStepper, rowsStepper),
      ),
      h('div', { class: 'action-bar' },
        h('button', { class: 'btn primary big grow', text: 'Next: check colours →', on: { click: () => { review = null; showReviewStep(); } } }),
      ),
    );
    // Keep the whole image in view while the panel below settles, until the user starts moving it.
    let userMoved = false;
    canvas.addEventListener('pointerdown', () => (userMoved = true));
    const ro = new ResizeObserver(() => {
      if (!userMoved) requestAnimationFrame(() => { vp.fit(bounds(), 4); redraw(); });
    });
    ro.observe(canvas);
    show(el, () => {
      ro.disconnect();
      vp.destroy();
      cancelAnimationFrame(raf);
    });
    updateInfo();
    requestAnimationFrame(() => {
      vp.resize();
      vp.fit(bounds(), 4);
      redraw();
    });
  }

  // ---------------------------------------------------------------- step 2: colours
  interface Review {
    model: ImportModel;
    colorCount: number;
    useLegend: boolean;
    cleanup: Cleanup;
    built: BuiltPattern;
    pat: Pattern;
    /** The user has hand-edited squares; rebuilding would throw those edits away. */
    edited: boolean;
    name: string;
  }
  let review: Review | null = null;

  function makePattern(built: BuiltPattern, name: string): Pattern {
    return {
      id: 'preview',
      name,
      cols: built.cols,
      rows: built.rows,
      palette: built.palette.map((rgb) => ({ rgb, label: '' })),
      cells: built.cells,
      done: new Uint8Array(built.cells.length),
      imageW: loaded.width,
      imageH: loaded.height,
      imageGrid: { x0: grid.x0, y0: grid.y0, cw: grid.cw, ch: grid.ch },
      created: Date.now(),
      updated: Date.now(),
    };
  }

  async function startReview(): Promise<boolean> {
    const model = await withBusy('Reading the chart…', () => new ImportModel(raster, grid, legend));
    if (!model.maxColors) {
      toast('No stitches found in that area. Try adjusting the corners.');
      return false;
    }
    const useLegend = !!model.legend;
    const cleanup = model.suggestedCleanup;
    const built = await withBusy('Building the pattern…', () => model.build(model.suggestedColors, cleanup, useLegend));
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'My pattern';
    review = { model, colorCount: model.suggestedColors, useLegend, cleanup, built, pat: makePattern(built, name), edited: false, name };
    return true;
  }

  async function showReviewStep(): Promise<void> {
    if (!review && !(await startReview())) return;
    const r = review!;
    let showOriginal = false;

    const canvas = h('canvas', { class: 'stage' });
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const redraw = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw(ctx, vp, { pattern: r.pat, showOriginal, image: loaded.source, highlight: -1, preview: true });
      });
    };
    const bounds = (): Rect => {
      if (!showOriginal) return { x0: 0, y0: 0, x1: r.pat.cols, y1: r.pat.rows };
      const g = r.pat.imageGrid;
      return { x0: Math.min(0, -g.x0 / g.cw), y0: Math.min(0, -g.y0 / g.ch), x1: Math.max(r.pat.cols, (r.pat.imageW - g.x0) / g.cw), y1: Math.max(r.pat.rows, (r.pat.imageH - g.y0) / g.ch) };
    };
    const vp = new Viewport({ canvas, onChange: redraw, bounds, minScale: 0.5, maxScale: 90 });

    const segPattern = h('button', { class: 'seg active', text: 'Pattern', on: { click: () => setOriginal(false) } });
    const segOriginal = h('button', { class: 'seg', text: 'Original', on: { click: () => setOriginal(true) } });
    function setOriginal(v: boolean): void {
      showOriginal = v;
      segPattern.classList.toggle('active', !v);
      segOriginal.classList.toggle('active', v);
      redraw();
    }

    const summary = h('div', { class: 'muted' });
    const swatches = h('div', { class: 'swatches' });
    const colourNote = h('div', { class: 'note' });
    const legendBtn = h('button', { class: 'btn small', on: { click: () => change(() => { r.useLegend = true; r.colorCount = r.model.suggestedColors; }) } });
    const numIn = h('input', { class: 'num-in', attrs: { type: 'number', inputmode: 'numeric', min: '1', max: String(r.model.maxColors), step: '1', 'aria-label': 'Number of colours' } });

    /** Applies a setting change by rebuilding the pattern, after checking nothing hand-made would be lost. */
    async function change(apply: () => void): Promise<void> {
      if (r.edited && !(await confirmDialog('Changing this rebuilds the pattern and discards the squares you fixed by hand.', 'Rebuild'))) {
        refresh();
        return;
      }
      apply();
      r.built = await withBusy('Rebuilding…', () => r.model.build(r.colorCount, r.cleanup, r.useLegend));
      r.pat = makePattern(r.built, r.name);
      r.edited = false;
      refresh();
      redraw();
    }

    function refresh(): void {
      const counts = new Array(r.pat.palette.length).fill(0);
      r.pat.cells.forEach((v) => v && counts[v - 1]++);
      const stitches = counts.reduce((a: number, b: number) => a + b, 0);
      numIn.value = String(r.useLegend ? r.model.suggestedColors : r.colorCount);
      swatches.replaceChildren(
        ...r.pat.palette.map((e, k) => h('div', { class: 'swatch' }, chipCanvas(k, e.rgb, 30), h('span', { class: 'chip-count', text: String(counts[k]) }))),
      );
      summary.textContent = `${r.pat.cols} × ${r.pat.rows} squares · ${stitches} stitches · ${r.pat.palette.length} colours${r.built.removed && !r.edited ? ` · ${r.built.removed} stray squares ignored` : ''}`;
      if (r.useLegend) {
        colourNote.className = 'note good';
        const found = r.model.legendCount, extra = r.model.legend!.length - found;
        colourNote.textContent = `✓ Matched to the ${found} colours found in the chart's legend${extra ? `, plus ${extra} more the chart uses that the legend scan missed` : ''}. Change the number to group colours automatically instead.`;
        legendBtn.style.display = 'none';
      } else {
        colourNote.className = 'note';
        colourNote.textContent = r.model.legend ? 'Grouping colours automatically.' : 'No legend found in the image, so colours are grouped automatically. Raise or lower the number until the pattern looks right.';
        legendBtn.textContent = `Use the ${r.model.legend?.length ?? 0} legend colours`;
        legendBtn.style.display = r.model.legend ? '' : 'none';
      }
    }

    const setCount = (n: number) => {
      const v = Math.max(1, Math.min(r.model.maxColors, Math.round(n)));
      if (!Number.isFinite(v)) return refresh();
      if (!r.useLegend && v === r.colorCount) return refresh();
      void change(() => {
        r.useLegend = false;
        r.colorCount = v;
      });
    };
    numIn.addEventListener('change', () => setCount(Number(numIn.value)));
    const stepBy = (d: number) => setCount((r.useLegend ? r.model.suggestedColors : r.colorCount) + d);

    const cleanupOpts: [Cleanup, string][] = [['none', 'Keep everything'], ['small', 'Drop tiny bits'], ['main', 'Main picture only']];
    const cleanupBtns = cleanupOpts.map(([value, text]) => ({
      value,
      b: h('button', { class: 'seg', text, on: { click: () => { void change(() => { r.cleanup = value; }).then(syncCleanup); } } }),
    }));
    const syncCleanup = () => cleanupBtns.forEach(({ value, b }) => b.classList.toggle('active', value === r.cleanup));

    const nameIn = h('input', { class: 'text-in', attrs: { type: 'text', value: r.name, maxlength: '60' } });
    nameIn.addEventListener('input', () => {
      r.name = nameIn.value;
      r.pat.name = nameIn.value;
    });

    const create = h('button', {
      class: 'btn primary big grow',
      text: 'Start stitching →',
      on: {
        click: async () => {
          create.setAttribute('disabled', '');
          const id = crypto.randomUUID();
          const p: Pattern = { ...r.pat, id, name: r.name.trim() || 'My pattern' };
          await savePattern(p, loaded.blob);
          onCreated(id);
        },
      },
    });

    const fix = h('button', {
      class: 'btn',
      text: '✎ Fix squares',
      on: {
        click: () => {
          const ed = createEditView(r.pat, {
            persist: false,
            image: loaded.source,
            onClose: (changed) => {
              if (changed) r.edited = true;
              showReviewStep();
            },
          });
          show(ed.el, ed.destroy);
        },
      },
    });

    const el = h('div', { class: 'screen-inner' },
      h('div', { class: 'topbar' },
        h('button', { class: 'icon-btn', text: '←', attrs: { 'aria-label': 'Back' }, on: { click: () => { review = null; showGridStep(); } } }),
        h('div', { class: 'title-wrap' }, h('div', { class: 'title', text: 'Step 2 of 2 · Check it' })),
        h('div', { class: 'segmented' }, segPattern, segOriginal),
      ),
      h('div', { class: 'stage-wrap' }, canvas),
      h('div', { class: 'bottom panel scroll-panel' },
        summary,
        h('label', { class: 'field' }, h('span', { text: 'Name' }), nameIn),
        h('div', { class: 'field' },
          h('div', { class: 'row space' },
            h('span', { text: 'Number of colours' }),
            h('div', { class: 'num-field' },
              h('button', { class: 'icon-btn', text: '−', attrs: { 'aria-label': 'Fewer colours' }, on: { click: () => stepBy(-1) } }),
              numIn,
              h('button', { class: 'icon-btn', text: '+', attrs: { 'aria-label': 'More colours' }, on: { click: () => stepBy(1) } }),
            ),
          ),
          colourNote,
          legendBtn,
          swatches,
        ),
        h('div', { class: 'field' }, h('span', { text: 'Stray bits (legend, labels)' }), h('div', { class: 'segmented wide' }, ...cleanupBtns.map((c) => c.b))),
        h('p', { class: 'muted', text: 'Use “Original” above to compare with your image.' }),
      ),
      h('div', { class: 'action-bar' }, fix, create),
    );
    show(el, () => {
      vp.destroy();
      cancelAnimationFrame(raf);
    });
    syncCleanup();
    refresh();
    requestAnimationFrame(() => {
      vp.resize();
      vp.fit({ x0: 0, y0: 0, x1: r.pat.cols, y1: r.pat.rows });
      redraw();
    });
  }

  showGridStep();
  return { el: root, destroy: () => current?.destroy() };
}
