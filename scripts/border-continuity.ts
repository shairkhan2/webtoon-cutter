/**
 * For every verified frame border the segmenter cuts at: does the picture run on across the line?
 *   cross: mean difference between rows `gap` px above and below the line (8-px column means)
 *   within: the same difference measured inside each side, `gap` px apart (texture baseline)
 *   ratio = cross / within: about 1 when the picture continues, large when two panels meet.
 * Usage: npx tsx scripts/border-continuity.ts [--sheet out.jpg] [--max ratio]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { loadStrip } from '../src/core/cbz.ts';
import { listChapters, runDir } from '../src/core/library.ts';
import { analyzeCells, analyzeRows } from '../src/core/rows.ts';
import { segment } from '../src/core/segment.ts';
import type { FrameLine, Manifest } from '../src/core/types.ts';

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const sheet = opt('--sheet');
const maxRatio = Number(opt('--max') ?? 99);

/** Row y along a possibly slanted line, at column x. */
const lineY = (f: FrameLine, x: number, W: number) => f.yLeft + ((f.yRight - f.yLeft) * x) / W;

type Row = { tag: string; s: Awaited<ReturnType<typeof loadStrip>>; f: FrameLine; ratio: number; cross: number; within: number };
const rows: Row[] = [];
for (const ch of listChapters()) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    continue;
  }
  const s = await loadStrip(ch.file);
  const { width: W, height, gray, rgb } = s;
  const seg = segment({
    width: W, height, gray, rgb,
    rows: analyzeRows(gray, W, height), cells: analyzeCells(gray, W, height),
    heads: m.detections.filter((d) => d.kind === 'head'), persons: m.detections.filter((d) => d.kind === 'person'),
    blocks: m.textBlocks, pages: s.pages,
  });
  const at = (x: number, y: number) => gray[Math.min(height - 1, Math.max(0, Math.round(y))) * W + x];
  // Mean |a - b| over 8-px column means of two rows following the line at offsets da and db.
  const diff = (f: FrameLine, da: number, db: number) => {
    let sum = 0, n = 0;
    for (let x = 0; x + 8 <= W; x += 8) {
      let a = 0, b = 0;
      for (let k = 0; k < 8; k++) {
        const y = lineY(f, x + k, W);
        a += at(x + k, y + da);
        b += at(x + k, y + db);
      }
      sum += Math.abs(a - b) / 8;
      n++;
    }
    return sum / n;
  };
  const tag = ch.id.replace(/^(Asura_Scans|Elf_Toon)_Chapter_(\d+).*$/, (_, g, n) => `${g === 'Elf_Toon' ? 'E' : 'A'}${n}`);
  for (const f of seg.frameLines) {
    const gap = 12;
    const cross = diff(f, -gap, gap);
    const within = (diff(f, -gap, -3 * gap) + diff(f, gap, 3 * gap)) / 2;
    rows.push({ tag: `${tag} y${Math.round(f.yLeft)} ${f.kind}`, s, f, cross, within, ratio: cross / Math.max(3, within) });
  }
}
rows.sort((a, b) => a.ratio - b.ratio);
const q = (p: number) => rows[Math.min(rows.length - 1, Math.floor(p * rows.length))].ratio.toFixed(2);
console.log(`${rows.length} frame-border cuts; ratio p10 ${q(0.1)} p25 ${q(0.25)} median ${q(0.5)} p75 ${q(0.75)}`);
for (const r of rows.filter((r) => r.ratio <= maxRatio)) console.log(`  ${r.tag} ratio ${r.ratio.toFixed(2)} cross ${r.cross.toFixed(1)} within ${r.within.toFixed(1)}`);

if (sheet) {
  const pick = rows.filter((r) => r.ratio <= maxRatio);
  const tw = 300, th = 340, cols = 5;
  const comp: sharp.OverlayOptions[] = [];
  for (const [i, r] of pick.entries()) {
    const yc = Math.round((r.f.yLeft + r.f.yRight) / 2);
    const y0 = Math.max(0, yc - 420), h = Math.min(840, r.s.height - y0);
    const raw = Buffer.from(r.s.rgb.buffer, r.s.rgb.byteOffset + y0 * r.s.width * 3, h * r.s.width * 3);
    const mark = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${r.s.width}" height="${h}"><rect x="0" y="${r.f.yLeft - y0 - 5}" width="28" height="10" fill="#00ff00"/><rect x="${r.s.width - 28}" y="${r.f.yRight - y0 - 5}" width="28" height="10" fill="#00ff00"/></svg>`);
    const full = await sharp(raw, { raw: { width: r.s.width, height: h, channels: 3 } }).composite([{ input: mark, left: 0, top: 0 }]).png().toBuffer();
    const small = await sharp(full).resize(tw, th - 22, { fit: 'contain', background: '#111' }).toBuffer();
    const lab = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="22"><rect width="100%" height="100%" fill="#222"/><text x="3" y="15" font-size="11" font-family="Arial" fill="#fff">${i + 1}. ${r.tag} ratio ${r.ratio.toFixed(2)}</text></svg>`);
    const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
    comp.push({ input: lab, left: x, top: y }, { input: small, left: x, top: y + 22 });
  }
  await sharp({ create: { width: cols * tw, height: Math.max(1, Math.ceil(pick.length / cols)) * th, channels: 3, background: '#000' } }).composite(comp).jpeg({ quality: 84 }).toFile(sheet);
  console.log(`sheet: ${pick.length} -> ${sheet}`);
}
