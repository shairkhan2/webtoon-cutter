/**
 * Watermark blur check: for each shot with watermarks, the area around each mark in the strip
 * (original) next to the same area in the written video image (blurred).
 * Usage: npx tsx scripts/blur-sheet.ts <chapterId|name-substring|all> <out.jpg> [max=30] [perChapter]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { listChapters, runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

const [which = 'all', out, max = '30', perChapter = '99'] = process.argv.slice(2);
const tiles: Buffer[] = [];
const labels: string[] = [];
for (const ch of listChapters().filter((c) => which === 'all' || c.id === which || c.name.includes(which))) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    continue;
  }
  const W = m.strip.width;
  for (const s of m.shots.filter((x) => x.watermarks.length).slice(0, Number(perChapter))) {
    if (tiles.length >= Number(max)) break;
    const u = s.watermarks.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
    const h = u.y1 - u.y0;
    const win = { x0: Math.max(s.x0, u.x0 - 2 * h), y0: Math.max(s.y0, u.y0 - 2 * h), x1: Math.min(s.x1, u.x1 + 2 * h), y1: Math.min(s.y1, u.y1 + 2 * h) };
    const ww = win.x1 - win.x0;
    const wh = win.y1 - win.y0;
    // Original from the strip chunks, blurred from the video image.
    const parts: sharp.OverlayOptions[] = [];
    for (const c of m.strip.chunks) {
      const t0 = Math.max(win.y0, c.y0);
      const t1 = Math.min(win.y1, c.y1);
      if (t0 >= t1) continue;
      const piece = await sharp(path.join(runDir(ch.id), 'strip', c.file)).extract({ left: win.x0, top: t0 - c.y0, width: ww, height: t1 - t0 }).toBuffer();
      parts.push({ input: piece, left: 0, top: t0 - win.y0 });
    }
    // Composite in one step from a png canvas (sharp cannot composite onto a lazy `create` input
    // whose parts are larger than an earlier pipeline stage expects).
    const canvas = await sharp({ create: { width: ww, height: wh, channels: 3, background: '#000' } }).png().toBuffer();
    const orig = await sharp(canvas).composite(parts).png().toBuffer();
    const blur = await sharp(path.join(runDir(ch.id), 'video', s.file)).extract({ left: win.x0 - s.x0, top: win.y0 - s.y0, width: ww, height: wh }).png().toBuffer();
    const zoom = h < 30 ? 2 : 1;
    const pair = await sharp({ create: { width: 2 * ww * zoom + 6, height: wh * zoom, channels: 3, background: '#000' } })
      .composite([
        { input: await sharp(orig).resize(ww * zoom, wh * zoom).toBuffer(), left: 0, top: 0 },
        { input: await sharp(blur).resize(ww * zoom, wh * zoom).toBuffer(), left: ww * zoom + 6, top: 0 },
      ])
      .png()
      .toBuffer();
    tiles.push(pair);
    labels.push(`${ch.name.replace(/_Chapter (\d+)_.*$/, ' ch$1')} ${s.id} (${W}px wide strip): ${s.watermarks.length} mark line(s)`);
  }
}
const cell = { w: 640, h: 220 };
const cols = 2;
const comp: sharp.OverlayOptions[] = [];
for (const [i, t] of tiles.entries()) {
  const img = await sharp(t).resize(cell.w, cell.h - 22, { fit: 'contain', background: '#111' }).toBuffer();
  const lab = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cell.w}" height="22"><rect width="100%" height="100%" fill="#222"/><text x="4" y="15" font-size="12" font-family="Arial" fill="#fff">${(i + 1) + '. ' + labels[i].replace(/[&<>]/g, '')} | left original, right video</text></svg>`);
  const x = (i % cols) * cell.w;
  const y = Math.floor(i / cols) * cell.h;
  comp.push({ input: lab, left: x, top: y }, { input: img, left: x, top: y + 22 });
}
await sharp({ create: { width: cols * cell.w, height: Math.max(1, Math.ceil(tiles.length / cols)) * cell.h, channels: 3, background: '#000' } })
  .composite(comp)
  .jpeg({ quality: 86 })
  .toFile(out);
console.log(`${tiles.length} shots -> ${out}`);
