/**
 * Check the detail map against the hand-judged clips, at clip level and cell level.
 * Usage: npx tsx scripts/cell-thresholds.ts <file.cbz> <chapterId>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStrip } from '../src/core/cbz.ts';
import { analyzeDetail } from '../src/core/interest.ts';
import { runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

const [file, id] = process.argv.slice(2);
const m = JSON.parse(await readFile(path.join(runDir(id), 'manifest.json'), 'utf8')) as Manifest & { video: { id: string; x0: number; y0: number; x1: number; y1: number }[] };
const strip = await loadStrip(file);
const t0 = performance.now();
const d = analyzeDetail(strip.gray, strip.width, strip.height);
console.log(`detail map ${d.cols}x${d.rows} in ${Math.round(performance.now() - t0)} ms`);
const judged: Record<string, string> = {
  v029: 'good', v038: 'good', v044: 'good', v047: 'good', v051: 'good', v068: 'good',
  v004: 'filler', v011: 'filler', v032: 'filler', v050: 'filler', v054: 'filler', v060: 'filler', v069: 'filler',
};
for (const [clip, verdict] of Object.entries(judged)) {
  const v = m.video.find((c) => c.id === clip)!;
  const cx0 = Math.floor(v.x0 / d.size);
  const cx1 = Math.ceil(v.x1 / d.size);
  const cy0 = Math.floor(v.y0 / d.size);
  const cy1 = Math.ceil(v.y1 / d.size);
  let iso = 0;
  let ink = 0;
  let n = 0;
  let busy = 0;
  const blocks: number[] = [];
  for (let cy = cy0; cy < cy1; cy++) {
    for (let cx = cx0; cx < cx1; cx++) {
      const c = cy * d.cols + cx;
      iso += d.iso[c];
      ink += d.ink[c];
      n++;
      if (d.iso[c] >= 0.02 || d.ink[c] >= 0.02) busy++;
    }
  }
  for (let cy = cy0; cy + 1 < cy1; cy += 2) {
    for (let cx = cx0; cx + 1 < cx1; cx += 2) {
      const c = cy * d.cols + cx;
      blocks.push((d.mean[c] + d.mean[c + 1] + d.mean[c + d.cols] + d.mean[c + d.cols + 1]) / 4);
    }
  }
  const mu = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  const std = Math.sqrt(blocks.reduce((a, b) => a + (b - mu) ** 2, 0) / blocks.length);
  console.log(verdict.padEnd(6), clip, `iso ${(iso / n).toFixed(3)} ink ${(ink / n).toFixed(3)} std ${std.toFixed(1)} busyCells ${(busy / n).toFixed(2)}`);
}
