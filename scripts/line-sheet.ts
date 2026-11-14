/**
 * Crops of OCR lines at given rows, labelled with their readings.
 * Usage: npx tsx scripts/line-sheet.ts <chapterId> <readings.json> <out.jpg> <y>...
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

const [id, readingsFile, out, ...ys] = process.argv.slice(2);
const dir = runDir(id);
const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
const readings = JSON.parse(await readFile(readingsFile, 'utf8')) as { box: number[]; en: string; enConf: number; ko: string; koConf: number }[];
const tw = 420;
const th = 130;
const tiles: sharp.OverlayOptions[] = [];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
for (const [n, y] of ys.map(Number).entries()) {
  const r = readings.find((q) => q.box[1] === y);
  if (!r) continue;
  const [x0, y0, x1, y1] = r.box;
  const top = Math.max(0, y0 - 20);
  const bottom = Math.min(m.strip.height, y1 + 20);
  const chunk = m.strip.chunks.find((c) => top >= c.y0 && top < c.y1)!;
  const crop = await sharp(path.join(dir, 'strip', chunk.file))
    .extract({ left: Math.max(0, x0 - 40), top: top - chunk.y0, width: Math.min(m.strip.width, x1 + 40) - Math.max(0, x0 - 40), height: Math.min(bottom, chunk.y1) - top })
    .resize(tw, th - 24, { fit: 'contain', background: '#000' })
    .toBuffer();
  const label = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="24"><rect width="100%" height="100%" fill="#222"/><text x="5" y="16" font-size="13" font-family="Arial" fill="#fff">y${y} en ${r.enConf.toFixed(2)} "${esc(r.en.slice(0, 30))}" ko ${r.koConf.toFixed(2)}</text></svg>`,
  );
  const col = n % 3;
  const row = Math.floor(n / 3);
  tiles.push({ input: label, left: col * tw, top: row * th }, { input: crop, left: col * tw, top: row * th + 24 });
}
await sharp({ create: { width: 3 * tw, height: Math.ceil(ys.length / 3) * th, channels: 3, background: '#000' } })
  .composite(tiles)
  .jpeg({ quality: 85 })
  .toFile(out);
console.log(`wrote ${out}`);
