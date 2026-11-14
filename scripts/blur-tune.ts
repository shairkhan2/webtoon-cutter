/**
 * Blur strength comparison on real watermarks: each row is one watermark in its surroundings,
 * columns are the original and the blur at several strengths (sigma × lettering height).
 * Usage: npx tsx scripts/blur-tune.ts <out.png>
 */
import sharp from 'sharp';
import { loadStrip } from '../src/core/cbz.ts';
import { listChapters } from '../src/core/library.ts';
import type { Rect } from '../src/core/types.ts';
import { blurMarks } from '../src/core/watermarks.ts';

const [out] = process.argv.slice(2);
// Chapter name prefix, then the watermark lettering boxes (strip pixels), from the manifests.
const cases: [string, Rect[]][] = [
  ['Thunderscans', [{ x0: 72, y0: 19086, x1: 255, y1: 19106 }, { x0: 68, y0: 19100, x1: 256, y1: 19124 }]],
  ['Elf Toon_Chapter 5', [{ x0: 62, y0: 58967, x1: 282, y1: 59037 }, { x0: 188, y0: 59021, x1: 266, y1: 59053 }]],
  ['Asura Scans_Chapter 5', [{ x0: 2, y0: 59412, x1: 274, y1: 59468 }]],
  ['HiveToons', [{ x0: 28, y0: 67041, x1: 432, y1: 67097 }, { x0: 64, y0: 67097, x1: 398, y1: 67153 }]],
  ['Timeless toons', [{ x0: 76, y0: 59823, x1: 284, y1: 59867 }]],
  ['Reset Scans', [{ x0: 10, y0: 107875, x1: 190, y1: 107913 }]],
  ['Drake Scans', [{ x0: 86, y0: 24873, x1: 340, y1: 24929 }]],
];
const sigmas = [0.25, 0.35, 0.5];
const rowsOut: Buffer[] = [];
let sheetW = 0;
for (const [name, rects] of cases) {
  const ch = listChapters().find((c) => c.name.startsWith(name))!;
  const s = await loadStrip(ch.file);
  const W = s.width;
  const u = rects.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
  const h = u.y1 - u.y0;
  const win = { x0: Math.max(0, u.x0 - h), y0: Math.max(0, u.y0 - h), x1: Math.min(W, u.x1 + h), y1: Math.min(s.height, u.y1 + h) };
  const ww = win.x1 - win.x0;
  const wh = win.y1 - win.y0;
  const crop = () => {
    const b = Buffer.allocUnsafe(ww * wh * 3);
    for (let y = 0; y < wh; y++) s.rgb.subarray(((win.y0 + y) * W + win.x0) * 3, ((win.y0 + y) * W + win.x1) * 3).forEach((v, k) => (b[y * ww * 3 + k] = v));
    return b;
  };
  const local = rects.map((r) => ({ x0: r.x0 - win.x0, y0: r.y0 - win.y0, x1: r.x1 - win.x0, y1: r.y1 - win.y0 }));
  const cells: Buffer[] = [await sharp(crop(), { raw: { width: ww, height: wh, channels: 3 } }).png().toBuffer()];
  for (const sg of sigmas) {
    const b = crop();
    await blurMarks(b, ww, wh, local, { sigma: sg, minSigma: 3, pad: 0.1, feather: 0.25 });
    cells.push(await sharp(b, { raw: { width: ww, height: wh, channels: 3 } }).png().toBuffer());
  }
  // Small lettering is shown at 2x so the comparison is fair.
  const zoom = h < 40 ? 2 : 1;
  const scaled = await Promise.all(cells.map((c) => sharp(c).resize(ww * zoom, wh * zoom, { kernel: 'nearest' }).png().toBuffer()));
  const rowW = scaled.length * (ww * zoom + 8);
  const row = await sharp({ create: { width: rowW, height: wh * zoom + 8, channels: 3, background: '#000' } })
    .composite(scaled.map((c, i) => ({ input: c, left: i * (ww * zoom + 8), top: 4 })))
    .png()
    .toBuffer();
  rowsOut.push(row);
  sheetW = Math.max(sheetW, rowW);
}
const metas = await Promise.all(rowsOut.map((r) => sharp(r).metadata()));
const H = metas.reduce((t, m) => t + m.height!, 0);
let y = 0;
const comp = rowsOut.map((r, i) => {
  const c = { input: r, left: 0, top: y };
  y += metas[i].height!;
  return c;
});
await sharp({ create: { width: sheetW, height: H, channels: 3, background: '#000' } }).composite(comp).png().toFile(out);
console.log(`columns: original, ${sigmas.map((s) => `sigma ${s}×h`).join(', ')} -> ${out}`);
