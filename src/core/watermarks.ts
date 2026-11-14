/**
 * Watermarks in video shots: which lettering counts as part of a site banner, and a tight blur
 * that makes it unreadable while leaving the art around it alone. Reader panels are not touched.
 */
import sharp from 'sharp';
import { config } from './config.ts';
import type { Rect } from './types.ts';

const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const overlap = (a: Rect, b: Rect) =>
  area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

/**
 * Is lettering `a` part of the same banner or logo as the site line `mark`? Either the two boxes
 * overlap (a logo and its ".com"), or `a` is a stacked banner line: right above or below, about as
 * tall, mostly over the same columns, and centred or left-aligned with it ("YOU CAN READ THE
 * CHAPTER ON:" over "EN-THUNDERSCANS.COM", "TO FASTER UPDATE!" under "READ AT HIVETOON.COM").
 */
export function bannerGlue(a: Rect, mark: Rect): boolean {
  if (overlap(a, mark) >= 0.3 * Math.min(area(a), area(mark))) return true;
  const ha = a.y1 - a.y0;
  const hm = mark.y1 - mark.y0;
  const gap = Math.max(mark.y0 - a.y1, a.y0 - mark.y1);
  if (gap > 0.6 * Math.max(ha, hm) || Math.max(ha, hm) > 1.6 * Math.min(ha, hm)) return false;
  const wa = a.x1 - a.x0;
  const wm = mark.x1 - mark.x0;
  const cols = Math.min(a.x1, mark.x1) - Math.max(a.x0, mark.x0);
  if (cols < 0.6 * Math.min(wa, wm)) return false;
  const wide = Math.max(wa, wm);
  const centred = Math.abs((a.x0 + a.x1) / 2 - (mark.x0 + mark.x1) / 2) <= 0.15 * wide;
  const leftAligned = Math.abs(a.x0 - mark.x0) <= 0.1 * wide;
  return centred || leftAligned;
}

export interface BlurParams {
  sigma: number;
  minSigma: number;
  pad: number;
  feather: number;
}

/**
 * Blurs each rect of a packed RGB image in place, tightly: the rect padded by `pad` × its height,
 * with a soft edge `feather` × its height wide, at a strength of `sigma` × its height (enough
 * that the letters cannot be read). Pixels further out are unchanged.
 */
export async function blurMarks(rgb: Buffer, width: number, height: number, rects: Rect[], p: BlurParams = config.blur): Promise<void> {
  for (const r of rects) {
    const lh = r.y1 - r.y0;
    if (lh <= 0 || r.x1 <= r.x0) continue;
    const sigma = Math.max(p.minSigma, p.sigma * lh);
    const pad = Math.round(p.pad * lh);
    const fe = Math.max(2, Math.round(p.feather * lh));
    const inner = { x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad };
    const clip = (q: Rect) => ({ x0: Math.max(0, q.x0), y0: Math.max(0, q.y0), x1: Math.min(width, q.x1), y1: Math.min(height, q.y1) });
    const outer = clip({ x0: inner.x0 - fe, y0: inner.y0 - fe, x1: inner.x1 + fe, y1: inner.y1 + fe });
    if (outer.x1 <= outer.x0 || outer.y1 <= outer.y0) continue;
    const m = Math.ceil(3 * sigma);
    const ctx = clip({ x0: outer.x0 - m, y0: outer.y0 - m, x1: outer.x1 + m, y1: outer.y1 + m });
    const cw = ctx.x1 - ctx.x0;
    const ch = ctx.y1 - ctx.y0;
    const patch = Buffer.allocUnsafe(cw * ch * 3);
    for (let y = 0; y < ch; y++) {
      const src = ((ctx.y0 + y) * width + ctx.x0) * 3;
      rgb.copy(patch, y * cw * 3, src, src + cw * 3);
    }
    const blurred = await sharp(patch, { raw: { width: cw, height: ch, channels: 3 } }).blur(sigma).raw().toBuffer();
    for (let y = outer.y0; y < outer.y1; y++) {
      const dy = Math.max(inner.y0 - y, 0, y - (inner.y1 - 1));
      for (let x = outer.x0; x < outer.x1; x++) {
        const dx = Math.max(inner.x0 - x, 0, x - (inner.x1 - 1));
        const d = Math.hypot(dx, dy);
        if (d >= fe) continue;
        const t = d / fe;
        const a = d <= 0 ? 1 : 1 - t * t * (3 - 2 * t); // smoothstep: soft, narrow edge
        const i = (y * width + x) * 3;
        const j = ((y - ctx.y0) * cw + (x - ctx.x0)) * 3;
        for (let k = 0; k < 3; k++) rgb[i + k] = Math.round(a * blurred[j + k] + (1 - a) * rgb[i + k]);
      }
    }
  }
}
