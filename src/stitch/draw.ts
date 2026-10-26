import { contrastInk, mix, rgbCss } from '../core/color';
import type { RGB } from '../core/raster';
import type { Pattern } from '../types';
import type { Viewport } from '../ui/viewport';

export interface RenderState {
  pattern: Pattern;
  /** Show the scanned chart instead of the rebuilt pattern. */
  showOriginal: boolean;
  image: CanvasImageSource | null;
  /** Palette index whose unfinished cells should stand out, or -1. */
  highlight: number;
  /** Draw every cell in full colour regardless of progress (used while importing). */
  preview?: boolean;
  /** Cell index to ring (the square being edited), or -1. */
  focus?: number;
  /** Draw the pattern's grid lines on top of the original image. */
  gridOverlay?: boolean;
}

const WHITE: RGB = [255, 255, 255];
const PAPER = '#ffffff';
const OUTSIDE = '#d9d5cc';
const HILITE = '#ff2d95';

interface Fills {
  full: string;
  ghost: string;
  faded: string;
  ink: string;
  inkGhost: string;
}

const fillCache = new WeakMap<Pattern, { rgbs: string; fills: Fills[] }>();

function fillsFor(p: Pattern): Fills[] {
  const key = p.palette.map((e) => e.rgb.join(',')).join(';');
  const hit = fillCache.get(p);
  if (hit && hit.rgbs === key) return hit.fills;
  const fills = p.palette.map((e) => ({
    full: rgbCss(e.rgb),
    ghost: rgbCss(mix(e.rgb, WHITE, 0.62)),
    faded: rgbCss(mix(mix(e.rgb, [170, 170, 170], 0.55), WHITE, 0.5)),
    ink: contrastInk(e.rgb),
    inkGhost: rgbCss(mix(e.rgb, [0, 0, 0], 0.45)),
  }));
  fillCache.set(p, { rgbs: key, fills });
  return fills;
}

/** Each palette colour gets its own little mark so cells stay identifiable when colours are close. */
export function drawSymbol(ctx: CanvasRenderingContext2D, index: number, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  switch (index % 12) {
    case 0: ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.fill(); return;
    case 1: ctx.rect(cx - r * 0.7, cy - r * 0.7, r * 1.4, r * 1.4); ctx.fill(); return;
    case 2: ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r * 0.8); ctx.lineTo(cx - r, cy + r * 0.8); ctx.closePath(); ctx.fill(); return;
    case 3: ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); ctx.fill(); return;
    case 4: ctx.moveTo(cx - r, cy - r * 0.8); ctx.lineTo(cx + r, cy - r * 0.8); ctx.lineTo(cx, cy + r); ctx.closePath(); ctx.fill(); return;
    case 5: ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.lineWidth = r * 0.3; ctx.stroke(); return;
    case 6: ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.lineWidth = r * 0.35; ctx.stroke(); return;
    case 7: ctx.moveTo(cx - r * 0.8, cy - r * 0.8); ctx.lineTo(cx + r * 0.8, cy + r * 0.8); ctx.moveTo(cx + r * 0.8, cy - r * 0.8); ctx.lineTo(cx - r * 0.8, cy + r * 0.8); ctx.lineWidth = r * 0.35; ctx.stroke(); return;
    case 8: ctx.rect(cx - r * 0.7, cy - r * 0.7, r * 1.4, r * 1.4); ctx.lineWidth = r * 0.3; ctx.stroke(); return;
    case 9: ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.lineWidth = r * 0.4; ctx.stroke(); return;
    case 10: ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.lineWidth = r * 0.4; ctx.stroke(); return;
    default:
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
      ctx.lineWidth = r * 0.3; ctx.stroke();
  }
}

