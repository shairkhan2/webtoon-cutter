/**
 * B-roll shots in panels that join a neighbouring panel without a gutter (border or split cut)
 * when the neighbour's shot reaches that cut: candidates for "leftover of a scene already shown".
 * Prints how alike the art is on both sides of the cut (colour histograms of 48 px bands).
 * Usage: npx tsx scripts/leftovers.ts [chapterId|all]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStrip } from '../src/core/cbz.ts';
import { listChapters, runDir } from '../src/core/library.ts';
import type { Manifest, Panel, Shot } from '../src/core/types.ts';

const [which = 'all'] = process.argv.slice(2);

/** 4x4x4 RGB histogram of rows [y0, y1), normalised. */
function hist(rgb: Uint8Array, width: number, y0: number, y1: number): Float64Array {
  const h = new Float64Array(64);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 3;
      h[((rgb[i] >> 6) << 4) | ((rgb[i + 1] >> 6) << 2) | (rgb[i + 2] >> 6)]++;
      n++;
    }
  }
  for (let k = 0; k < 64; k++) h[k] /= Math.max(1, n);
  return h;
}
const overlap = (a: Float64Array, b: Float64Array) => a.reduce((s, v, k) => s + Math.min(v, b[k]), 0);

for (const ch of listChapters().filter((c) => which === 'all' || c.id === which)) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    continue;
  }
  const strip = await loadStrip(ch.file);
  const W = m.strip.width;
  const shotsOf = (p: Panel) => p.shotIds.map((id) => m.shots.find((s) => s.id === id) as Shot);
  const rows: string[] = [];
  for (const [i, p] of m.panels.entries()) {
    for (const s of shotsOf(p).filter((x) => x.tier === 'B')) {
      for (const side of ['above', 'below'] as const) {
        const cut = side === 'above' ? p.top : p.bottom;
        const q = m.panels[side === 'above' ? i - 1 : i + 1];
        if (!q || cut === 'gutter' || cut === 'start' || cut === 'end') continue;
        const y = side === 'above' ? p.contentY0 : p.contentY1;
        const reach = shotsOf(q).filter((x) => Math.abs((side === 'above' ? x.y1 : x.y0) - y) <= 0.05 * W);
        if (!reach.length) continue;
        const band = 48;
        const gap = 6;
        const a = side === 'above' ? hist(strip.rgb, W, y - gap - band, y - gap) : hist(strip.rgb, W, y + gap, y + gap + band);
        const b = side === 'above' ? hist(strip.rgb, W, y + gap, y + gap + band) : hist(strip.rgb, W, y - gap - band, y - gap);
        const dist = side === 'above' ? s.y0 - y : y - s.y1;
        rows.push(
          `#${p.index} ${s.id} B ${s.x1 - s.x0}x${s.y1 - s.y0} (${s.screens} scr) score ${s.score} | ${cut} ${side}, ` +
            `next to ${reach.map((x) => `${x.id} ${x.tier}`).join(',')} | gap to cut ${dist}px | alike ${overlap(a, b).toFixed(2)} | panel ${p.contentY1 - p.contentY0}px`,
        );
      }
    }
  }
  const broll = m.shots.filter((s) => s.tier === 'B').length;
  console.log(`\n== ${ch.id}: ${rows.length} of ${broll} b-roll shots sit across a border/split from a neighbour's shot`);
  console.log(rows.join('\n'));
}
