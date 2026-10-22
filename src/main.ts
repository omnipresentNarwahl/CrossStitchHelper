import './style.css';
import { getPattern, requestPersistence } from './db';
import { createHome } from './home';
import { createImportView } from './import/importView';
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
      next = await createStitchView(p, goHome);
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
