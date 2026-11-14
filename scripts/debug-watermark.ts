/**
 * Print OCR lines touching a strip side and their best thumbnail correlation with other pages.
 * Usage: npx tsx scripts/debug-watermark.ts <file.cbz> <chapterId>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStrip } from '../src/core/cbz.ts';
import { runDir } from '../src/core/library.ts';
import { thumbnail } from '../src/core/text.ts';
import type { Manifest } from '../src/core/types.ts';

const [file, id] = process.argv.slice(2);
const m = JSON.parse(await readFile(path.join(runDir(id), 'manifest.json'), 'utf8')) as Manifest;
const strip = await loadStrip(file);
const W = strip.width;
const lines = m.textLines.filter((l) => (l.x0 <= 0.05 * W || l.x1 >= 0.95 * W) && l.x1 - l.x0 >= 2 * (l.y1 - l.y0));
const page = (y: number) => m.pages.find((p) => y >= p.y0 && y < p.y1)?.index ?? -1;
for (const variant of ['gray', 'edges'] as const) {
  const th = lines.map((l) => thumbnail(strip.gray, W, l, variant === 'edges'));
  console.log(`--- ${variant}`);
  for (const [i, l] of lines.entries()) {
    let best = -1;
    let bestJ = -1;
    for (let j = 0; j < lines.length; j++) {
      if (j === i || page(lines[j].y0) === page(l.y0)) continue;
      let dot = 0;
      for (let k = 0; k < th[i].length; k++) dot += th[i][k] * th[j][k];
      if (dot > best) {
        best = dot;
        bestJ = j;
      }
    }
    const o = lines[bestJ];
    console.log(`${l.kind.padEnd(9)} ${l.x0},${l.y0},${l.x1},${l.y1} (${l.x1 - l.x0}x${l.y1 - l.y0}) best ${best.toFixed(2)} with ${o ? `${o.x0},${o.y0} (${o.x1 - o.x0}x${o.y1 - o.y0})` : '-'}`);
  }
}
