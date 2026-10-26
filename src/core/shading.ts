import { luma, type Raster } from './raster';

/**
 * Screenshots of a PDF often have a translucent dark band across the top (a toolbar shadow) that
 * dims everything under it. Finds rows whose page background is much darker than the rest and
 * brightens them back, so colours and grid lines read the same all the way down.
 * Returns the input untouched when there is no such band.
 */
export function correctShading(img: Raster): Raster {
  const { width: w, height: h, data } = img;
  const x0 = Math.floor(w * 0.2), x1 = Math.ceil(w * 0.8);
  const level = new Float32Array(h);
  const row: number[] = [];
  for (let y = 0; y < h; y++) {
    row.length = 0;
    for (let x = x0; x < x1; x += 2) {
      const i = (y * w + x) * 4;
      row.push(luma(data[i], data[i + 1], data[i + 2]));
    }
    row.sort((a, b) => a - b);
    level[y] = row[Math.floor(row.length * 0.9)];
  }
  const sorted = [...level].sort((a, b) => a - b);
  const ref = sorted[Math.floor(h * 0.7)];
  if (ref < 150) return img; // not a pale page

  // A shadow band is a stretch of rows that are mostly about equally dim. Isolated dim rows are
  // just dense content (text, a dark block of thread), so leave those alone.
  const gain = new Float32Array(h).fill(1);
  let any = false;
  const dim = (y: number) => level[y] < ref * 0.88 && level[y] > ref * 0.3;
  for (let y = 0; y < h; ) {
    if (!dim(y)) {
      y++;
      continue;
    }
    // Grow the band, bridging short breaks (a frame line or a row of lettering inside it).
    let end = y + 1;
    for (let probe = y + 1; probe < h && probe - end <= 4; probe++) if (dim(probe)) end = probe + 1;
    const rows = [];
    for (let r = y; r < end; r++) if (dim(r)) rows.push(level[r]);
    const med = [...rows].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    const steady = rows.filter((v) => Math.abs(v - med) <= med * 0.08).length;
    if (end - y >= 10 && steady >= rows.length * 0.6) {
      for (let r = y; r < end; r++) gain[r] = Math.min(3, ref / med);
      any = true;
    }
    y = end;
  }
  if (!any) return img;

  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    const g = gain[y];
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = data[i] * g;
      out[i + 1] = data[i + 1] * g;
      out[i + 2] = data[i + 2] * g;
      out[i + 3] = data[i + 3];
    }
  }
  return { width: w, height: h, data: out };
}
