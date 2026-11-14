/**
 * List the cases behind the check numbers for one chapter.
 * Usage: npx tsx scripts/inspect.ts <chapterId>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { crossesY, intersect } from '../src/core/geometry.ts';
import { runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

const id = process.argv[2];
const m = JSON.parse(await readFile(path.join(runDir(id), 'manifest.json'), 'utf8')) as Manifest;
const heads = m.detections.filter((d) => d.kind === 'head');
const area = (r: { x0: number; y0: number; x1: number; y1: number }) => (r.x1 - r.x0) * (r.y1 - r.y0);

console.log('reader cuts through heads:');
for (const p of m.panels) {
  for (const [y, kind] of [[p.y0, p.top], [p.y1, p.bottom]] as const) {
    if (kind === 'start' || kind === 'end') continue;
    for (const h of heads) if (crossesY(h, y, 0.1 * (h.y1 - h.y0))) console.log(`  ${p.id} ${kind} y=${y} head ${h.y0}..${h.y1} score ${h.score.toFixed(2)}`);
  }
}
console.log('video edges through heads:');
for (const v of m.video) {
  for (const h of heads) {
    const i = intersect(h, v);
    if (i && area(i) < 0.9 * area(h)) {
      const p = m.panels.find((q) => q.id === v.panelId)!;
      console.log(`  ${v.id} ${v.reason} clip y ${v.y0}..${v.y1} x ${v.x0}..${v.x1} | panel ${p.id} ${p.contentY0}..${p.contentY1} | head ${h.x0},${h.y0},${h.x1},${h.y1} inside ${(area(i) / area(h)).toFixed(2)}`);
    }
  }
}
console.log('art panels without video:');
for (const p of m.panels) {
  if ((p.role === 'art' || p.role === 'art_text') && !p.videoId) {
    console.log(`  ${p.id} ${p.role} ${p.y0}..${p.y1} (h ${p.y1 - p.y0}) heads ${p.heads} persons ${p.persons} text ${p.textBlocks} skip=${p.videoSkip ?? '?'}`);
  }
}
