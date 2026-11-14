/**
 * Contact sheet of every OCR line that ends up inside a video clip, to judge dialogue vs SFX by eye.
 * Usage: npx tsx scripts/lettering-sheet.ts <chapterId> <out.jpg>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { intersect } from '../src/core/geometry.ts';
import { runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

// Optional 3rd arg: a line kind (text | sfx | watermark) to show every line of that kind instead.
const [id, out, onlyKind] = process.argv.slice(2);
const dir = runDir(id);
const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
const W = m.strip.width;
const tileW = 450;
const tileH = 150;
const tiles: sharp.OverlayOptions[] = [];
let n = 0;
const everywhere = { id: 'all', x0: 0, y0: 0, x1: W, y1: m.strip.height };
for (const v of onlyKind ? [everywhere] : m.video) {
  for (const l of m.textLines) {
    if (onlyKind ? l.kind !== onlyKind : l.kind === 'watermark') continue;
    if (n >= 60) break;
    const i = intersect(l, v);
    if (!i || (i.x1 - i.x0) * (i.y1 - i.y0) < 0.5 * (l.x1 - l.x0) * (l.y1 - l.y0)) continue;
    const y0 = Math.max(0, l.y0 - 30);
    const y1 = Math.min(m.strip.height, l.y1 + 30);
    const chunk = m.strip.chunks.find((c) => y0 >= c.y0 && y0 < c.y1)!;
    const yy1 = Math.min(y1, chunk.y1);
    const crop = await sharp(path.join(dir, 'strip', chunk.file))
      .extract({ left: 0, top: y0 - chunk.y0, width: W, height: yy1 - y0 })
      .resize(tileW, tileH - 22, { fit: 'contain', background: '#000' })
      .toBuffer();
    const label = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="22"><rect width="100%" height="100%" fill="#222"/><text x="6" y="16" font-size="14" font-family="Arial" fill="#fff">${v.id} ${l.kind} bg=${l.bg} bgFrac=${l.bgFrac} ink=${l.inkFrac} y=${l.y0}</text></svg>`,
    );
    const col = n % 3;
    const row = Math.floor(n / 3);
    tiles.push({ input: label, left: col * tileW, top: row * tileH }, { input: crop, left: col * tileW, top: row * tileH + 22 });
    n++;
  }
}
const rows = Math.max(1, Math.ceil(n / 3));
await sharp({ create: { width: 3 * tileW, height: rows * tileH, channels: 3, background: '#000' } })
  .composite(tiles)
  .jpeg({ quality: 80 })
  .toFile(out);
console.log(`${n} lines -> ${out}`);
