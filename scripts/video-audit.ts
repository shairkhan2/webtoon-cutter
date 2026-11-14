/**
 * Video lane audit across all processed chapters.
 * Usage: npx tsx scripts/video-audit.ts [chapterId]   (with an id: per-clip details)
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { intersect } from '../src/core/geometry.ts';
import { paths } from '../src/core/library.ts';
import type { Manifest, Rect } from '../src/core/types.ts';

const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const inter = (a: Rect, b: Rect) => area(intersect(a, b) ?? { x0: 0, y0: 0, x1: 0, y1: 0 });
const only = process.argv[2];
const rows = [];

for (const dir of await readdir(paths.runs)) {
  if (only && dir !== only) continue;
  const m = JSON.parse(await readFile(path.join(paths.runs, dir, 'manifest.json'), 'utf8')) as Manifest;
  const W = m.strip.width;
  const heads = m.detections.filter((d) => d.kind === 'head');
  const persons = m.detections.filter((d) => d.kind === 'person');
  const art = m.panels.filter((p) => p.role === 'art' || p.role === 'art_text');
  const rejected = art.filter((p) => !p.videoId);

  // Rejected for a face, but dialogue covers at most 20% of that face's box.
  let faceMostlyFree = 0;
  for (const p of rejected.filter((q) => q.videoSkip === 'face_covered')) {
    const band = { x0: 0, y0: p.contentY0, x1: W, y1: p.contentY1 };
    const hs = heads.filter((h) => inter(h, band) >= 0.5 * area(h));
    const best = Math.min(...hs.map((h) => m.textBlocks.reduce((s, b) => s + inter(b.zone, h), 0) / area(h)));
    if (best <= 0.2) faceMostlyFree++;
  }
  // A dialogue zone that came from a giant glyph (line taller than 0.15 W): that is a sound effect.
  const giantZone = (p: (typeof art)[number]) =>
    m.textBlocks.some(
      (b) => b.zone.y1 > p.contentY0 && b.zone.y0 < p.contentY1 && b.lines.some((i) => m.textLines[i].y1 - m.textLines[i].y0 > 0.15 * W),
    );
  const blockedBySfx = rejected.filter(giantZone).length;

  let noSubject = 0;
  let manyLetters = 0;
  const details: string[] = [];
  for (const v of m.video) {
    const subj = heads.some((h) => inter(h, v) >= 0.9 * area(h)) || persons.some((p) => inter(p, v) >= 0.4 * area(p));
    const letters = m.textLines.filter((l) => l.kind === 'sfx' && l.inkFrac >= 0.15 && inter(l, v) >= 0.5 * area(l));
    const lettersArea = letters.reduce((s, l) => s + area(l), 0) / area(v);
    if (!subj) noSubject++;
    if (letters.length >= 3) manyLetters++;
    if (only) details.push(`${v.id} ${v.panelId} ${subj ? 'subject   ' : 'NO SUBJECT'} sfx-lines ${letters.length} (${Math.round(100 * lettersArea)}% of clip) ${v.reason}`);
  }
  rows.push({
    chapter: m.source.file.replace('.cbz', ''),
    artPanels: art.length,
    video: m.video.length,
    rejected: rejected.length,
    'rej:face': rejected.filter((p) => p.videoSkip === 'face_covered').length,
    'rej:face<=20%covered': faceMostlyFree,
    'rej:subject': rejected.filter((p) => p.videoSkip === 'subject_covered').length,
    'rej:small': rejected.filter((p) => p.videoSkip === 'too_small').length,
    'rej:bySfxGlyph': blockedBySfx,
    'clip:noSubject': noSubject,
    'clip:3+letterLines': manyLetters,
  });
  if (only) console.log(details.join('\n'));
}
console.table(rows);
