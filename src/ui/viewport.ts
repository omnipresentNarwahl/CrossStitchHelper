export interface DragHandler {
  move(wx: number, wy: number): void;
  end(): void;
  /** A second finger arrived: undo whatever this drag did. */
  cancel(): void;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ViewportOptions {
  canvas: HTMLCanvasElement;
  /** Something changed that needs a redraw. */
  onChange(): void;
  onTap?(wx: number, wy: number): void;
  /** Called when a single finger goes down; return a handler to take over the drag, or null to pan. */
  beginDrag?(wx: number, wy: number, sx: number, sy: number): DragHandler | null;
  /** The world rectangle that should always stay partly on screen. */
  bounds(): Rect;
  minScale: number;
  maxScale: number;
}

const TAP_SLOP = 8;
const TAP_MS = 600;

/**
 * Pan/zoom for a canvas: one finger pans (or drags a handler), two fingers pinch,
 * wheel zooms. World → screen is `screen = world * scale + t` in CSS pixels.
 */
export class Viewport {
  scale = 1;
  tx = 0;
  ty = 0;
  width = 0;
  height = 0;
  dpr = 1;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private handler: DragHandler | null = null;
  private down: { x: number; y: number; t: number } | null = null;
  private moved = false;
  private pinch: { dist: number; mx: number; my: number } | null = null;
  private readonly ro: ResizeObserver;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly o: ViewportOptions) {
    const c = o.canvas;
    c.style.touchAction = 'none';
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      c.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => c.removeEventListener(type, fn as EventListener));
    };
    on('pointerdown', (e) => this.onDown(e));
    on('pointermove', (e) => this.onMove(e));
    on('pointerup', (e) => this.onUp(e));
    on('pointercancel', (e) => this.onUp(e, true));
    on('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(c);
    this.resize();
  }

  destroy(): void {
    this.ro.disconnect();
    this.cleanup.forEach((f) => f());
  }

  resize(): void {
    const c = this.o.canvas;
    const oldCx = this.width ? this.screenToWorld(this.width / 2, this.height / 2) : null;
    this.dpr = window.devicePixelRatio || 1;
    this.width = c.clientWidth;
    this.height = c.clientHeight;
    c.width = Math.max(1, Math.round(this.width * this.dpr));
    c.height = Math.max(1, Math.round(this.height * this.dpr));
    if (oldCx) this.centerOn(oldCx.x, oldCx.y);
    this.o.onChange();
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: wx * this.scale + this.tx, y: wy * this.scale + this.ty };
  }

  centerOn(wx: number, wy: number, scale = this.scale): void {
    this.scale = Math.min(this.o.maxScale, Math.max(this.o.minScale, scale));
    this.tx = this.width / 2 - wx * this.scale;
    this.ty = this.height / 2 - wy * this.scale;
    this.clamp();
  }

  /** Zoom so that the whole rectangle is visible. */
  fit(r: Rect, pad = 12): void {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    const s = Math.min((this.width - 2 * pad) / w, (this.height - 2 * pad) / h);
    this.centerOn((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, s);
    this.o.onChange();
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const ns = Math.min(this.o.maxScale, Math.max(this.o.minScale, this.scale * factor));
    const k = ns / this.scale;
    this.tx = sx - (sx - this.tx) * k;
    this.ty = sy - (sy - this.ty) * k;
    this.scale = ns;
    this.clamp();
    this.o.onChange();
  }

  private clamp(): void {
    const b = this.o.bounds();
    const cx = Math.min(b.x1, Math.max(b.x0, (this.width / 2 - this.tx) / this.scale));
    const cy = Math.min(b.y1, Math.max(b.y0, (this.height / 2 - this.ty) / this.scale));
    this.tx = this.width / 2 - cx * this.scale;
    this.ty = this.height / 2 - cy * this.scale;
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.o.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent): void {
    this.o.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.down = { ...p, t: performance.now() };
      this.moved = false;
      const w = this.screenToWorld(p.x, p.y);
      this.handler = this.o.beginDrag?.(w.x, w.y, p.x, p.y) ?? null;
    } else if (this.pointers.size === 2) {
      this.handler?.cancel();
      this.handler = null;
      this.moved = true;
      this.pinch = this.pinchState();
    }
  }

  private pinchState(): { dist: number; mx: number; my: number } {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private onMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size >= 2 && this.pinch) {
      const next = this.pinchState();
      const ns = Math.min(this.o.maxScale, Math.max(this.o.minScale, this.scale * (next.dist / this.pinch.dist)));
      const k = ns / this.scale;
      // Keep the world point under the old midpoint under the new midpoint.
      this.tx = next.mx - (this.pinch.mx - this.tx) * k;
      this.ty = next.my - (this.pinch.my - this.ty) * k;
      this.scale = ns;
      this.pinch = next;
      this.clamp();
      this.o.onChange();
      return;
    }
    if (this.handler) {
      const w = this.screenToWorld(p.x, p.y);
      this.handler.move(w.x, w.y);
      return;
    }
    if (this.down && !this.moved && Math.hypot(p.x - this.down.x, p.y - this.down.y) > TAP_SLOP) this.moved = true;
    if (this.moved) {
      this.tx += p.x - prev.x;
      this.ty += p.y - prev.y;
      this.clamp();
      this.o.onChange();
    }
  }

  private onUp(e: PointerEvent, cancelled = false): void {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    this.pinch = this.pointers.size >= 2 ? this.pinchState() : null;
    if (this.pointers.size > 0) {
      // Remaining finger keeps panning but can't count as a tap.
      this.moved = true;
      return;
    }
    if (this.handler) {
      if (cancelled) this.handler.cancel();
      else this.handler.end();
      this.handler = null;
    } else if (!cancelled && this.down && !this.moved && performance.now() - this.down.t < TAP_MS) {
      const w = this.screenToWorld(p.x, p.y);
      this.o.onTap?.(w.x, w.y);
    }
    this.down = null;
  }
}
