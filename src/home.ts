import { importBackup } from './backup';
import { deletePattern, listPatterns } from './db';
import { h, toast, confirmDialog, type View } from './ui/dom';
import type { Pattern } from './types';

export function thumbnail(p: Pattern): HTMLCanvasElement {
  const c = h('canvas', { class: 'thumb' });
  c.width = p.cols;
  c.height = p.rows;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(p.cols, p.rows);
  for (let i = 0; i < p.cells.length; i++) {
    const v = p.cells[i];
    const o = i * 4;
    if (!v) {
      img.data.set([255, 255, 255, 255], o);
      continue;
    }
    const [r, g, b] = p.palette[v - 1].rgb;
    const t = p.done[i] ? 0 : 0.62;
    img.data.set([r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t, 255], o);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function createHome(onOpen: (id: string) => void, onNewImage: (file: File) => void): View {
  const list = h('div', { class: 'cards' });
  const picker = h('input', { attrs: { type: 'file', accept: 'image/*', hidden: '' } });
  const restore = h('input', { attrs: { type: 'file', accept: '.json,application/json', hidden: '' } });

  picker.addEventListener('change', () => {
    const f = picker.files?.[0];
    picker.value = '';
    if (f) onNewImage(f);
  });
  restore.addEventListener('change', async () => {
    const f = restore.files?.[0];
    restore.value = '';
    if (!f) return;
    try {
      onOpen(await importBackup(f));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not read that file');
    }
  });

  async function render(): Promise<void> {
    const patterns = await listPatterns();
    list.replaceChildren();
    if (!patterns.length) {
      list.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-icon', text: '🧵' }),
        h('p', { text: 'No patterns yet.' }),
        h('p', { class: 'muted', text: 'Add a photo or screenshot of a cross stitch chart and the app will turn it into squares you can check off.' }),
      ));
    }
    for (const p of patterns) {
      const total = p.cells.reduce((n, v) => n + (v ? 1 : 0), 0);
      const done = p.done.reduce((n, v) => n + v, 0);
      const pct = total ? Math.floor((done / total) * 100) : 0;
      list.append(h('div', { class: 'card' },
        h('button', { class: 'card-main', on: { click: () => onOpen(p.id) } },
          h('div', { class: 'thumb-wrap' }, thumbnail(p)),
          h('div', { class: 'card-text' },
            h('strong', { text: p.name }),
            h('span', { class: 'muted', text: `${p.cols} × ${p.rows} · ${p.palette.length} colours` }),
            h('div', { class: 'progress' }, h('div', { class: 'progress-fill', style: { width: `${pct}%` } })),
            h('span', { class: 'muted', text: `${pct}% · ${total - done} stitches left` }),
          ),
        ),
        h('button', {
          class: 'icon-btn',
          text: '🗑',
          attrs: { 'aria-label': `Delete ${p.name}` },
          on: {
            click: async () => {
              if (await confirmDialog(`Delete “${p.name}” and its progress from this phone?`, 'Delete')) {
                await deletePattern(p.id);
                void render();
              }
            },
          },
        }),
      ));
    }
  }

  const root = h('div', { class: 'screen home' },
    h('div', { class: 'topbar' }, h('div', { class: 'title-wrap' }, h('div', { class: 'title big', text: 'Cross Stitch Helper' }))),
    h('div', { class: 'scroll' },
      list,
      h('div', { class: 'home-actions' },
        h('button', { class: 'btn primary big', text: '＋ New pattern from image', on: { click: () => picker.click() } }),
        h('button', { class: 'btn', text: 'Restore from backup', on: { click: () => restore.click() } }),
      ),
    ),
    picker,
    restore,
  );
  void render();
  return { el: root, destroy() { /* nothing to clean up */ } };
}