/** A diagonal strike-through, drawn over a cell's symbol so finished stitches keep their identity. */
function drawSlash(ctx: CanvasRenderingContext2D, cx: number, cy: number, core: string, halo: string): void {
  const half = 0.34;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - half, cy + half);
  ctx.lineTo(cx + half, cy - half);
  ctx.strokeStyle = halo;
  ctx.lineWidth = 0.17;
  ctx.stroke();
  ctx.strokeStyle = core;
  ctx.lineWidth = 0.09;
  ctx.stroke();
}

export function draw(ctx: CanvasRenderingContext2D, vp: Viewport, s: RenderState): void {
  const { pattern: p } = s;
  const dpr = vp.dpr;
  const px = vp.scale; // CSS pixels per cell
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = OUTSIDE;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(dpr * px, 0, 0, dpr * px, dpr * vp.tx, dpr * vp.ty);

  const c0 = Math.max(0, Math.floor(-vp.tx / px));
  const c1 = Math.min(p.cols, Math.ceil((vp.width - vp.tx) / px));
  const r0 = Math.max(0, Math.floor(-vp.ty / px));
  const r1 = Math.min(p.rows, Math.ceil((vp.height - vp.ty) / px));

  if (s.showOriginal && s.image) {
    const g = p.imageGrid;
    ctx.imageSmoothingEnabled = px < 24;
    ctx.drawImage(s.image, -g.x0 / g.cw, -g.y0 / g.ch, p.imageW / g.cw, p.imageH / g.ch);
    drawOriginalOverlay(ctx, s, c0, c1, r0, r1, px);
    if (s.gridOverlay && px >= 5) drawGridLines(ctx, p, c0, c1, r0, r1, px, dpr, 'rgba(255,45,149,0.55)');
  } else {
    drawPatternCells(ctx, s, c0, c1, r0, r1, px);
    drawGridLines(ctx, p, c0, c1, r0, r1, px, dpr);
  }
  if (s.focus !== undefined && s.focus >= 0) {
    const fx = s.focus % p.cols, fy = (s.focus / p.cols) | 0;
    ctx.lineWidth = Math.max(2.5 / px, 0.08);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(fx - ctx.lineWidth * 0.5, fy - ctx.lineWidth * 0.5, 1 + ctx.lineWidth, 1 + ctx.lineWidth);
    ctx.lineWidth = Math.max(1.5 / px, 0.05);
    ctx.strokeStyle = '#0a84ff';
    ctx.strokeRect(fx - ctx.lineWidth, fy - ctx.lineWidth, 1 + 2 * ctx.lineWidth, 1 + 2 * ctx.lineWidth);
  }
  drawRulers(ctx, vp, p);
}

function drawPatternCells(ctx: CanvasRenderingContext2D, s: RenderState, c0: number, c1: number, r0: number, r1: number, px: number): void {
  const p = s.pattern;
  const fills = fillsFor(p);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, p.cols, p.rows);
  const showMarks = px >= 13;
  const hl = s.highlight;
  const outlined: number[] = [];

  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const i = r * p.cols + c;
      const v = p.cells[i];
      if (!v) continue;
      const k = v - 1;
      const f = fills[k];
      const done = !s.preview && p.done[i] === 1;
      let fill: string;
      if (hl >= 0) fill = k === hl && !done ? f.full : f.faded;
      else fill = s.preview || done ? f.full : f.ghost;
      ctx.fillStyle = fill;
      ctx.fillRect(c, r, 1, 1);
      if (hl >= 0 && k === hl && !done) outlined.push(i);

      if (showMarks) {
        const bright = hl < 0 || (k === hl && !done);
        ctx.fillStyle = s.preview ? f.ink : hl >= 0 ? (bright ? f.ink : 'rgba(0,0,0,0.32)') : done ? f.ink : f.inkGhost;
        ctx.strokeStyle = ctx.fillStyle;
        drawSymbol(ctx, k, c + 0.5, r + 0.5, 0.24);
        if (done) {
          const faint = hl >= 0;
          drawSlash(ctx, c + 0.5, r + 0.5, faint ? 'rgba(0,0,0,0.4)' : f.ink, faint ? 'rgba(255,255,255,0.4)' : f.ink === '#fff' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.7)');
        }
      }
    }
  }
  if (outlined.length) {
    ctx.strokeStyle = HILITE;
    ctx.lineWidth = Math.min(0.14, 2.5 / px);
    const inset = ctx.lineWidth / 2;
    for (const i of outlined) ctx.strokeRect((i % p.cols) + inset, ((i / p.cols) | 0) + inset, 1 - 2 * inset, 1 - 2 * inset);
  }
}

