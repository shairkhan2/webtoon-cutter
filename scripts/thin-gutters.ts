/**
 * Reader-panel cuts made at a thin gutter between two art panels: where one picture can get split
 * in two. For each: gutter height and colour, whether head/body boxes reach the band, and how much
 * drawn content touches the band from above and below.
 * Usage: npx tsx scripts/thin-gutters.ts [chapterId|all] [maxHeightW=0.08] [--sheet out.jpg]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { loadStrip } from '../src/core/cbz.ts';
import { listChapters, runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

const args = process.argv.slice(2);
const sheetAt = args.indexOf('--sheet');
const sheet = sheetAt >= 0 ? args[sheetAt + 1] : null;
const rest = args.filter((a, i) => a !== '--sheet' && (sheetAt < 0 || i !== sheetAt + 1));
const [which = 'all', maxH = '0.08'] = rest;
const maxHeight = Number(maxH);
const isArt = (role: string) => role === 'art' || role === 'art_text';

const tiles: { file: string; y0: number; y1: number; label: string }[] = [];
let allArtCuts = 0;
for (const ch of listChapters().filter((c) => which === 'all' || c.id === which)) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    continue;
  }
  const strip = await loadStrip(ch.file);
  const W = m.strip.width;
  const H = m.strip.height;
  const rgbMean = (y0: number, y1: number) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 3;
      r += strip.rgb[i]; g += strip.rgb[i + 1]; b += strip.rgb[i + 2]; n++;
    }
    return [r / n, g / n, b / n].map(Math.round);
  };
  // Share of 8-px columns with visible content in a row (gray range within the column > 24).
  const busy = (y: number) => {
    let k = 0, n = 0;
    for (let x = 0; x + 8 <= W; x += 8, n++) {
      let lo = 255, hi = 0;
      for (let d = 0; d < 8; d++) { const v = strip.gray[y * W + x + d]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
      if (hi - lo > 24) k++;
    }
    return k / n;
  };
  const rows: string[] = [];
  for (let i = 0; i + 1 < m.panels.length; i++) {
    const a = m.panels[i];
    const b = m.panels[i + 1];
    if (a.bottom !== 'gutter' || !isArt(a.role) || !isArt(b.role)) continue;
    allArtCuts++;
    const g0 = a.contentY1;
    const g1 = b.contentY0;
    const len = g1 - g0;
    if (len > maxHeight * W) continue;
    const [r, gg, bb] = rgbMean(g0, Math.max(g0 + 1, g1));
    const reach = (k: string) => m.detections.filter((d) => d.kind === k && d.y0 < g1 + 0.03 * W && d.y1 > g0 - 0.03 * W).length;
    const above = busy(Math.max(0, g0 - 2));
    const below = busy(Math.min(H - 1, g1 + 1));
    const label = `${ch.id.slice(0, 13)} #${a.index}/#${b.index} y${g0} ${len}px rgb ${r},${gg},${bb} | heads ${reach('head')} bodies ${reach('person')} | edge busy ${above.toFixed(2)}/${below.toFixed(2)}`;
    rows.push(label);
    tiles.push({ file: ch.file, y0: g0, y1: g1, label });
  }
  console.log(`== ${ch.id}: ${rows.length} thin gutter cuts between art panels`);
  if (rows.length) console.log(rows.join('\n'));
}
console.log(`\n${tiles.length} of ${allArtCuts} gutter cuts between two art panels are under ${maxHeight}W.`);

if (sheet && tiles.length) {
  // A 700-px window around each cut, scaled down, the gutter marked in red.
  const tw = 240, th = 330, cols = 6;
  const comp: sharp.OverlayOptions[] = [];
  const strips = new Map<string, Awaited<ReturnType<typeof loadStrip>>>();
  for (const [i, t] of tiles.entries()) {
    let s = strips.get(t.file);
    if (!s) strips.set(t.file, (s = await loadStrip(t.file)));
    const mid = Math.round((t.y0 + t.y1) / 2);
    const y0 = Math.max(0, mid - 350);
    const h = Math.min(700, s.height - y0);
    const raw = Buffer.from(s.rgb.buffer, s.rgb.byteOffset + y0 * s.width * 3, h * s.width * 3);
    const mark = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${h}"><rect x="0" y="${t.y0 - y0 - 3}" width="${s.width}" height="${Math.max(6, t.y1 - t.y0 + 6)}" fill="none" stroke="#ff2a2a" stroke-width="6"/></svg>`,
    );
    const img = await sharp(raw, { raw: { width: s.width, height: h, channels: 3 } })
      .composite([{ input: mark, left: 0, top: 0 }])
      .png()
      .toBuffer();
    const small = await sharp(img).resize(tw, th - 30, { fit: 'contain', background: '#111' }).toBuffer();
    const esc = t.label.replace(/[&<>]/g, '');
    const lab = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="30"><rect width="100%" height="100%" fill="#222"/><text x="3" y="12" font-size="10" font-family="Arial" fill="#fff">${i + 1}. ${esc.slice(0, 46)}</text><text x="3" y="25" font-size="10" font-family="Arial" fill="#9cf">${esc.slice(46, 110)}</text></svg>`,
    );
    const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
    comp.push({ input: lab, left: x, top: y }, { input: small, left: x, top: y + 30 });
  }
  await sharp({ create: { width: cols * tw, height: Math.ceil(tiles.length / cols) * th, channels: 3, background: '#000' } })
    .composite(comp)
    .jpeg({ quality: 82 })
    .toFile(sheet);
  console.log(`sheet: ${tiles.length} cuts -> ${sheet}`);
}
