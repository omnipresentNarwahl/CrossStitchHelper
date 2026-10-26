import { labDist, rgbToLab, type Lab } from './color';
import type { RGB } from './raster';

/** How much a symbol difference counts against a colour difference when telling two threads apart. */
const SIG_WEIGHT = 10;
/** Symbols are noisy at this size, so they can only tip the balance between colours that are already close. */
const SIG_CAP = 1.5;

/** The symbol features: [dark mass, light mass, dark xx, yy, xy, light xx, yy, xy]. */
export const FEATURES = 8;

/**
 * Boils a symbol picture (SIG_N x SIG_N, dark negative / light positive) down to numbers that
 * don't care exactly where in the cell the mark sits (printing and scaling shift it a little):
 * how much dark and light ink there is, and its shape (round, flat, or leaning each way).
 */
export function symbolFeatures(sig: Float32Array): Float32Array {
  const n = Math.round(Math.sqrt(sig.length));
  const out = new Float32Array(FEATURES);
  for (const [k, sign] of [[0, -1], [1, 1]] as const) {
    let mass = 0, cx = 0, cy = 0;
    for (let i = 0; i < sig.length; i++) {
      const w = Math.max(0, sign * sig[i]);
      mass += w;
      cx += w * (i % n);
      cy += w * ((i / n) | 0);
    }
    out[k] = (mass / sig.length) * 10;
    if (mass < 0.25) continue;
    cx /= mass;
    cy /= mass;
    let xx = 0, yy = 0, xy = 0;
    for (let i = 0; i < sig.length; i++) {
      const w = Math.max(0, sign * sig[i]);
      const dx = (i % n) - cx, dy = ((i / n) | 0) - cy;
      xx += w * dx * dx;
      yy += w * dy * dy;
      xy += w * dx * dy;
    }
    const base = k === 0 ? 2 : 5;
    out[base] = xx / mass;
    out[base + 1] = yy / mass;
    out[base + 2] = xy / mass;
  }
  return out;
}

/** A cell, or a legend swatch, as the matcher sees it: fill colour plus symbol features. */
export interface Look {
  rgb: RGB;
  lab: Lab;
  sig: Float32Array;
}

/** `sigPicture` is a cell's symbol picture (see `CellSample.sig`). */
export function look(rgb: RGB, sigPicture: Float32Array): Look {
  return { rgb, lab: rgbToLab(rgb), sig: symbolFeatures(sigPicture) };
}

