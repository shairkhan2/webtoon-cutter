/**
 * Shots well short of 9:16 in panels tall enough for a 9:16 box, and why the 9:16 boxes around
 * them lost: each is tried from the shot's top, from its bottom and centred on it.
 * Usage: npx tsx scripts/why-small.ts [chapterId|all] [maxShare=0.85] [-v] [--art]
 *   -v: score parts · --art: only shots that leave out over 10% of the panel's art
 *   Reads replan.json (scripts/replan.ts) when present, else manifest.json.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStrip } from '../src/core/cbz.ts';
import { analyzeDetail } from '../src/core/interest.ts';
import { listChapters, runDir } from '../src/core/library.ts';
import { explainBoxes, type ShotInput } from '../src/core/shots.ts';
import type { Manifest, Panel, Rect, Shot } from '../src/core/types.ts';

const args = process.argv.slice(2);
const verbose = args.includes('-v');
const artMode = args.includes('--art');
const [which = 'all', share = '0.85'] = args.filter((a) => !a.startsWith('-'));
const maxShare = Number(share);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const tally = new Map<string, number>();
let short = 0;
let total = 0;
for (const ch of listChapters().filter((c) => which === 'all' || c.id === which)) {
  const dir = runDir(ch.id);
  if (!existsSync(path.join(dir, 'manifest.json'))) continue;
  const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const re = existsSync(path.join(dir, 'replan.json')) ? JSON.parse(await readFile(path.join(dir, 'replan.json'), 'utf8')) : null;
  const shots: Shot[] = re?.shots ?? m.shots;
  const strip = await loadStrip(ch.file);
  const input: ShotInput = {
    width: m.strip.width,
    height: m.strip.height,
    detail: analyzeDetail(strip.gray, strip.width, strip.height),
    faces: m.detections.filter((d) => d.kind === 'face'),
    heads: m.detections.filter((d) => d.kind === 'head'),
    persons: m.detections.filter((d) => d.kind === 'person'),
    blocks: m.textBlocks,
    lines: m.textLines,
    frameLines: m.frameLines,
    pages: m.pages,
  };
  console.log(`\n== ${ch.id}`);
  for (const s of shots) {
    const p = m.panels.find((q) => q.id === s.panelId) as Panel;
    const w = s.x1 - s.x0;
    const sweet = Math.round((16 / 9) * w);
    if (p.contentY1 - p.contentY0 < sweet) continue; // panel too short for a 9:16 box
    total++;
    if (s.y1 - s.y0 >= maxShare * sweet) continue;
    const clamp = (y0: number): Rect => {
      const a = Math.max(p.contentY0, Math.min(y0, p.contentY1 - sweet));
      return { x0: s.x0, y0: a, x1: s.x1, y1: a + sweet };
    };
    const boxes = [clamp(s.y0), clamp(s.y1 - sweet), clamp(Math.round((s.y0 + s.y1 - sweet) / 2))];
    const [self, ...res] = explainBoxes(p, input, [s, ...boxes]);
    // --art: only shots that leave out part of the panel's art (not just balloons and empty rows).
    const art = 'reject' in self ? 0 : Number(/art ([\d.]+)/.exec(self.parts)?.[1] ?? 0);
    if (artMode && art >= 0.9) continue;
    short++;
    if (verbose) {
      const show = (label: string, r: (typeof res)[number]) => console.log(`    ${label}: ${'reject' in r ? r.reject : `${r.score} (base ${r3(r.base)}) ${r.parts} | ${r.why}`}`);
      show('chosen', self);
      res.forEach((r, i) => show(['from top', 'from bottom', 'centred'][i], r));
    }
    const kind = (r: (typeof res)[number]) => ('reject' in r ? `${r.reject}${r.note ? ` (${r.note.replace(/[\d.]+/g, 'n')})` : ''}` : 'scored lower');
    const fmt = res.map((r) => ('reject' in r ? `${r.reject}${r.note ? ` (${r.note})` : ''}` : `ok ${r.score}`));
    for (const k of new Set(res.map(kind))) tally.set(k, (tally.get(k) ?? 0) + 1);
    console.log(`#${p.index} ${s.id} ${w}x${s.y1 - s.y0} (${s.score}) in ${p.contentY1 - p.contentY0}px panel | from top: ${fmt[0]} | from bottom: ${fmt[1]} | centred: ${fmt[2]}`);
  }
}
console.log(`\n${short} of ${total} shots in panels tall enough for 9:16 are under ${Math.round(maxShare * 100)}% of it${artMode ? ' and leave out over 10% of the art' : ''}.`);
console.log('what the 9:16 boxes around them hit:', Object.fromEntries([...tally.entries()].sort((a, b) => b[1] - a[1])));