function drawOriginalOverlay(ctx: CanvasRenderingContext2D, s: RenderState, c0: number, c1: number, r0: number, r1: number, px: number): void {
  const p = s.pattern;
  const hl = s.highlight;
  // Stitched cells get a green wash (and a strike-through when large) so progress is still visible on the scan.
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const i = r * p.cols + c;
      if (!p.cells[i]) continue;
      if (!s.preview && p.done[i] === 1) {
        ctx.fillStyle = 'rgba(30,170,90,0.45)';
        ctx.fillRect(c, r, 1, 1);
        if (px >= 13) drawSlash(ctx, c + 0.5, r + 0.5, '#fff', 'rgba(0,0,0,0.55)');
      } else if (hl >= 0 && p.cells[i] - 1 === hl) {
        ctx.strokeStyle = HILITE;
        ctx.lineWidth = Math.min(0.14, 2.5 / px);
        const inset = ctx.lineWidth / 2;
        ctx.strokeRect(c + inset, r + inset, 1 - 2 * inset, 1 - 2 * inset);
      }
    }
  }
  // Frame the stitch area on the scan.
  ctx.strokeStyle = 'rgba(255,45,149,0.8)';
  ctx.lineWidth = 2 / px;
  ctx.strokeRect(0, 0, p.cols, p.rows);
}

function drawGridLines(ctx: CanvasRenderingContext2D, p: Pattern, c0: number, c1: number, r0: number, r1: number, px: number, dpr: number, thin = 'rgba(0,0,0,0.2)'): void {
  const hair = 1 / (dpr * px);
  if (px >= 5) {
    ctx.strokeStyle = thin;
    ctx.lineWidth = hair;
    ctx.beginPath();
    for (let c = c0; c <= c1; c++) {
      ctx.moveTo(c, r0);
      ctx.lineTo(c, r1);
    }
    for (let r = r0; r <= r1; r++) {
      ctx.moveTo(c0, r);
      ctx.lineTo(c1, r);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = hair * 2;
  ctx.beginPath();
  for (let c = Math.ceil(c0 / 10) * 10; c <= c1; c += 10) {
    ctx.moveTo(c, r0);
    ctx.lineTo(c, r1);
  }
  for (let r = Math.ceil(r0 / 10) * 10; r <= r1; r += 10) {
    ctx.moveTo(c0, r);
    ctx.lineTo(c1, r);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = hair * 2;
  ctx.strokeRect(0, 0, p.cols, p.rows);
}

/** Column/row numbers every 10 along the screen edges, so you can say where you are. */
function drawRulers(ctx: CanvasRenderingContext2D, vp: Viewport, p: Pattern): void {
  const px = vp.scale;
  if (px < 4) return;
  ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const label = (text: string, x: number, y: number) => {
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = 'rgba(30,30,30,0.72)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 8, w, 16, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y + 0.5);
  };
  for (let c = 0; c <= p.cols; c += 10) {
    const x = c * px + vp.tx;
    if (x > 14 && x < vp.width - 14 && c > 0) label(String(c), x, 12);
  }
  for (let r = 0; r <= p.rows; r += 10) {
    const y = r * px + vp.ty;
    if (y > 28 && y < vp.height - 14 && r > 0) label(String(r), 16, y);
  }
}
