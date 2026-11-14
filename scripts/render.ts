/**
 * Debug render: a strip region with the cutter's decisions drawn on top.
 * Usage: npx tsx scripts/render.ts <chapterId> <y0> <y1> <out.jpg> [scale=0.5] [--replan]
 *   --replan: draw the shots from replan.json (scripts/replan.ts) instead of manifest.json
 *   green/orange lines = reader panel bounds (art / text), cyan dashed = video crop,
 *   red = head, dashed green = person, magenta = dialogue zone, yellow = sfx line, blue = frame line.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

const args = process.argv.slice(2);
const useReplan = args.includes('--replan');
const [id, a, b, out, s] = args.filter((x) => x !== '--replan');
const scale = Number(s ?? 0.5);
const dir = runDir(id);
const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
if (useReplan) {
  // Draw the shots from scripts/replan.ts instead of the saved ones.
  const re = JSON.parse(await readFile(path.join(dir, 'replan.json'), 'utf8')) as Pick<Manifest, 'shots' | 'panels'>;
  m.shots = re.shots;
  m.panels = re.panels;
}
const y0 = Math.max(0, Number(a));
const y1 = Math.min(m.strip.height, Number(b));
const W = m.strip.width;

const tiles = [];
for (const c of m.strip.chunks) {
  const t0 = Math.max(y0, c.y0);
  const t1 = Math.min(y1, c.y1);
  if (t0 >= t1) continue;
  const buf = await sharp(path.join(dir, 'strip', c.file))
    .extract({ left: 0, top: t0 - c.y0, width: W, height: t1 - t0 })
    .toBuffer();
  tiles.push({ input: buf, top: t0 - y0, left: 0 });
}

const ov: string[] = [];
const inRange = (r: { y0: number; y1: number }) => r.y1 > y0 && r.y0 < y1;
const rect = (r: { x0: number; y0: number; x1: number; y1: number }, style: string) =>
  ov.push(`<rect x="${r.x0}" y="${r.y0 - y0}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}" fill="none" ${style}/>`);
for (const d of m.detections.filter(inRange)) {
  if (d.kind === 'head') rect(d, 'stroke="#ff2020" stroke-width="5"');
  if (d.kind === 'person') rect(d, 'stroke="#20ff60" stroke-width="4" stroke-dasharray="16,10"');
}
for (const l of m.textLines.filter(inRange)) {
  if (l.kind === 'sfx') rect(l, 'stroke="#ffd000" stroke-width="3"');
  if (l.kind === 'watermark') rect(l, 'stroke="#888" stroke-width="3"');
  if (l.kind === 'noise') rect(l, 'stroke="#888" stroke-width="2" stroke-dasharray="6,6"');
}
for (const d of m.detections.filter(inRange)) {
  if (d.kind === 'face') rect(d, 'stroke="#ff9a3c" stroke-width="4"');
}
for (const t of m.textBlocks.filter((t) => inRange(t.zone))) rect(t.zone, 'stroke="#ff00ff" stroke-width="5"');
for (const f of m.frameLines) {
  if (Math.max(f.yLeft, f.yRight) < y0 || Math.min(f.yLeft, f.yRight) > y1) continue;
  ov.push(`<line x1="0" y1="${f.yLeft - y0}" x2="${W}" y2="${f.yRight - y0}" stroke="#3080ff" stroke-width="6"/>`);
}
for (const s of m.shots.filter(inRange)) {
  const color = s.tier === 'A' ? '#00e5ff' : '#ffe14d';
  rect({ ...s, x0: s.x0 + 6, x1: s.x1 - 6, y0: s.y0 + 6, y1: s.y1 - 6 }, `stroke="${color}" stroke-width="7" stroke-dasharray="24,14"`);
  ov.push(`<circle cx="${s.focusPoint.x}" cy="${s.focusPoint.y - y0}" r="12" fill="${color}"/>`);
  ov.push(`<text x="${s.x1 - 150}" y="${s.y0 - y0 + 44}" font-size="34" font-family="Arial" fill="${color}" stroke="#000" stroke-width="2">${s.id}</text>`);
}
for (const p of m.panels.filter(inRange)) {
  const color = p.role === 'text' ? '#ff9900' : p.role === 'decor' || p.role === 'credits' ? '#999' : '#00ff66';
  for (const y of [p.y0, p.y1]) ov.push(`<line x1="0" y1="${y - y0}" x2="${W}" y2="${y - y0}" stroke="${color}" stroke-width="8"/>`);
  const label = `#${p.index} ${p.role} ${p.top}/${p.bottom}${p.shotIds.length ? ' ' + p.shotIds.join(',') : p.videoSkip ? ' no shot: ' + p.videoSkip : ''}`;
  ov.push(
    `<text x="12" y="${Math.max(40, p.y0 - y0 + 44)}" font-size="34" font-family="Arial" fill="#fff" stroke="#000" stroke-width="2">${label}</text>`,
  );
}
const H = y1 - y0;
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${ov.join('')}</svg>`);
await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } })
  .composite([...tiles, { input: svg, top: 0, left: 0 }])
  .jpeg({ quality: 80 })
  .toBuffer()
  .then((buf) => sharp(buf).resize(Math.round(W * scale)).jpeg({ quality: 80 }).toFile(out));
console.log(`wrote ${out}`);