/** Distance between two symbol feature sets. */
export function sigDist(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Distance between two looks, in roughly "colour difference" units. */
export function lookDist(a: Look, b: Look): number {
  return labDist(a.lab, b.lab) + SIG_WEIGHT * Math.min(SIG_CAP, sigDist(a.sig, b.sig));
}

/** A group of similar looks, with the weighted average of its members. */
interface Group {
  rgb: [number, number, number];
  lab: Lab;
  sig: Float32Array;
  w: number;
  members: number[];
}

function mergeGroups(a: Group, b: Group): Group {
  const w = a.w + b.w;
  const mix = (x: number, y: number) => (x * a.w + y * b.w) / w;
  return {
    w,
    members: [...a.members, ...b.members],
    rgb: [mix(a.rgb[0], b.rgb[0]), mix(a.rgb[1], b.rgb[1]), mix(a.rgb[2], b.rgb[2])],
    lab: [mix(a.lab[0], b.lab[0]), mix(a.lab[1], b.lab[1]), mix(a.lab[2], b.lab[2])],
    sig: Float32Array.from(a.sig, (v, i) => mix(v, b.sig[i])),
  };
}

const MAX_LEADERS = 260;
const groupDist = (a: Group, b: Group) => labDist(a.lab, b.lab) + SIG_WEIGHT * Math.min(SIG_CAP, sigDist(a.sig, b.sig));

/**
 * Agglomerative clustering of stitch appearances (colour *and* symbol). Near-identical cells are
 * folded together first so thousands of cells cost no more than a few hundred groups; then the
 * closest pair is merged repeatedly and the order remembered, so any number of colours can be
 * cut out instantly.
 */
export class LookTree {
  private readonly leaderOf: number[];
  private readonly leaders: Group[];
  private readonly merges: { a: number; b: number; dist: number }[] = [];

  constructor(looks: Look[]) {
    this.leaders = [];
    this.leaderOf = new Array(looks.length);
    // Fold near-identical cells into leaders; if there are still too many, be less picky.
    for (let threshold = 5; ; threshold *= 1.5) {
      this.leaders.length = 0;
      let tooMany = false;
      for (let i = 0; i < looks.length && !tooMany; i++) {
        const l = looks[i];
        let found = -1, bestD = threshold;
        for (let k = 0; k < this.leaders.length; k++) {
          const g = this.leaders[k];
          const d = labDist(l.lab, g.lab) + SIG_WEIGHT * Math.min(SIG_CAP, sigDist(l.sig, g.sig));
          if (d < bestD) {
            bestD = d;
            found = k;
          }
        }
        const single: Group = { rgb: [...l.rgb], lab: l.lab, sig: l.sig, w: 1, members: [] };
        if (found < 0) {
          found = this.leaders.length;
          this.leaders.push(single);
          if (this.leaders.length > MAX_LEADERS) tooMany = true;
        } else this.leaders[found] = mergeGroups(this.leaders[found], single);
        this.leaderOf[i] = found;
      }
      if (!tooMany) break;
    }

    const live = new Map<number, Group>();
    this.leaders.forEach((g, i) => live.set(i, { ...g, members: [i] }));
    let next = this.leaders.length;
    while (live.size > 1) {
      let ba = -1, bb = -1, bd = Infinity;
      const ids = [...live.keys()];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const d = groupDist(live.get(ids[i])!, live.get(ids[j])!);
          if (d < bd) {
            bd = d;
            ba = ids[i];
            bb = ids[j];
          }
        }
      }
      live.set(next++, mergeGroups(live.get(ba)!, live.get(bb)!));
      live.delete(ba);
      live.delete(bb);
      this.merges.push({ a: ba, b: bb, dist: bd });
    }
  }

  get size(): number {
    return this.leaders.length;
  }

  /** Number of colours left once every pair closer than `minDist` has been merged. */
  countForDistance(minDist: number): number {
    let n = this.leaders.length;
    for (const m of this.merges) {
      if (m.dist >= minDist) break;
      n--;
    }
    return Math.max(1, n);
  }

  /**
   * Groups the cells into `count` colours. Colours of fewer than `minSize` cells are blurred
   * edges, not real threads, and join their nearest neighbour.
   */
  cut(count: number, minSize = 0): { assign: number[]; palette: { rgb: RGB; sig: Float32Array }[]; sizes: number[] } {
    const n = this.leaders.length;
    count = Math.max(1, Math.min(n, count));
    const groups = new Map<number, Group>();
    this.leaders.forEach((g, i) => groups.set(i, { ...g, members: [i] }));
    let next = n;
    for (let s = 0; s < n - count; s++) {
      const { a, b } = this.merges[s];
      groups.set(next++, mergeGroups(groups.get(a)!, groups.get(b)!));
      groups.delete(a);
      groups.delete(b);
    }
    let list = [...groups.values()].sort((x, y) => y.w - x.w);
    const big = list.filter((g) => g.w >= minSize);
    if (minSize > 0 && big.length > 0 && big.length < list.length) {
      for (const g of list) {
        if (g.w >= minSize) continue;
        let best = 0;
        for (let k = 1; k < big.length; k++) if (groupDist(g, big[k]) < groupDist(g, big[best])) best = k;
        big[best].members.push(...g.members);
        big[best].w += g.w;
      }
      list = big;
    }
    const leaderGroup = new Array<number>(n).fill(0);
    list.forEach((g, gi) => g.members.forEach((m) => (leaderGroup[m] = gi)));
    return {
      assign: this.leaderOf.map((k) => leaderGroup[k]),
      palette: list.map((g) => ({ rgb: g.rgb.map(Math.round) as RGB, sig: g.sig })),
      sizes: list.map((g) => g.w),
    };
  }
}
