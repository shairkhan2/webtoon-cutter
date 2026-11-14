/**
 * Watermarks and video shots: for every watermark line on a story page, whether a shot holds it
 * (blurred in the video image), cuts it, or sits next to it; and text lines glued to a watermark
 * line (the rest of a corner banner, possibly read as dialogue).
 * Usage: npx tsx scripts/watermark-report.ts [chapterId|all|name-substring] [--sheet out.jpg]
 *   --sheet: each watermark in its shot (or panel), zoomed: what the video image shows there
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { listChapters, runDir } from '../src/core/library.ts';
import type { Manifest, Rect, TextLine } from '../src/core/types.ts';

const args = process.argv.slice(2);
const sheetAt = args.indexOf('--sheet');
const sheet = sheetAt >= 0 ? args[sheetAt + 1] : null;
const [which = 'all'] = args.filter((a, i) => !a.startsWith('--') && (sheetAt < 0 || i !== sheetAt + 1));
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const inter = (a: Rect, b: Rect) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

const tiles: { id: string; file: string; box: Rect; label: string }[] = [];
const totals = { lines: 0, inShot: 0, cutByShot: 0, nextToShot: 0, outside: 0, glued: 0 };
for (const ch of listChapters().filter((c) => which === 'all' || c.id === which || c.name.includes(which))) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    continue;
  }
  const W = m.strip.width;
  const story = (l: Rect) => {
    const p = m.panels.find((q) => l.y0 < q.y1 && l.y1 > q.y0);
    return p && p.role !== 'credits';
  };
  const marks = m.textLines.filter((l) => l.kind === 'watermark' && story(l));
  const rows: string[] = [];
  for (const l of marks) {
    totals.lines++;
    const holding = m.shots.filter((s) => inter(s, l) > 0);
    const full = holding.filter((s) => inter(s, l) >= 0.95 * area(l));
    const near = m.shots.filter((s) => !holding.includes(s) && l.y0 < s.y1 + 0.08 * W && l.y1 > s.y0 - 0.08 * W && l.x0 < s.x1 && l.x1 > s.x0);
    let state: string;
    if (full.length) (state = `IN ${full.map((s) => s.id).join(',')}`), totals.inShot++;
    else if (holding.length) (state = `CUT by ${holding.map((s) => s.id).join(',')}`), totals.cutByShot++;
    else if (near.length) (state = `next to ${near.map((s) => s.id).join(',')}`), totals.nextToShot++;
    else (state = 'no shot near'), totals.outside++;
    rows.push(`  ${state.padEnd(18)} y${l.y0} x${l.x0}-${l.x1} h${l.y1 - l.y0} "${l.read}" (${l.why.slice(0, 40)})`);
    const shot = holding[0] ?? near[0];
    if (shot) tiles.push({ id: ch.id, file: shot.file, box: { x0: l.x0 - shot.x0, y0: l.y0 - shot.y0, x1: l.x1 - shot.x0, y1: l.y1 - shot.y0 }, label: `${ch.name.replace(/_Chapter (\d+)_.*$/, ' ch$1')} ${shot.id} ${state.split(' ')[0]} "${l.read}"` });
  }
  // Text lines glued to a watermark line: same column, gap under one line height.
  const glued = m.textLines.filter(
    (t) =>
      t.kind === 'text' &&
      story(t) &&
      marks.some((w) => {
        const h = Math.max(t.y1 - t.y0, w.y1 - w.y0);
        const gap = Math.max(w.y0 - t.y1, t.y0 - w.y1);
        const xo = Math.min(t.x1, w.x1) - Math.max(t.x0, w.x0);
        return gap < 1.0 * h && xo > 0.3 * Math.min(t.x1 - t.x0, w.x1 - w.x0);
      }),
  );
  totals.glued += glued.length;
  if (!marks.length && !glued.length) continue;
  console.log(`\n== ${ch.name} (W ${W}): ${marks.length} watermark lines on story pages`);
  console.log(rows.join('\n'));
  for (const t of glued) console.log(`  GLUED TEXT y${t.y0} x${t.x0}-${t.x1} h${t.y1 - t.y0} "${t.read}"`);
}
console.log(`\ntotal watermark lines ${totals.lines}: whole inside a shot ${totals.inShot}, cut by a shot edge ${totals.cutByShot}, next to a shot ${totals.nextToShot}, no shot near ${totals.outside}; text lines glued to them ${totals.glued}`);

if (sheet && tiles.length) {
  const tw = 300, th = 170, cols = 5;
  const comp: sharp.OverlayOptions[] = [];
  for (const [i, t] of tiles.entries()) {
    const img = sharp(path.join(runDir(t.id), 'video', t.file));
    const meta = await img.metadata();
    const w = meta.width!, h = meta.height!;
    // A window 2.5x the watermark around it, clipped to the shot image.
    const bw = t.box.x1 - t.box.x0, bh = t.box.y1 - t.box.y0;
    const x0 = Math.max(0, Math.round(t.box.x0 - 0.75 * bw)), x1 = Math.min(w, Math.round(t.box.x1 + 0.75 * bw));
    const y0 = Math.max(0, Math.round(t.box.y0 - 1.5 * bh)), y1 = Math.min(h, Math.round(t.box.y1 + 1.5 * bh));
    let tile: Buffer;
    if (x1 - x0 < 4 || y1 - y0 < 4) tile = await sharp({ create: { width: tw, height: th - 22, channels: 3, background: '#300' } }).png().toBuffer();
    else tile = await sharp(path.join(runDir(t.id), 'video', t.file)).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).resize(tw, th - 22, { fit: 'contain', background: '#111' }).toBuffer();
    const lab = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="22"><rect width="100%" height="100%" fill="#222"/><text x="3" y="15" font-size="11" font-family="Arial" fill="#fff">${(i + 1) + '. ' + t.label.replace(/[&<>]/g, '').slice(0, 52)}</text></svg>`);
    const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
    comp.push({ input: lab, left: x, top: y }, { input: tile, left: x, top: y + 22 });
  }
  await sharp({ create: { width: cols * tw, height: Math.ceil(tiles.length / cols) * th, channels: 3, background: '#000' } }).composite(comp).jpeg({ quality: 85 }).toFile(sheet);
  console.log(`sheet: ${tiles.length} -> ${sheet}`);
}
