/**
 * Print frame-line candidates for the piece containing row y, with the verification numbers.
 * Usage: npx tsx scripts/debug-frames.ts <file.cbz> <chapterId> <y>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStrip } from '../src/core/cbz.ts';
import { findFrameLines } from '../src/core/frames.ts';
import { runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

const [file, id, ys] = process.argv.slice(2);
const y = Number(ys);
const m = JSON.parse(await readFile(path.join(runDir(id), 'manifest.json'), 'utf8')) as Manifest;
const strip = await loadStrip(file);
let y0 = 0;
let y1 = strip.height;
for (const g of m.gutters) {
  if (g.y1 <= y) y0 = Math.max(y0, g.y1);
  if (g.y0 > y) y1 = Math.min(y1, g.y0);
}
const zones = m.textBlocks.map((b) => b.zone).filter((z) => z.y1 > y0 && z.y0 < y1);
console.log(`piece ${y0}..${y1}, ${zones.length} dialogue zones`);
process.env.WSC_DEBUG_FRAMES = '1';
console.log(findFrameLines(strip.gray, strip.width, { y0, y1 }, zones));
