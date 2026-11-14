/**
 * Features of the thin gutter cuts between art panels, to tell a real gap between two panels from
 * a flat band inside one picture (a rail, a cheek, an empty dark sky between figures).
 *   neutral: band is white or black (low chroma); spread: share of the band's colour found in the
 *   rows just above and below it (a band inside a picture usually runs on into them); match: share
 *   of 16-px columns whose colour just above the band is close to the colour just below it.
 * Usage: npx tsx scripts/gutter-features.ts [maxHeightW=0.08] [--sheet out.jpg i,j,k]
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
const pick = sheetAt >= 0 && args[sheetAt + 2] ? args[sheetAt + 2].split(',').map(Number) : null;
const maxHeight = Number(args.find((a, i) => i !== sheetAt + 1 && i !== sheetAt + 2 && !a.startsWith('--')) ?? 0.08);
const isArt = (role: string) => role === 'art' || role === 'art_text';

type Row = { n: number; file: string; y0: number; y1: number; label: string };
const out: Row[] = [];
let n = 0;
for (const ch of listChapters()) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    continue;
  }
  const s = await loadStrip(ch.file);
  const W = s.width;
  const px = (x: number, y: number) => {
    const i = (y * W + x) * 3;
    return [s.rgb[i], s.rgb[i + 1], s.rgb[i + 2]];
  };
  const colMeans = (y0: number, y1: number) => {
    const cols: number[][] = [];
    for (let x = 0; x + 16 <= W; x += 16) {
      const acc = [0, 0, 0];
      let k = 0;
      for (let y = y0; y < y1; y++) for (let dx = 0; dx < 16; dx += 2) {
        const p = px(x + dx, y);
        acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]; k++;
      }
      cols.push(acc.map((v) => v / k));
    }
    return cols;
  };
  const diff = (a: number[], b: number[]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  for (let i = 0; i + 1 < m.panels.length; i++) {
    const a = m.panels[i];
    const b = m.panels[i + 1];
    if (a.bottom !== 'gutter' || !isArt(a.role) || !isArt(b.role)) continue;
    const g0 = a.contentY1;
    const g1 = b.contentY0;
    if (g1 - g0 > maxHeight * W || g1 <= g0) continue;
    n++;
    const band = colMeans(g0, g1).reduce((acc, c) => acc.map((v, k) => v + c[k] / (W / 16)), [0, 0, 0]);
    const gray = 0.299 * band[0] + 0.587 * band[1] + 0.114 * band[2];
    const chroma = Math.max(...band) - Math.min(...band);
    const neutral = chroma <= 12 && (gray >= 232 || gray <= 24);
    const up = colMeans(Math.max(0, g0 - 14), g0 - 2);
    const dn = colMeans(g1 + 2, Math.min(s.height, g1 + 14));
    const spread = (up.filter((c) => diff(c, band) < 24).length + dn.filter((c) => diff(c, band) < 24).length) / (up.length + dn.length);
    const match = up.filter((c, k) => diff(c, dn[k]) < 30).length / up.length;
    const reach = m.detections.filter((d) => (d.kind === 'head' || d.kind === 'person') && d.y0 < g1 + 0.03 * W && d.y1 > g0 - 0.03 * W).length;
    const label = `${n}. ${ch.id.slice(0, 13)} #${a.index}/#${b.index} ${g1 - g0}px rgb ${band.map(Math.round).join(',')} ${neutral ? 'NEUTRAL' : 'colour'} spread ${spread.toFixed(2)} match ${match.toFixed(2)} subj ${reach}`;
    console.log(label);
    out.push({ n, file: ch.file, y0: g0, y1: g1, label });
  }
}

if (sheet) {
  const tiles = out.filter((r) => !pick || pick.includes(r.n));
  const tw = 300, th = 420, cols = 5;
  const comp: sharp.OverlayOptions[] = [];
  const strips = new Map<string, Awaited<ReturnType<typeof loadStrip>>>();
  for (const [i, t] of tiles.entries()) {
    let s = strips.get(t.file);
    if (!s) strips.set(t.file, (s = await loadStrip(t.file)));
    const mid = Math.round((t.y0 + t.y1) / 2);
    const y0 = Math.max(0, mid - 450);
    const h = Math.min(900, s.height - y0);
    const raw = Buffer.from(s.rgb.buffer, s.rgb.byteOffset + y0 * s.width * 3, h * s.width * 3);
    const mark = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${h}"><rect x="2" y="${t.y0 - y0 - 3}" width="${s.width - 4}" height="${Math.max(6, t.y1 - t.y0 + 6)}" fill="none" stroke="#ff2a2a" stroke-width="5"/></svg>`);
    const img = await sharp(raw, { raw: { width: s.width, height: h, channels: 3 } }).composite([{ input: mark, left: 0, top: 0 }]).png().toBuffer();
    const small = await sharp(img).resize(tw, th - 28, { fit: 'contain', background: '#111' }).toBuffer();
    const esc = t.label.replace(/[&<>]/g, '');
    const lab = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="28"><rect width="100%" height="100%" fill="#222"/><text x="3" y="11" font-size="10" font-family="Arial" fill="#fff">${esc.slice(0, 58)}</text><text x="3" y="24" font-size="10" font-family="Arial" fill="#9cf">${esc.slice(58, 130)}</text></svg>`);
    const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
    comp.push({ input: lab, left: x, top: y }, { input: small, left: x, top: y + 28 });
  }
  await sharp({ create: { width: cols * tw, height: Math.ceil(tiles.length / cols) * th, channels: 3, background: '#000' } }).composite(comp).jpeg({ quality: 84 }).toFile(sheet);
  console.log(`sheet: ${tiles.length} -> ${sheet}`);
}
