/**
 * Contact sheet of video shots with their tags.
 * Usage: npx tsx scripts/shot-sheet.ts <chapterId|all> <out.jpg> <selector>
 *   selector: "1-30" (shot index range) · "B" or "A" (tier) · "#10,#11" (panel indexes) · "s003,s007"
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { paths, runDir } from '../src/core/library.ts';
import type { Manifest, Shot } from '../src/core/types.ts';

const [id, out, selector = '1-30'] = process.argv.slice(2);
const ids = id === 'all' ? await readdir(paths.runs) : [id];
const picked: { dir: string; s: Shot; chapter: string }[] = [];
for (const cid of ids) {
  const dir = runDir(cid);
  const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (!m.shots) continue;
  const chapter = m.source.file.replace(/^(Asura Scans|Elf Toon)_Chapter (\d+).*$/, (_, g, n) => `${g === 'Elf Toon' ? 'E' : 'A'}${n}`);
  for (const s of m.shots) {
    let ok = false;
    if (/^\d+-\d+$/.test(selector)) {
      const [a, b] = selector.split('-').map(Number);
      ok = s.index >= a && s.index <= b;
    } else if (selector === 'A' || selector === 'B') ok = s.tier === selector;
    else if (selector.startsWith('#')) ok = selector.split(',').map((x) => Number(x.slice(1))).includes(s.panelIndex);
    else ok = selector.split(',').includes(s.id);
    if (ok) picked.push({ dir, s, chapter });
  }
}
const tw = 260;
const th = 330;
const cols = 5;
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const tiles: sharp.OverlayOptions[] = [];
for (const [i, { dir, s, chapter }] of picked.entries()) {
  const img = await sharp(path.join(dir, 'video', s.file)).resize(tw, th - 40, { fit: 'contain', background: '#111' }).toBuffer();
  const l1 = `${ids.length > 1 ? chapter + ' ' : ''}${s.id} #${s.panelIndex} ${s.tier} ${s.focus} ${s.framing}`;
  const l2 = `${s.motion} ${s.screens} · balloon ${Math.round(s.dialogueShare * 100)}% · ${s.score}`;
  const label = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="40"><rect width="100%" height="100%" fill="#222"/>` +
      `<text x="5" y="16" font-size="14" font-family="Arial" fill="#fff">${esc(l1)}</text>` +
      `<text x="5" y="34" font-size="13" font-family="Arial" fill="#9cf">${esc(l2)}</text></svg>`,
  );
  const x = (i % cols) * tw;
  const y = Math.floor(i / cols) * th;
  tiles.push({ input: label, left: x, top: y }, { input: img, left: x, top: y + 40 });
}
const rows = Math.max(1, Math.ceil(picked.length / cols));
await sharp({ create: { width: cols * tw, height: rows * th, channels: 3, background: '#000' } })
  .composite(tiles)
  .jpeg({ quality: 80 })
  .toFile(out);
console.log(`${picked.length} shots -> ${out}`);
