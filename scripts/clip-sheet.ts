/**
 * Contact sheet of video clips.
 * Usage: npx tsx scripts/clip-sheet.ts <chapterId> <out.jpg> <clipId>...
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { runDir } from '../src/core/library.ts';

const [id, out, ...clips] = process.argv.slice(2);
const dir = path.join(runDir(id), 'video');
const files = await readdir(dir);
const tw = 260;
const th = 300;
const cols = 5;
const tiles: sharp.OverlayOptions[] = [];
for (const [i, c] of clips.entries()) {
  const f = files.find((x) => x.startsWith(`${c}_`));
  if (!f) continue;
  const img = await sharp(path.join(dir, f)).resize(tw, th - 24, { fit: 'contain', background: '#111' }).toBuffer();
  const label = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="24"><rect width="100%" height="100%" fill="#222"/><text x="6" y="17" font-size="15" font-family="Arial" fill="#fff">${f.replace('.jpg', '')}</text></svg>`,
  );
  const x = (i % cols) * tw;
  const y = Math.floor(i / cols) * th;
  tiles.push({ input: label, left: x, top: y }, { input: img, left: x, top: y + 24 });
}
await sharp({ create: { width: cols * tw, height: Math.ceil(clips.length / cols) * th, channels: 3, background: '#000' } })
  .composite(tiles)
  .jpeg({ quality: 82 })
  .toFile(out);
console.log(`wrote ${out}`);
