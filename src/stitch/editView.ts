import { chipCanvas } from '../ui/chips';
import { openColourSheet } from '../ui/colourSheet';
import { h, type View } from '../ui/dom';
import { Viewport, type DragHandler, type Rect } from '../ui/viewport';
import type { Pattern } from '../types';
import { draw } from './draw';
import { Session, type Stroke } from './session';

type Tool = 'paint' | 'pick' | 'fill';

export interface EditOptions {
  /** Save changes to the database as you go (off while the pattern hasn't been created yet). */
  persist: boolean;
  /** The scanned chart, or null if it is missing. */
  image: CanvasImageSource | null;
  /** Called when the user taps Done; `changed` says whether anything was edited. */
  onClose(changed: boolean): void;
}

/**
 * Fix-up screen: the rebuilt pattern and the original chart side by side (or stacked on a
 * phone held upright), sharing one zoom and position so a square lines up in both.
 */
export function createEditView(pattern: Pattern, opts: EditOptions): View {
  const session = new Session(pattern, opts.persist);
  let tool: Tool = 'paint';
  let brush = 1; // 0 = erase, else palette index + 1
  let dragPaints = false;
  let focus = -1;
  let layout: 'stacked' | 'side' = window.matchMedia('(orientation: portrait)').matches ? 'stacked' : 'side';

  const g = pattern.imageGrid;
  const imgRect: Rect = { x0: -g.x0 / g.cw, y0: -g.y0 / g.ch, x1: (pattern.imageW - g.x0) / g.cw, y1: (pattern.imageH - g.y0) / g.ch };
  const gridRect: Rect = { x0: 0, y0: 0, x1: pattern.cols, y1: pattern.rows };
  const bounds = (): Rect =>
    opts.image
      ? { x0: Math.min(0, imgRect.x0), y0: Math.min(0, imgRect.y0), x1: Math.max(pattern.cols, imgRect.x1), y1: Math.max(pattern.rows, imgRect.y1) }
      : gridRect;

  const cellAt = (wx: number, wy: number): number => {
    const c = Math.floor(wx), r = Math.floor(wy);
    return c < 0 || r < 0 || c >= pattern.cols || r >= pattern.rows ? -1 : r * pattern.cols + c;
  };

  // ---- painting
  const paintCell = (stroke: Stroke, i: number): void => {
    if (i < 0) return;
    focus = i;
    if (tool === 'paint') stroke.setCell(i, brush);
    else if (tool === 'pick') {
      brush = pattern.cells[i];
      tool = 'paint';
      syncTools();
    } else {
      const from = pattern.cells[i];
      if (from === brush) return;
      const seen = new Uint8Array(pattern.cells.length);
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop()!;
        stroke.setCell(j, brush);
        const c = j % pattern.cols, r = (j / pattern.cols) | 0;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= pattern.cols || nr >= pattern.rows) continue;
          const k = nr * pattern.cols + nc;
          if (!seen[k] && pattern.cells[k] === from) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
    }
    updateHint();
    redrawAll();
  };

  const interactions = () => ({
    onTap: (wx: number, wy: number) => {
      const stroke = session.begin();
      paintCell(stroke, cellAt(wx, wy));
      stroke.end();
    },
    beginDrag: (wx: number, wy: number): DragHandler | null => {
      if (!dragPaints || tool !== 'paint') return null;
      const stroke = session.begin();
      let last = -1;
      const hit = (x: number, y: number) => {
        const i = cellAt(x, y);
        if (i >= 0 && i !== last) {
          last = i;
          paintCell(stroke, i);
        }
      };
      hit(wx, wy);
      return { move: hit, end: () => stroke.end(), cancel: () => stroke.cancel() };
    },
  });

  // ---- two linked panes
  const origCanvas = h('canvas', { class: 'stage' });
  const patCanvas = h('canvas', { class: 'stage' });
  const origCtx = origCanvas.getContext('2d')!;
  const patCtx = patCanvas.getContext('2d')!;
  let origVp: Viewport | undefined;
  let patVp: Viewport | undefined;
  let syncing = false;
  let raf = 0;

  const redrawAll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (patVp) draw(patCtx, patVp, { pattern, showOriginal: false, image: opts.image, highlight: -1, preview: true, focus });
      if (origVp) draw(origCtx, origVp, { pattern, showOriginal: true, image: opts.image, highlight: -1, preview: true, focus, gridOverlay: true });
    });
  };

  const link = (self: () => Viewport | undefined, other: () => Viewport | undefined) => () => {
    const a = self(), b = other();
    if (!syncing && a && b && a.width && b.width) {
      syncing = true;
      const c = a.screenToWorld(a.width / 2, a.height / 2);
      b.centerOn(c.x, c.y, a.scale);
      syncing = false;
    }
    redrawAll();
  };

  const common = { bounds, minScale: 0.5, maxScale: 90 };
  patVp = new Viewport({ canvas: patCanvas, onChange: link(() => patVp, () => origVp), ...common, ...interactions() });
  origVp = new Viewport({ canvas: origCanvas, onChange: link(() => origVp, () => patVp), ...common, ...interactions() });

  const zoom = (f: number) => patVp!.zoomAt(patVp!.width / 2, patVp!.height / 2, f);
  const fit = () => {
    patVp!.fit(gridRect, 6);
    link(() => patVp, () => origVp)();
  };

  const panes = h('div', { class: `edit-panes ${layout}` },
    h('div', { class: 'pane' }, origCanvas, h('div', { class: 'pane-tag', text: 'Original' })),
    h('div', { class: 'pane' }, patCanvas, h('div', { class: 'pane-tag', text: 'Pattern' }), 
    ),
  );
  const fabs = h('div', { class: 'edit-fabs' },
    h('button', { class: 'fab', text: '+', attrs: { 'aria-label': 'Zoom in' }, on: { click: () => zoom(1.6) } }),
    h('button', { class: 'fab', text: '−', attrs: { 'aria-label': 'Zoom out' }, on: { click: () => zoom(1 / 1.6) } }),
    h('button', { class: 'fab', text: '⤢', attrs: { 'aria-label': 'Fit to screen' }, on: { click: fit } }),
  );
  panes.append(fabs);

  // ---- top bar
  const undoBtn = h('button', { class: 'icon-btn', text: '↶', attrs: { 'aria-label': 'Undo' }, on: { click: () => session.undo() } });
  const redoBtn = h('button', { class: 'icon-btn', text: '↷', attrs: { 'aria-label': 'Redo' }, on: { click: () => session.redo() } });
  const layoutBtn = h('button', {
    class: 'icon-btn',
    attrs: { 'aria-label': 'Switch between stacked and side-by-side' },
    on: {
      click: () => {
        layout = layout === 'stacked' ? 'side' : 'stacked';
        panes.className = `edit-panes ${layout}`;
        layoutBtn.textContent = layout === 'stacked' ? '⇅' : '⇄';
      },
    },
  });
  layoutBtn.textContent = layout === 'stacked' ? '⇅' : '⇄';
  const topbar = h('div', { class: 'topbar' },
    h('button', { class: 'btn primary small', text: '✓ Done', on: { click: () => void close() } }),
    h('div', { class: 'title-wrap' }, h('div', { class: 'title', text: 'Fix squares' })),
    layoutBtn,
    undoBtn,
    redoBtn,
  );

  // ---- bottom: tools + brush tray
  const toolBtns: Record<Tool, HTMLElement> = {
    paint: h('button', { class: 'seg', text: '🖌 Paint', on: { click: () => setTool('paint') } }),
    pick: h('button', { class: 'seg', text: '💧 Pick', on: { click: () => setTool('pick') } }),
    fill: h('button', { class: 'seg', text: '🪣 Fill', on: { click: () => setTool('fill') } }),
  };
  const dragBtn = h('button', {
    class: 'tool-btn compact',
    on: { click: () => { dragPaints = !dragPaints; syncTools(); } },
  });
  const hint = h('div', { class: 'hint' });
  const tray = h('div', { class: 'tray' });
  const coloursBtn = h('button', { class: 'tool-btn wide', text: '🎨 Colours', on: { click: () => openColourSheet({ session, onChanged: () => { buildTray(); redrawAll(); } }) } });
  const bottom = h('div', { class: 'bottom' },
    hint,
    h('div', { class: 'tool-row' }, h('div', { class: 'segmented' }, toolBtns.paint, toolBtns.pick, toolBtns.fill), dragBtn),
    tray,
    h('div', { class: 'tools' }, coloursBtn),
  );

  function setTool(t: Tool): void {
    tool = t;
    syncTools();
  }

  const name = (k: number) => pattern.palette[k]?.label || `colour ${k + 1}`;

  function updateHint(): void {
    const where = focus >= 0 ? `Row ${((focus / pattern.cols) | 0) + 1}, column ${(focus % pattern.cols) + 1}: ${pattern.cells[focus] ? name(pattern.cells[focus] - 1) : 'empty'}. ` : '';
    const what = tool === 'pick' ? 'Tap a square to pick up its colour.' : tool === 'fill' ? 'Tap to fill a connected area with the chosen colour.' : 'Pick a colour, then tap squares to paint them.';
    hint.textContent = where + what;
  }

  function syncTools(): void {
    (Object.keys(toolBtns) as Tool[]).forEach((t) => toolBtns[t].classList.toggle('active', t === tool));
    dragBtn.textContent = dragPaints ? '☝ Drag: paint' : '☝ Drag: move';
    dragBtn.classList.toggle('on', dragPaints);
    dragBtn.toggleAttribute('disabled', tool !== 'paint');
    updateTray();
    updateHint();
  }

  const chips: HTMLElement[] = [];
  let eraser: HTMLElement;
  function buildTray(): void {
    tray.replaceChildren();
    chips.length = 0;
    eraser = h('button', { class: 'chip', attrs: { 'aria-label': 'Eraser' }, on: { click: () => { brush = 0; if (tool === 'pick') tool = 'paint'; syncTools(); } } },
      h('div', { class: 'chip-face', text: '⌫' }), h('div', { class: 'chip-count', text: 'Clear' }));
    tray.append(eraser);
    pattern.palette.forEach((e, k) => {
      const chip = h('button', { class: 'chip', attrs: { 'aria-label': name(k) }, on: { click: () => { brush = k + 1; if (tool === 'pick') tool = 'paint'; syncTools(); } } },
        chipCanvas(k, e.rgb, 34),
        h('div', { class: 'chip-count', text: e.label || String(k + 1) }),
      );
      chips.push(chip);
      tray.append(chip);
    });
    updateTray();
  }
  function updateTray(): void {
    eraser?.classList.toggle('sel', brush === 0);
    chips.forEach((c, k) => c.classList.toggle('sel', brush === k + 1));
  }

  session.onChange = () => {
    undoBtn.toggleAttribute('disabled', !session.canUndo);
    redoBtn.toggleAttribute('disabled', !session.canRedo);
    if (brush > pattern.palette.length) brush = 0;
    redrawAll();
  };
  session.onChange();

  const startRevision = session.revision;
  async function close(): Promise<void> {
    await session.flush();
    opts.onClose(session.revision !== startRevision);
  }

  const root = h('div', { class: 'screen edit' }, topbar, panes, bottom);
  buildTray();
  syncTools();
  requestAnimationFrame(() => {
    origVp!.resize();
    patVp!.resize();
    fit();
  });

  return {
    el: root,
    destroy() {
      origVp?.destroy();
      patVp?.destroy();
      cancelAnimationFrame(raf);
      void session.flush();
    },
  };
}
