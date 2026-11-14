/**
 * Shots and rejections for a processed chapter.
 * Usage: npx tsx scripts/shot-report.ts <chapterId> [y...]
 *   without y: art panels that got no shot, and totals
 *   with y:    the panel containing each strip row, and its shots
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runDir } from '../src/core/library.ts';
import type { Manifest, Shot } from '../src/core/types.ts';

const [id, ...ys] = process.argv.slice(2);
const m = JSON.parse(await readFile(path.join(runDir(id), 'manifest.json'), 'utf8')) as Manifest;
const line = (s: Shot) =>
  `  ${s.id} ${s.tier} ${s.focus}/${s.framing} ${s.motion} ${s.screens}scr score ${s.score} ` +
  `x ${s.x0}-${s.x1} y ${s.y0}-${s.y1} balloon ${Math.round(s.dialogueShare * 100)}% | ${s.why}`;

if (ys.length) {
  for (const y of ys.map(Number)) {
    const p = m.panels.find((q) => y >= q.y0 && y < q.y1);
    if (!p) {
      console.log(`y ${y}: in no panel`);
      continue;
    }
    console.log(`y ${y} -> #${p.index} ${p.role} ${p.contentY0}-${p.contentY1} shots [${p.shotIds.join(' ')}]${p.videoSkip ? ` skip=${p.videoSkip}` : ''}`);
    for (const sid of p.shotIds) console.log(line(m.shots.find((s) => s.id === sid)!));
  }
} else {
  console.log('art panels without shots:');
  for (const p of m.panels) {
    if ((p.role === 'art' || p.role === 'art_text') && !p.shotIds.length) {
      console.log(`  #${p.index} y ${p.contentY0}-${p.contentY1} (h ${p.contentY1 - p.contentY0}) heads ${p.heads} persons ${p.persons} skip=${p.videoSkip}`);
    }
  }
  console.log(`credits panels: ${m.panels.filter((p) => p.role === 'credits').map((p) => `#${p.index}`).join(' ') || '-'} (pages ${m.creditPages.join(', ') || '-'})`);
  const by = (k: keyof Shot) => Object.entries(m.shots.reduce<Record<string, number>>((a, s) => ((a[String(s[k])] = (a[String(s[k])] ?? 0) + 1), a), {}));
  console.log('focus:', by('focus').map(([k, n]) => `${k} ${n}`).join(', '), '| framing:', by('framing').map(([k, n]) => `${k} ${n}`).join(', '));
  console.log('shots per art panel:', by('panelId').reduce<Record<number, number>>((a, [, n]) => ((a[n] = (a[n] ?? 0) + 1), a), {}));
}
