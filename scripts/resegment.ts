/**
 * Dry run of panel segmentation with the current rules, from saved detections and text (no
 * models): lists every reader-panel cut that would appear or disappear compared with manifest.json.
 * Usage: npx tsx scripts/resegment.ts [chapterId|all] [--sheet out.jpg]
 *   --sheet: before/after crops of each changed cut (red = removed cut, green = new cut)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { loadStrip } from '../src/core/cbz.ts';
import { listChapters, runDir } from '../src/core/library.ts';
import { analyzeCells, analyzeRows } from '../src/core/rows.ts';
import { buildPanels, segment } from '../src/core/segment.ts';
import type { Manifest, Panel } from '../src/core/types.ts';

const args = process.argv.slice(2);
const sheetAt = args.indexOf('--sheet');
const sheet = sheetAt >= 0 ? args[sheetAt + 1] : null;
const [which = 'all'] = args.filter((a, i) => !a.startsWith('--') && (sheetAt < 0 || i !== sheetAt + 1));

interface Cut { y: number; kind: string; above: string; below: string }
const cutsOf = (panels: Panel[]): Cut[] =>
  panels.slice(1).map((p, i) => ({ y: Math.round((panels[i].contentY1 + p.contentY0) / 2), kind: p.top, above: panels[i].role, below: p.role }));

const changes: { file: string; y: number; label: string; color: string }[] = [];
let removedAll = 0;
let addedAll = 0;
for (const ch of listChapters().filter((c) => which === 'all' || c.id === which)) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    continue;
  }
  const strip = await loadStrip(ch.file);
  const { width, height, gray, rgb } = strip;
  const rows = analyzeRows(gray, width, height);
  const cells = analyzeCells(gray, width, height);
  const seg = segment({
    width,
    height,
    gray,
    rgb,
    rows,
    cells,
    heads: m.detections.filter((d) => d.kind === 'head'),
    persons: m.detections.filter((d) => d.kind === 'person'),
    blocks: m.textBlocks,
    pages: strip.pages,
  });
  const panels = buildPanels(seg, strip.pages, width, height);
  const before = cutsOf(m.panels);
  const after = cutsOf(panels);
  const near = (list: Cut[], y: number) => list.some((c) => Math.abs(c.y - y) <= 40);
  const removed = before.filter((c) => !near(after, c.y));
  const added = after.filter((c) => !near(before, c.y));
  for (const c of before) {
    const now = after.find((a) => Math.abs(a.y - c.y) <= 40);
    if (now && now.kind !== c.kind) console.log(`  ${ch.id.slice(0, 13)} y${c.y} kind ${c.kind} -> ${now.kind} (${now.above}/${now.below})`);
  }
  removedAll += removed.length;
  addedAll += added.length;
  console.log(`== ${ch.id}: panels ${m.panels.length} -> ${panels.length}, cuts removed ${removed.length}, added ${added.length}`);
  for (const c of removed) {
    const label = `${ch.id.slice(0, 13)} y${c.y} REMOVED ${c.kind} (${c.above}/${c.below})`;
    console.log('  ' + label);
    changes.push({ file: ch.file, y: c.y, label, color: '#ff3030' });
  }
  for (const c of added) {
    const label = `${ch.id.slice(0, 13)} y${c.y} ADDED ${c.kind} (${c.above}/${c.below})`;
    console.log('  ' + label);
    changes.push({ file: ch.file, y: c.y, label, color: '#30ff60' });
  }
}
console.log(`\ntotal: ${removedAll} cuts removed, ${addedAll} added`);

if (sheet && changes.length) {
  const tw = 260, th = 420, cols = 5;
  const comp: sharp.OverlayOptions[] = [];
  const strips = new Map<string, Awaited<ReturnType<typeof loadStrip>>>();
  for (const [i, t] of changes.entries()) {
    let s = strips.get(t.file);
    if (!s) strips.set(t.file, (s = await loadStrip(t.file)));
    const y0 = Math.max(0, t.y - 700);
    const h = Math.min(1400, s.height - y0);
    const raw = Buffer.from(s.rgb.buffer, s.rgb.byteOffset + y0 * s.width * 3, h * s.width * 3);
    const mark = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${h}"><line x1="0" x2="${s.width}" y1="${t.y - y0}" y2="${t.y - y0}" stroke="${t.color}" stroke-width="10" stroke-dasharray="40,24"/></svg>`);
    const full = await sharp(raw, { raw: { width: s.width, height: h, channels: 3 } }).composite([{ input: mark, left: 0, top: 0 }]).png().toBuffer();
    const small = await sharp(full).resize(tw, th - 26, { fit: 'contain', background: '#111' }).toBuffer();
    const lab = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="26"><rect width="100%" height="100%" fill="#222"/><text x="3" y="17" font-size="11" font-family="Arial" fill="${t.color}">${i + 1}. ${t.label.replace(/[&<>]/g, '')}</text></svg>`);
    const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
    comp.push({ input: lab, left: x, top: y }, { input: small, left: x, top: y + 26 });
  }
  await sharp({ create: { width: cols * tw, height: Math.ceil(changes.length / cols) * th, channels: 3, background: '#000' } }).composite(comp).jpeg({ quality: 84 }).toFile(sheet);
  console.log(`sheet: ${changes.length} changes -> ${sheet}`);
}
