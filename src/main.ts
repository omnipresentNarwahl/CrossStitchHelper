import './style.css';
import { getImage, getPattern, requestPersistence } from './db';
import { createHome } from './home';
import { createImportView } from './import/importView';
import { createEditView } from './stitch/editView';
import { createStitchView } from './stitch/stitchView';
import { h, toast, type View } from './ui/dom';

const app = document.getElementById('app')!;
let view: View | null = null;
let token = 0;
let pendingFile: File | null = null;
let internalNav = false;

function go(hash: string): void {
  internalNav = true;
  location.hash = hash;
}

function goHome(): void {
  if (internalNav && history.length > 1) history.back();
  else location.replace('#/');
}

async function route(): Promise<void> {
  const mine = ++token;
  view?.destroy();
  view = null;
  app.replaceChildren();

  const hash = location.hash;
  let next: View | null = null;
  try {
    if (hash.startsWith('#/p/')) {
      const p = await getPattern(decodeURIComponent(hash.slice(4)));
      if (!p) {
        toast('That pattern is not on this phone');
        location.replace('#/');
        return;
      }
      next = await createStitchView(p, goHome, () => go(`#/edit/${p.id}`));
    } else if (hash.startsWith('#/edit/')) {
      const p = await getPattern(decodeURIComponent(hash.slice(7)));
      if (!p) {
        location.replace('#/');
        return;
      }
      const blob = await getImage(p.id);
      const image = blob ? await createImageBitmap(blob) : null;
      const back = () => {
        if (internalNav && history.length > 1) history.back();
        else location.replace(`#/p/${p.id}`);
      };
      const edit = createEditView(p, { persist: true, image, onClose: back });
      next = { el: edit.el, destroy: () => { edit.destroy(); image?.close(); } };
    } else if (hash === '#/import') {
      const file = pendingFile;
      pendingFile = null;
      if (!file) {
        location.replace('#/');
        return;
      }
      next = await createImportView(
        file,
        (id) => location.replace(`#/p/${id}`),
        goHome,
      );
    } else {
      next = createHome(
        (id) => go(`#/p/${id}`),
        (file) => {
          pendingFile = file;
          go('#/import');
        },
      );
    }
  } catch (e) {
    console.error(e);
    next = { el: h('div', { class: 'empty' }, h('p', { text: 'Something went wrong loading this screen.' }), h('a', { attrs: { href: '#/' }, text: 'Back to patterns' })), destroy() { /* nothing */ } };
  }
  if (mine !== token) {
    next.destroy();
    return;
  }
  view = next;
  app.append(next.el);
}

window.addEventListener('hashchange', () => void route());
void route();
requestPersistence();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
