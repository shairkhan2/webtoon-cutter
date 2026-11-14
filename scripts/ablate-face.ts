/**
 * Is the face model worth its time? Re-plans every processed chapter twice from the saved
 * detections: with the face boxes, and with the head box standing in for the face (what the
 * cutter can do without the face model).
 * Usage: npx tsx scripts/ablate-face.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStrip } from '../src/core/cbz.ts';
import { analyzeDetail } from '../src/core/interest.ts';
import { listChapters, paths } from '../src/core/library.ts';
import { planShots } from '../src/core/shots.ts';
import type { Manifest, Panel, Shot } from '../src/core/types.ts';

const chapters = listChapters();
const rows = [];
const total = { withFace: 0, headOnly: 0, panelsWith: 0, panelsHead: 0 };
for (const dir of await readdir(paths.runs)) {
  const m = JSON.parse(await readFile(path.join(paths.runs, dir, 'manifest.json'), 'utf8')) as Manifest;
  const ch = chapters.find((c) => c.id === dir);
  if (!ch || !m.shots) continue;
  const strip = await loadStrip(ch.file);
  const detail = analyzeDetail(strip.gray, strip.width, strip.height);
  const heads = m.detections.filter((d) => d.kind === 'head');
  const base = {
    width: m.strip.width,
    height: m.strip.height,
    detail,
    heads,
    persons: m.detections.filter((d) => d.kind === 'person'),
    blocks: m.textBlocks,
    lines: m.textLines,
    frameLines: m.frameLines,
    pages: m.pages,
  };
  const clone = (): Panel[] => m.panels.map((p) => ({ ...p, shotIds: [] }));
  const faceShots = (s: Shot[]) => s.filter((x) => x.focus === 'face').length;
  const panelsWithFaceShot = (s: Shot[]) => new Set(s.filter((x) => x.focus === 'face').map((x) => x.panelId)).size;
  const faces = m.detections.filter((d) => d.kind === 'face');
  const a = planShots(clone(), { ...base, faces });
  const b = planShots(clone(), { ...base, faces: heads.map((h) => ({ ...h, kind: 'face' as const })) });
  // Quality, judged with the face model's boxes: shot edges through a real face, balloon share.
  const area = (r: { x0: number; y0: number; x1: number; y1: number }) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
  const cutsFace = (s: Shot) =>
    faces.some((f) => {
      const i = { x0: Math.max(f.x0, s.x0), y0: Math.max(f.y0, s.y0), x1: Math.min(f.x1, s.x1), y1: Math.min(f.y1, s.y1) };
      const share = area(i) / area(f);
      return share > 0.1 && share < 0.9 && f.y0 >= s.y0 - 0.5 * (f.y1 - f.y0) && f.y1 <= s.y1 + 0.5 * (f.y1 - f.y0);
    });
  const meanBalloon = (s: Shot[]) => s.reduce((t, x) => t + x.dialogueShare, 0) / Math.max(1, s.length);
  const longPans = (s: Shot[]) => s.filter((x) => x.screens > 2).length;
  for (const [k, v] of Object.entries({
    withFace: faceShots(a), headOnly: faceShots(b), panelsWith: panelsWithFaceShot(a), panelsHead: panelsWithFaceShot(b),
    cutsWith: a.filter(cutsFace).length, cutsHead: b.filter(cutsFace).length, longWith: longPans(a), longHead: longPans(b),
  })) (total as Record<string, number>)[k] = ((total as Record<string, number>)[k] ?? 0) + v;
  rows.push({
    chapter: m.source.file.replace('.cbz', ''),
    'face shots (model / head only)': `${faceShots(a)} / ${faceShots(b)}`,
    'edges through a real face': `${a.filter(cutsFace).length} / ${b.filter(cutsFace).length}`,
    'mean balloon %': `${(100 * meanBalloon(a)).toFixed(1)} / ${(100 * meanBalloon(b)).toFixed(1)}`,
    'pans > 2 frames': `${longPans(a)} / ${longPans(b)}`,
    'hair-trimmed shots': `${a.filter((x) => x.why.includes('hair trimmed')).length} / ${b.filter((x) => x.why.includes('hair trimmed')).length}`,
  });
}
console.table(rows);
console.log(total);
