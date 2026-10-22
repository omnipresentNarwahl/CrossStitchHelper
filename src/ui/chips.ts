import { contrastInk, rgbCss } from '../core/color';
import type { RGB } from '../core/raster';
import { drawSymbol } from '../stitch/draw';
import { h } from './dom';

/** A small colour swatch carrying the colour's chart symbol. */
export function chipCanvas(index: number, rgb: RGB, size: number): HTMLCanvasElement {
  const c = h('canvas', { class: 'chip-canvas' });
  const dpr = window.devicePixelRatio || 1;
  c.width = c.height = Math.round(size * dpr);
  c.style.width = c.style.height = `${size}px`;
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = rgbCss(rgb);
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = ctx.strokeStyle = contrastInk(rgb);
  drawSymbol(ctx, index, size / 2, size / 2, size * 0.24);
  return c;
}

