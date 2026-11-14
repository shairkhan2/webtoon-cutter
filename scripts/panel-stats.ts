/** Shape of the art panels the video lane has to handle, across all processed chapters. */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

let total = 0;
const byScreens = { '<=1': 0, '1-2': 0, '2-3': 0, '3-5': 0, '>5': 0 };
const bySubjects = { none: 0, one: 0, two: 0, '3+': 0 };
let tallWithOnePerson = 0;
let tallWithGap = 0;
for (const dir of await readdir(paths.runs)) {
  const m = JSON.parse(await readFile(path.join(paths.runs, dir, 'manifest.json'), 'utf8')) as Manifest;
  const W = m.strip.width;
  const screen = (9 / 16) * W; // one full-width 16:9 frame
  for (const p of m.panels.filter((q) => q.role === 'art' || q.role === 'art_text')) {
    total++;
    const h = (p.contentY1 - p.contentY0) / screen;
    byScreens[h <= 1 ? '<=1' : h <= 2 ? '1-2' : h <= 3 ? '2-3' : h <= 5 ? '3-5' : '>5']++;
    const people = m.detections.filter(
      (d) => (d.kind === 'head' || d.kind === 'person') && d.y0 < p.contentY1 && d.y1 > p.contentY0,
    );
    // Merge head+person boxes that overlap vertically into one subject.
    const spans = people.map((d) => [d.y0, d.y1]).sort((a, b) => a[0] - b[0]);
    const subjects: number[][] = [];
    for (const s of spans) {
      const last = subjects[subjects.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else subjects.push([...s]);
    }
    const n = subjects.length;
    bySubjects[n === 0 ? 'none' : n === 1 ? 'one' : n === 2 ? 'two' : '3+']++;
    if (h > 2 && n === 1) tallWithOnePerson++;
    if (h > 2) {
      const covered = subjects.reduce((s, [a, b]) => s + Math.min(b, p.contentY1) - Math.max(a, p.contentY0), 0);
      if ((p.contentY1 - p.contentY0 - covered) / screen >= 0.7) tallWithGap++;
    }
  }
}
console.log({ artPanels: total, heightInScreens: byScreens, subjectsPerPanel: bySubjects, tallerThan2Screens_onePersonSpan: tallWithOnePerson, tallerThan2Screens_with70pctScreenOfNoPeople: tallWithGap });
