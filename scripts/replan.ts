/**
 * Re-plans video shots for processed chapters with the current shot rules, reusing the saved
 * detections, text and panels (no models run). Writes data/runs/<id>/replan.json for
 * frame-sheet.ts and prints what changed.
 * Usage: npx tsx scripts/replan.ts <chapterId|all>
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStrip } from '../src/core/cbz.ts';
import { analyzeDetail } from '../src/core/interest.ts';
import { listChapters, runDir } from '../src/core/library.ts';
import { planShots } from '../src/core/shots.ts';
import type { Manifest, Panel, Shot } from '../src/core/types.ts';

const [which = 'all'] = process.argv.slice(2);
const chapters = listChapters().filter((c) => which === 'all' || c.id === which);
const screensOf = (s: Shot) => (s.y1 - s.y0) / ((9 / 16) * (s.x1 - s.x0));
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
const totals = { before: 0, after: 0, panelsBefore: 0, panelsAfter: 0, multiBefore: 0, multiAfter: 0 };
const allBefore: number[] = [];
const allAfter: number[] = [];
for (const ch of chapters) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    continue;
  }
  const strip = await loadStrip(ch.file);
  const detail = analyzeDetail(strip.gray, strip.width, strip.height);
  const panels: Panel[] = m.panels.map((p) => ({ ...p, shotIds: [], videoSkip: undefined }));
  const shots = planShots(panels, {
    width: m.strip.width,
    height: m.strip.height,
    detail,
    faces: m.detections.filter((d) => d.kind === 'face'),
    heads: m.detections.filter((d) => d.kind === 'head'),
    persons: m.detections.filter((d) => d.kind === 'person'),
    blocks: m.textBlocks,
    lines: m.textLines,
    frameLines: m.frameLines,
    pages: m.pages,
  });
  await writeFile(path.join(runDir(ch.id), 'replan.json'), JSON.stringify({ shots, panels }, null, 1));
  const withShots = (ps: Panel[]) => ps.filter((p) => p.shotIds.length).length;
  const multi = (ps: Panel[]) => ps.filter((p) => p.shotIds.length > 1).length;
  totals.before += m.shots.length;
  totals.after += shots.length;
  totals.panelsBefore += withShots(m.panels);
  totals.panelsAfter += withShots(panels);
  totals.multiBefore += multi(m.panels);
  totals.multiAfter += multi(panels);
  allBefore.push(...m.shots.map(screensOf));
  allAfter.push(...shots.map(screensOf));
  console.log(
    `${ch.id.slice(0, 30).padEnd(30)} shots ${m.shots.length} -> ${shots.length}, panels with a shot ${withShots(m.panels)} -> ${withShots(panels)}, ` +
      `2+ shots ${multi(m.panels)} -> ${multi(panels)}, median screens ${median(m.shots.map(screensOf)).toFixed(2)} -> ${median(shots.map(screensOf)).toFixed(2)}`,
  );
}
const bucket = (v: number[]) => {
  const edges = [1, 1.5, 2, 2.5, 3.2];
  const n = new Array(edges.length + 1).fill(0);
  for (const x of v) n[edges.filter((e) => x >= e).length]++;
  return `<1: ${n[0]}  1-1.5: ${n[1]}  1.5-2: ${n[2]}  2-2.5: ${n[3]}  2.5-3.2: ${n[4]}  >3.2: ${n[5]}`;
};
console.log(`\nshots ${totals.before} -> ${totals.after}; panels with a shot ${totals.panelsBefore} -> ${totals.panelsAfter}; panels with 2+ shots ${totals.multiBefore} -> ${totals.multiAfter}`);
console.log(`screens before: ${bucket(allBefore)}`);
console.log(`screens after:  ${bucket(allAfter)}`);
