import { getImage, savePattern } from './db';
import type { Pattern } from './types';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}

/** Downloads one pattern (with its original image and progress) as a .json file. */
export async function exportPattern(p: Pattern): Promise<void> {
  const image = await getImage(p.id);
  const data = {
    app: 'cross-stitch-helper',
    version: 1,
    pattern: { ...p, cells: toBase64(p.cells), done: toBase64(p.done) },
    image: image ? await blobToDataUrl(image) : null,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${p.name.replace(/[^\w-]+/g, '_') || 'pattern'}.stitch.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Restores a backup written by exportPattern. Returns the pattern's id. */
export async function importBackup(file: File): Promise<string> {
  const data = JSON.parse(await file.text());
  if (data.app !== 'cross-stitch-helper' || !data.pattern) throw new Error('That is not a backup from this app');
  const raw = data.pattern;
  const p: Pattern = { ...raw, cells: fromBase64(raw.cells), done: fromBase64(raw.done) };
  if (p.cells.length !== p.cols * p.rows || p.done.length !== p.cells.length) throw new Error('The backup file is damaged');
  await savePattern(p, data.image ? await dataUrlToBlob(data.image) : undefined);
  return p.id;
}
