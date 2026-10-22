import { getImage } from '../db';
import type { Pattern } from '../types';
import { confirmDialog, h, sheet, toast, type View } from '../ui/dom';
import { Viewport, type DragHandler, type Rect } from '../ui/viewport';
import { keepAwake, wakeLockSupported } from '../wakelock';
import { exportPattern } from '../backup';
import { deletePattern } from '../db';
import { chipCanvas } from '../ui/chips';
import { openColourSheet } from '../ui/colourSheet';
import { draw, type RenderState } from './draw';
import { Session, type Stroke } from './session';

const PREF_KEY = 'csh-prefs';

interface Prefs {
  swipe: boolean;
  awake: boolean;
}

function loadPrefs(): Prefs {
  try {
    return { swipe: false, awake: true, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') };
  } catch {
    return { swipe: false, awake: true };
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* private mode etc. */
  }
}

export async function createStitchView(pattern: Pattern, goHome: () => void, onEdit: () => void): Promise<View> {
  const session = new Session(pattern);
  const prefs = loadPrefs();
  let showOriginal = false;
  let highlight = -1;
  let image: ImageBitmap | null = null;

  const blob = await getImage(pattern.id);
  if (blob) image = await createImageBitmap(blob);

  const canvas = h('canvas', { class: 'stage' });
  const ctx = canvas.getContext('2d')!;
  let raf = 0;
  const state: RenderState = { pattern, showOriginal, image, highlight };
  const redraw = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      state.showOriginal = showOriginal;
      state.highlight = highlight;
      draw(ctx, vp, state);
    });
  };

  const bounds = (): Rect => {
    const g = pattern.imageGrid;
    const imgRect = { x0: -g.x0 / g.cw, y0: -g.y0 / g.ch, x1: (pattern.imageW - g.x0) / g.cw, y1: (pattern.imageH - g.y0) / g.ch };
    return showOriginal && image
      ? { x0: Math.min(0, imgRect.x0), y0: Math.min(0, imgRect.y0), x1: Math.max(pattern.cols, imgRect.x1), y1: Math.max(pattern.rows, imgRect.y1) }
      : { x0: 0, y0: 0, x1: pattern.cols, y1: pattern.rows };
  };

  const cellAt = (wx: number, wy: number): number => {
    const c = Math.floor(wx), r = Math.floor(wy);
    return c < 0 || r < 0 || c >= pattern.cols || r >= pattern.rows ? -1 : r * pattern.cols + c;
  };

  /** Tapping or swiping on the canvas toggles stitches; a swipe sets every cell to the opposite of the first one touched. */
  const makeStroke = (first: number): { stroke: Stroke; apply: (i: number) => void } => {
    const stroke = session.begin();
    const target: 0 | 1 = first >= 0 && pattern.done[first] ? 0 : 1;
    return { stroke, apply: (i) => stroke.setDone(i, target) };
  };

  const vp = new Viewport({
    canvas,
    onChange: redraw,
    bounds,
    minScale: 0.5,
    maxScale: 90,
    onTap: (wx, wy) => {
      const i = cellAt(wx, wy);
      if (i < 0) return;
      const { stroke, apply } = makeStroke(i);
      apply(i);
      stroke.end();
    },
    beginDrag: (wx, wy) => {
      if (!prefs.swipe) return null;
      const first = cellAt(wx, wy);
      const { stroke, apply } = makeStroke(first);
      let last = -1;
      const hit = (x: number, y: number) => {
        const i = cellAt(x, y);
        if (i >= 0 && i !== last) {
          last = i;
          apply(i);
        }
      };
      hit(wx, wy);
      const handler: DragHandler = {
        move: hit,
        end: () => stroke.end(),
        cancel: () => stroke.cancel(),
      };
      return handler;
    },
  });

  // ----- top bar
  const title = h('div', { class: 'title' });
  const progressBar = h('div', { class: 'progress-fill' });
  const segPattern = h('button', { class: 'seg active', text: 'Pattern', on: { click: () => setOriginal(false) } });
  const segOriginal = h('button', { class: 'seg', text: 'Original', on: { click: () => setOriginal(true) } });
  const topbar = h('div', { class: 'topbar' },
    h('button', { class: 'icon-btn', text: '←', attrs: { 'aria-label': 'Back' }, on: { click: async () => { await session.flush(); goHome(); } } }),
    h('div', { class: 'title-wrap' }, title, h('div', { class: 'progress' }, progressBar)),
    h('div', { class: 'segmented' }, segPattern, segOriginal),
  );

  function setOriginal(v: boolean): void {
    if (v && !image) return toast('The original image is missing');
    showOriginal = v;
    segPattern.classList.toggle('active', !v);
    segOriginal.classList.toggle('active', v);
    redraw();
  }

  // ----- floating buttons
  const undoBtn = h('button', { class: 'fab', text: '↶', attrs: { 'aria-label': 'Undo' }, on: { click: () => session.undo() } });
  const redoBtn = h('button', { class: 'fab', text: '↷', attrs: { 'aria-label': 'Redo' }, on: { click: () => session.redo() } });
  const fitBtn = h('button', { class: 'fab', text: '⤢', attrs: { 'aria-label': 'Fit to screen' }, on: { click: () => fitView() } });
  const zoomIn = h('button', { class: 'fab', text: '+', attrs: { 'aria-label': 'Zoom in' }, on: { click: () => vp.zoomAt(vp.width / 2, vp.height / 2, 1.6) } });
  const zoomOut = h('button', { class: 'fab', text: '−', attrs: { 'aria-label': 'Zoom out' }, on: { click: () => vp.zoomAt(vp.width / 2, vp.height / 2, 1 / 1.6) } });
  const fabs = h('div', { class: 'fabs' }, zoomIn, zoomOut, fitBtn, undoBtn, redoBtn);

  function fitView(): void {
    vp.fit({ x0: 0, y0: 0, x1: pattern.cols, y1: pattern.rows });
    saveView();
  }

  // ----- bottom: tools + palette tray
  const swipeBtn = h('button', { class: 'tool-btn', on: { click: () => { prefs.swipe = !prefs.swipe; savePrefs(prefs); updateTools(); } } });
  const editBtn = h('button', { class: 'tool-btn', text: '✎ Fix squares', on: { click: async () => { await session.flush(); onEdit(); } } });
  const coloursBtn = h('button', { class: 'tool-btn', text: '🎨 Colours', on: { click: openColours } });
  const moreBtn = h('button', { class: 'tool-btn', text: '⋯', attrs: { 'aria-label': 'More' }, on: { click: openMenu } });
  const hint = h('div', { class: 'hint' });
  const tools = h('div', { class: 'tools' }, swipeBtn, editBtn, coloursBtn, moreBtn);
  const tray = h('div', { class: 'tray' });
  const bottom = h('div', { class: 'bottom' }, hint, tray, tools);

  function updateTools(): void {
    swipeBtn.textContent = prefs.swipe ? '👆 Swipe' : '👆 Tap';
    swipeBtn.title = 'Switch between tapping single stitches and swiping across many';
    swipeBtn.classList.toggle('on', prefs.swipe);
    if (highlight >= 0) hint.textContent = `Highlighting unfinished ${labelOf(highlight)} · tap the colour again to clear`;
    else hint.textContent = prefs.swipe ? 'Swipe over stitches to mark them. Two fingers to move and zoom.' : 'Tap a square to mark it done. Drag to move, pinch to zoom.';
    hint.classList.toggle('hl', highlight >= 0);
  }

  const labelOf = (k: number) => pattern.palette[k].label || `colour ${k + 1}`;

  const chips: { el: HTMLElement; count: HTMLElement }[] = [];
  function buildTray(): void {
    tray.replaceChildren();
    chips.length = 0;
    pattern.palette.forEach((e, k) => {
      const count = h('div', { class: 'chip-count' });
      const el = h('button', {
        class: 'chip',
        attrs: { 'aria-label': e.label || `Colour ${k + 1}` },
        on: {
          click: () => {
            highlight = highlight === k ? -1 : k;
            updateTray();
            updateTools();
            redraw();
          },
        },
      }, chipCanvas(k, e.rgb, 34), count);
      chips.push({ el, count });
      tray.append(el);
    });
  }

  function updateTray(): void {
    chips.forEach(({ el, count }, k) => {
      el.classList.toggle('sel', highlight === k);
      el.classList.toggle('finished', session.left[k] === 0);
      count.textContent = session.left[k] === 0 ? '✓' : String(session.left[k]);
    });
  }

  function updateProgress(): void {
    const done = session.totalAll - session.leftAll;
    const pct = session.totalAll ? Math.floor((done / session.totalAll) * 100) : 0;
    title.textContent = `${pattern.name} · ${pct}%`;
    title.title = `${done} of ${session.totalAll} stitches done`;
    progressBar.style.width = `${session.totalAll ? (done / session.totalAll) * 100 : 0}%`;
    undoBtn.toggleAttribute('disabled', !session.canUndo);
    redoBtn.toggleAttribute('disabled', !session.canRedo);
    updateTray();
    redraw();
  }
  session.onChange = updateProgress;

  // ----- sheets
  function openColours(): void {
    openColourSheet({
      session,
      onChanged: () => {
        if (highlight >= pattern.palette.length) highlight = -1;
        buildTray();
        updateTools();
        updateProgress();
      },
      onHighlight: (k) => {
        highlight = highlight === k ? -1 : k;
        updateTools();
        updateTray();
        redraw();
      },
    });
  }

  function openMenu(): void {
    const body = h('div', { class: 'sheet-body' });
    const awakeLabel = wakeLockSupported ? 'Keep screen on' : 'Keep screen on (not supported by this browser)';
    const awake = h('label', { class: 'switch-row' },
      h('span', { text: awakeLabel }),
      h('input', { attrs: { type: 'checkbox', ...(prefs.awake ? { checked: '' } : {}), ...(wakeLockSupported ? {} : { disabled: '' }) }, on: { change: (e) => { prefs.awake = (e.target as HTMLInputElement).checked; savePrefs(prefs); keepAwake(prefs.awake); } } }),
    );
    const nameIn = h('input', { class: 'text-in', attrs: { type: 'text', value: pattern.name, maxlength: '60' } });
    nameIn.addEventListener('change', () => {
      pattern.name = nameIn.value.trim() || pattern.name;
      session.paletteChanged();
    });
    body.append(
      awake,
      h('label', { class: 'field' }, h('span', { text: 'Pattern name' }), nameIn),
      h('div', { class: 'col' },
        h('button', { class: 'btn', text: 'Fit pattern to screen', on: { click: () => { m.close(); fitView(); } } }),
        h('button', { class: 'btn', text: 'Save a backup file', on: { click: () => void exportPattern(pattern) } }),
        h('button', {
          class: 'btn danger',
          text: 'Start over (clear all progress)',
          on: {
            click: async () => {
              m.close();
              if (!(await confirmDialog('Clear every checked stitch in this pattern?', 'Clear progress'))) return;
              const st = session.begin();
              for (let i = 0; i < pattern.done.length; i++) st.setDone(i, 0);
              st.end();
            },
          },
        }),
        h('button', {
          class: 'btn danger',
          text: 'Delete this pattern',
          on: {
            click: async () => {
              m.close();
              if (!(await confirmDialog(`Delete “${pattern.name}” and its progress from this phone?`, 'Delete'))) return;
              await deletePattern(pattern.id);
              goHome();
            },
          },
        }),
      ),
    );
    const m = sheet('Pattern options', body);
  }

  // ----- assemble
  const root = h('div', { class: 'screen stitch' }, topbar, h('div', { class: 'stage-wrap' }, canvas, fabs), bottom);

  buildTray();
  updateTools();
  updateProgress();

  // Restore where we were, once the canvas has been laid out.
  requestAnimationFrame(() => {
    vp.resize();
    if (pattern.view) vp.centerOn(pattern.view.cx, pattern.view.cy, pattern.view.scale);
    else fitView();
    redraw();
  });

  let viewTimer = 0;
  const saveView = () => {
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(() => {
      const c = vp.screenToWorld(vp.width / 2, vp.height / 2);
      session.setView({ cx: c.x, cy: c.y, scale: vp.scale });
    }, 600);
  };
  canvas.addEventListener('pointerup', saveView);
  canvas.addEventListener('wheel', saveView, { passive: true });

  keepAwake(prefs.awake);
  const onHide = () => void session.flush();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);

  return {
    el: root,
    destroy() {
      keepAwake(false);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      vp.destroy();
      cancelAnimationFrame(raf);
      clearTimeout(viewTimer);
      void session.flush();
      image?.close();
    },
  };
}
