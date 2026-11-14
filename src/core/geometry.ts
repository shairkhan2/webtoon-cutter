import type { Interval, Rect } from './types.ts';

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const area = (r: Rect): number => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

export function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

export function union(a: Rect, b: Rect): Rect {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function iou(a: Rect, b: Rect): number {
  const i = intersect(a, b);
  if (!i) return 0;
  const ia = area(i);
  return ia / (area(a) + area(b) - ia);
}

/** Intersection over the smaller of the two areas. */
export function containment(a: Rect, b: Rect): number {
  const i = intersect(a, b);
  if (!i) return 0;
  return area(i) / Math.max(1, Math.min(area(a), area(b)));
}

export function pad(r: Rect, p: number, width: number, height: number): Rect {
  return {
    x0: Math.max(0, Math.floor(r.x0 - p)),
    y0: Math.max(0, Math.floor(r.y0 - p)),
    x1: Math.min(width, Math.ceil(r.x1 + p)),
    y1: Math.min(height, Math.ceil(r.y1 + p)),
  };
}

/** True when the horizontal line at y passes strictly through the rect's interior. */
export const crossesY = (r: { y0: number; y1: number }, y: number, tol = 0): boolean =>
  r.y0 + tol < y && y < r.y1 - tol;

export const overlapY = (a: { y0: number; y1: number }, b: { y0: number; y1: number }): number =>
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Runs of true values in a boolean-like array, as half-open intervals. */
export function runs(mask: ArrayLike<number | boolean>, from = 0, to = mask.length): Interval[] {
  const out: Interval[] = [];
  let start = -1;
  for (let i = from; i < to; i++) {
    if (mask[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push({ y0: start, y1: i });
      start = -1;
    }
  }
  if (start >= 0) out.push({ y0: start, y1: to });
  return out;
}

/** Merge overlapping or touching intervals (gap <= joinGap). */
export function mergeIntervals(list: Interval[], joinGap = 0): Interval[] {
  const sorted = [...list].sort((a, b) => a.y0 - b.y0);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.y0 <= last.y1 + joinGap) last.y1 = Math.max(last.y1, iv.y1);
    else out.push({ ...iv });
  }
  return out;
}

/** Subtract `cut` intervals from `base` intervals. */
export function subtractIntervals(base: Interval[], cut: Interval[]): Interval[] {
  const cuts = mergeIntervals(cut);
  const out: Interval[] = [];
  for (const b of base) {
    let pieces: Interval[] = [{ ...b }];
    for (const c of cuts) {
      if (c.y1 <= b.y0 || c.y0 >= b.y1) continue;
      const next: Interval[] = [];
      for (const p of pieces) {
        if (c.y1 <= p.y0 || c.y0 >= p.y1) next.push(p);
        else {
          if (c.y0 > p.y0) next.push({ y0: p.y0, y1: c.y0 });
          if (c.y1 < p.y1) next.push({ y0: c.y1, y1: p.y1 });
        }
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out;
}

export const median = (values: number[]): number => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
