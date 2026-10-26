import { labDist, rgbToLab, type Lab } from './color';
import type { RGB } from './raster';

interface Cluster {
  lab: Lab;
  rgb: [number, number, number];
  weight: number;
  members: number[];
}

/**
 * Agglomerative colour clustering. `build` merges the closest pair of colours again and
 * again and remembers the order, so `cut` can give back any number of colours instantly
 * (that's what the "number of colours" slider drives).
 */
class Agglomerative {
  /** Distinct input colours. */
  readonly colors: RGB[];
  readonly weights: number[];
  /** Each merge: the two cluster ids merged and how far apart they were. */
  private readonly merges: { a: number; b: number; dist: number }[] = [];
  private readonly total: number;

  constructor(colors: RGB[], weights: number[]) {
    this.colors = colors;
    this.weights = weights;
    this.total = colors.length;

    const live = new Map<number, Cluster>();
    colors.forEach((rgb, i) => live.set(i, { lab: rgbToLab(rgb), rgb: [...rgb], weight: weights[i], members: [i] }));
    let nextId = colors.length;
    while (live.size > 1) {
      let ba = -1, bb = -1, bd = Infinity;
      const ids = [...live.keys()];
      for (let i = 0; i < ids.length; i++) {
        const ci = live.get(ids[i])!;
        for (let j = i + 1; j < ids.length; j++) {
          const cj = live.get(ids[j])!;
          // Rare colours should be absorbed by common ones sooner than two big areas merge.
          const d = labDist(ci.lab, cj.lab);
          if (d < bd) {
            bd = d;
            ba = ids[i];
            bb = ids[j];
          }
        }
      }
      const A = live.get(ba)!, B = live.get(bb)!;
      const w = A.weight + B.weight;
      const merged: Cluster = {
        weight: w,
        members: [...A.members, ...B.members],
        lab: [0, 1, 2].map((k) => (A.lab[k] * A.weight + B.lab[k] * B.weight) / w) as Lab,
        rgb: [0, 1, 2].map((k) => (A.rgb[k] * A.weight + B.rgb[k] * B.weight) / w) as RGB,
      };
      live.delete(ba);
      live.delete(bb);
      live.set(nextId++, merged);
      this.merges.push({ a: ba, b: bb, dist: bd });
    }
  }

  /** The largest colour count at which no two colours are closer than `minDist`. */
  countForDistance(minDist: number): number {
    let n = this.total;
    for (const m of this.merges) {
      if (m.dist >= minDist) break;
      n--;
    }
    return Math.max(1, n);
  }

  /** Assigns each input colour to one of `count` clusters. */
  cut(count: number, minSize = 0): { assign: number[]; palette: RGB[]; sizes: number[] } {
    const n = this.total;
    count = Math.max(1, Math.min(n, count));
    const members = new Map<number, number[]>();
    for (let i = 0; i < n; i++) members.set(i, [i]);
    let nextId = n;
    for (let s = 0; s < n - count; s++) {
      const { a, b } = this.merges[s];
      members.set(nextId++, [...members.get(a)!, ...members.get(b)!]);
      members.delete(a);
      members.delete(b);
    }
    // Most-used colour first.
    let groups = [...members.values()].map((m) => ({ m, w: m.reduce((s, i) => s + this.weights[i], 0) }));
    groups.sort((x, y) => y.w - x.w);
    const centroid = (m: number[]): Lab => {
      const sum = [0, 0, 0];
      let w = 0;
      for (const i of m) {
        const lab = rgbToLab(this.colors[i]);
        for (let k = 0; k < 3; k++) sum[k] += lab[k] * this.weights[i];
        w += this.weights[i];
      }
      return sum.map((v) => v / w) as Lab;
    };
    const big = groups.filter((g) => g.w >= minSize);
    if (minSize > 0 && big.length > 0 && big.length < groups.length) {
      const bigLabs = big.map((g) => centroid(g.m));
      for (const g of groups) {
        if (g.w >= minSize) continue;
        const lab = centroid(g.m);
        let best = 0;
        for (let b = 1; b < big.length; b++) if (labDist(lab, bigLabs[b]) < labDist(lab, bigLabs[best])) best = b;
        big[best].m.push(...g.m);
        big[best].w += g.w;
      }
      groups = big;
    }
    const assign = new Array<number>(n).fill(0);
    const palette: RGB[] = [];
    const sizes: number[] = [];
    groups.forEach(({ m, w }, gi) => {
      const sum = [0, 0, 0];
      for (const i of m) {
        assign[i] = gi;
        for (let k = 0; k < 3; k++) sum[k] += this.colors[i][k] * this.weights[i];
      }
      palette.push(sum.map((s) => Math.round(s / w)) as RGB);
      sizes.push(w);
    });
    return { assign, palette, sizes };
  }
}

/**
 * Same interface as before, but first folds near-identical colours together (within a few units
 * of Lab) so charts with hundreds of slightly different shades stay fast.
 */
export class ColorTree {
  private readonly inner: Agglomerative;
  private readonly leaderOf: number[];

  constructor(colors: RGB[], weights: number[]) {
    const order = colors.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
    const leaders: { lab: Lab; rgbSum: number[]; w: number }[] = [];
    this.leaderOf = new Array(colors.length).fill(0);
    for (const i of order) {
      const lab = rgbToLab(colors[i]);
      let found = -1;
      for (let k = 0; k < leaders.length; k++) {
        if (labDist(lab, leaders[k].lab) < 4) {
          found = k;
          break;
        }
      }
      if (found < 0) {
        found = leaders.length;
        leaders.push({ lab, rgbSum: [0, 0, 0], w: 0 });
      }
      const l = leaders[found];
      for (let c = 0; c < 3; c++) l.rgbSum[c] += colors[i][c] * weights[i];
      l.w += weights[i];
      this.leaderOf[i] = found;
    }
    this.inner = new Agglomerative(
      leaders.map((l) => l.rgbSum.map((v) => Math.round(v / l.w)) as RGB),
      leaders.map((l) => l.w),
    );
  }

  countForDistance(minDist: number): number {
    return this.inner.countForDistance(minDist);
  }

  cut(count: number, minSize = 0): { assign: number[]; palette: RGB[]; sizes: number[] } {
    const r = this.inner.cut(count, minSize);
    return { ...r, assign: this.leaderOf.map((k) => r.assign[k]) };
  }
}

/** Collapses per-cell colours into distinct (slightly coarsened) colours with counts. */
export function distinctColors(cells: RGB[]): { colors: RGB[]; weights: number[]; index: number[] } {
  const map = new Map<number, { sum: number[]; n: number; id: number }>();
  const index: number[] = [];
  const order: { sum: number[]; n: number; id: number }[] = [];
  for (const [r, g, b] of cells) {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let e = map.get(key);
    if (!e) {
      e = { sum: [0, 0, 0], n: 0, id: order.length };
      map.set(key, e);
      order.push(e);
    }
    e.sum[0] += r;
    e.sum[1] += g;
    e.sum[2] += b;
    e.n++;
    index.push(e.id);
  }
  return {
    colors: order.map((e) => e.sum.map((s) => Math.round(s / e.n)) as RGB),
    weights: order.map((e) => e.n),
    index,
  };
}
