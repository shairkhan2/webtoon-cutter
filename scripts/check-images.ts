/**
 * Checks that every reader and video image of processed chapters exists, decodes, and has the
 * size the manifest says. A run that was killed can leave zero-filled files behind.
 * Usage: npx tsx scripts/check-images.ts [chapterId|all]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { listChapters, runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

const [which = 'all'] = process.argv.slice(2);
let checked = 0;
const bad: string[] = [];
for (const ch of listChapters().filter((c) => which === 'all' || c.id === which)) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    continue;
  }
  const files = [
    ...m.panels.map((p) => ({ file: path.join('reader', `${p.id}.jpg`), w: m.strip.width, h: p.y1 - p.y0 })),
    ...m.shots.map((s) => ({ file: path.join('video', s.file), w: s.x1 - s.x0, h: s.y1 - s.y0 })),
  ];
  let chapterBad = 0;
  for (const f of files) {
    checked++;
    try {
      const meta = await sharp(path.join(runDir(ch.id), f.file)).metadata();
      if (meta.width !== f.w || meta.height !== f.h) throw new Error(`size ${meta.width}x${meta.height}, expected ${f.w}x${f.h}`);
    } catch (err) {
      chapterBad++;
      bad.push(`${ch.id} ${f.file}: ${(err as Error).message}`);
    }
  }
  if (chapterBad) console.log(`${ch.id}: ${chapterBad} bad images (re-cut it)`);
}
for (const b of bad.slice(0, 20)) console.log(`  ${b}`);
console.log(`${checked} images checked, ${bad.length} bad`);
if (bad.length) process.exitCode = 1;
