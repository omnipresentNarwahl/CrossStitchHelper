import { autoGrid, ImportModel, type BuiltPattern, type Cleanup } from '../core/model';
import { contrastInk } from '../core/color';
import type { Raster } from '../core/raster';
import type { GridSpec } from '../core/sample';
import { savePattern } from '../db';
import { draw } from '../stitch/draw';
import type { Pattern } from '../types';
import { chipCanvas } from '../ui/chips';
import { h, toast, type View } from '../ui/dom';
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
  const { raster } = loaded;

  const auto = autoGrid(raster);
  const lattice = auto && auto.confidence > 0.2 ? auto.grid : null;
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
      beginDrag: (_wx: number, _wy: number, sx: number, sy: number) => {
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
    const colsStepper = stepper('Columns', colsVal, 'cols');
    const rowsStepper = stepper('Rows', rowsVal, 'rows');

    const el = h('div', { class: 'screen-inner' },
      h('div', { class: 'topbar' },
        h('button', { class: 'icon-btn', text: '✕', attrs: { 'aria-label': 'Cancel' }, on: { click: onCancel } }),
        h('div', { class: 'title-wrap' }, h('div', { class: 'title', text: 'Step 1 of 2 · Line up the grid' })),
        h('button', { class: 'btn primary small', text: 'Next →', on: { click: () => showReviewStep() } }),
      ),
      h('div', { class: 'stage-wrap' }, canvas),
      h('div', { class: 'bottom panel' },
        h('p', { class: 'muted', text: auto ? 'Drag the pink corners 1 and 2 to the outer edges of the stitched area (legend boxes are fine to leave inside). Pinch to zoom.' : 'Could not find the grid automatically. Drag the corners around the chart, then set the number of columns and rows.' }),
        h('div', { class: 'row space' }, info, h('button', { class: 'btn small', text: 'Reset', on: { click: () => { grid = { ...initialGrid }; updateInfo(); redraw(); } } })),
        h('div', { class: 'row space' }, colsStepper, rowsStepper),
      ),
    );
    show(el, () => {
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
  function showReviewStep(): void {
    const model = new ImportModel(raster, grid);
    if (!model.maxColors) {
      toast('No stitches found in that area. Try adjusting the corners.');
      return;
    }
    let colorCount = model.suggestedColors;
    let cleanup: Cleanup = model.suggestedCleanup;
    let built: BuiltPattern = model.build(colorCount, cleanup);
    let showOriginal = false;
    let name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'My pattern';

    const preview = (): Pattern => ({
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
    });
    let pat = preview();

    const canvas = h('canvas', { class: 'stage' });
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    const redraw = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw(ctx, vp, { pattern: pat, showOriginal, image: loaded.source, highlight: -1, preview: true });
      });
    };
    const bounds = (): Rect => {
      if (!showOriginal) return { x0: 0, y0: 0, x1: pat.cols, y1: pat.rows };
      const g = pat.imageGrid;
      return { x0: Math.min(0, -g.x0 / g.cw), y0: Math.min(0, -g.y0 / g.ch), x1: Math.max(pat.cols, (pat.imageW - g.x0) / g.cw), y1: Math.max(pat.rows, (pat.imageH - g.y0) / g.ch) };
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
    const countLabel = h('strong');
    const slider = h('input', { class: 'slider', attrs: { type: 'range', min: '2', max: String(Math.max(2, model.maxColors)), value: String(colorCount) } });
    function rebuild(): void {
      built = model.build(colorCount, cleanup);
      pat = preview();
      countLabel.textContent = `${built.palette.length} colours`;
      const counts = new Array(built.palette.length).fill(0);
      built.cells.forEach((v) => v && counts[v - 1]++);
      swatches.replaceChildren(
        ...built.palette.map((rgb, k) => h('div', { class: 'swatch' }, chipCanvas(k, rgb, 30), h('span', { class: 'chip-count', style: { color: contrastInk([255, 255, 255]) }, text: String(counts[k]) }))),
      );
      const stitches = counts.reduce((a: number, b: number) => a + b, 0);
      summary.textContent = `${built.cols} × ${built.rows} squares · ${stitches} stitches${built.removed ? ` · ${built.removed} stray squares ignored` : ''}`;
      redraw();
    }
    slider.addEventListener('input', () => {
      colorCount = Number(slider.value);
      rebuild();
    });

    const cleanupOpts: [Cleanup, string][] = [['none', 'Keep everything'], ['small', 'Drop tiny bits'], ['main', 'Main picture only']];
    const cleanupBtns = cleanupOpts.map(([value, text]) => {
      const b = h('button', { class: 'seg', text, on: { click: () => { cleanup = value; sync(); rebuild(); } } });
      return { value, b };
    });
    const sync = () => cleanupBtns.forEach(({ value, b }) => b.classList.toggle('active', value === cleanup));
    sync();

    const nameIn = h('input', { class: 'text-in', attrs: { type: 'text', value: name, maxlength: '60' } });
    nameIn.addEventListener('input', () => (name = nameIn.value));

    const create = h('button', {
      class: 'btn primary big',
      text: 'Start stitching',
      on: {
        click: async () => {
          create.setAttribute('disabled', '');
          const id = crypto.randomUUID();
          const p: Pattern = {
            ...pat,
            id,
            name: name.trim() || 'My pattern',
            palette: built.palette.map((rgb) => ({ rgb, label: '' })),
          };
          await savePattern(p, loaded.blob);
          onCreated(id);
        },
      },
    });

    const el = h('div', { class: 'screen-inner' },
      h('div', { class: 'topbar' },
        h('button', { class: 'icon-btn', text: '←', attrs: { 'aria-label': 'Back' }, on: { click: () => showGridStep() } }),
        h('div', { class: 'title-wrap' }, h('div', { class: 'title', text: 'Step 2 of 2 · Check it' })),
        h('div', { class: 'segmented' }, segPattern, segOriginal),
      ),
      h('div', { class: 'stage-wrap' }, canvas),
      h('div', { class: 'bottom panel scroll-panel' },
        summary,
        h('label', { class: 'field' }, h('span', { text: 'Name' }), nameIn),
        h('div', { class: 'field' }, h('div', { class: 'row space' }, h('span', { text: 'Number of colours' }), countLabel), slider, swatches),
        h('div', { class: 'field' }, h('span', { text: 'Stray bits (legend, labels)' }), h('div', { class: 'segmented wide' }, ...cleanupBtns.map((c) => c.b))),
        h('p', { class: 'muted', text: 'Tap “Original” above to compare with your image. You can fix individual squares later with “Edit cells”.' }),
        create,
      ),
    );
    show(el, () => {
      vp.destroy();
      cancelAnimationFrame(raf);
    });
    rebuild();
    requestAnimationFrame(() => {
      vp.resize();
      vp.fit({ x0: 0, y0: 0, x1: pat.cols, y1: pat.rows });
      redraw();
    });
  }

  showGridStep();
  return { el: root, destroy: () => current?.destroy() };
}
