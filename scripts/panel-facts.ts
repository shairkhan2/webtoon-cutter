/**
 * What the detector found and what the script decided, for some panels.
 * Usage: npx tsx scripts/panel-facts.ts <chapterId> <panelIndex>...
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { intersect } from '../src/core/geometry.ts';
import { runDir } from '../src/core/library.ts';
import type { Manifest, Rect } from '../src/core/types.ts';

const [id, ...idx] = process.argv.slice(2);
const m = JSON.parse(await readFile(path.join(runDir(id), 'manifest.json'), 'utf8')) as Manifest;
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const fmt = (r: Rect) => `${r.x0},${r.y0},${r.x1},${r.y1}`;
for (const n of idx.map(Number)) {
  const p = m.panels.find((q) => q.index === n)!;
  const band = { x0: 0, y0: p.contentY0, x1: m.strip.width, y1: p.contentY1 };
  console.log(`\n#${n} ${p.role} y ${p.contentY0}..${p.contentY1} top ${p.top} bottom ${p.bottom} shots=${p.shotIds.join(',') || '-'} skip=${p.videoSkip ?? '-'}`);
  for (const d of m.detections.filter((d) => d.kind !== 'text' && intersect(d, band))) {
    const covered = m.textBlocks.reduce((s, b) => s + area(intersect(b.zone, d) ?? { x0: 0, y0: 0, x1: 0, y1: 0 }), 0);
    console.log(`  ${d.kind.padEnd(6)} ${fmt(d)} score ${d.score.toFixed(2)}  covered by dialogue ${Math.round((100 * covered) / area(d))}%`);
  }
  for (const l of m.textLines.filter((l) => intersect(l, band))) {
    console.log(`  line   ${fmt(l)} ${l.kind.padEnd(9)} read "${l.read}" (${l.readConf}) | ${l.why}`);
  }
  for (const b of m.textBlocks.filter((b) => intersect(b.zone, band))) {
    console.log(`  zone   ${fmt(b.zone)} ${b.bubble ? 'enclosed balloon' : 'open text'} lines ${b.lines.length}`);
  }
  for (const f of m.frameLines.filter((f) => Math.max(f.yLeft, f.yRight) > p.y0 - 50 && Math.min(f.yLeft, f.yRight) < p.y1 + 50)) {
    console.log(`  frame  ${f.yLeft}->${f.yRight} ${f.kind} ${f.score}`);
  }
  for (const s of m.shots.filter((c) => c.panelId === p.id)) console.log(`  shot   ${s.id} ${fmt(s)} ${s.tier} ${s.focus} | ${s.why}`);
}
