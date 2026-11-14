/**
 * Credits and promo check per chapter: the first 2 and last 3 strip pages (plus pages dropped for
 * their width), what the reader read on them, and whether each was taken as a credits page.
 * Usage: npx tsx scripts/promo-check.ts [chapterId|all|folder-substring] [--sheet out.jpg]
 *   --sheet: thumbnails of those pages, green frame = credits page, red = kept as story
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { naturalCompare } from '../src/core/cbz.ts';
import { listChapters, runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

const args = process.argv.slice(2);
const sheetAt = args.indexOf('--sheet');
const sheet = sheetAt >= 0 ? args[sheetAt + 1] : null;
const [which = 'all'] = args.filter((a, i) => !a.startsWith('--') && (sheetAt < 0 || i !== sheetAt + 1));
const chapters = listChapters().filter((c) => which === 'all' || c.id === which || c.file.includes(which));

const tiles: { img: Buffer; label: string; credit: boolean }[] = [];
for (const ch of chapters) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    console.log(`\n== ${ch.name}: not processed`);
    continue;
  }
  const pages = [...m.pages.slice(0, 2), ...m.pages.slice(-3)];
  const unique = [...new Map(pages.map((p) => [p.index, p])).values()];
  console.log(`\n== ${ch.name} (${m.pages.length} pages, W ${m.strip.width}) credit pages ${JSON.stringify(m.creditPages)}`);
  for (const s of m.skippedPages) console.log(`  page ${s.index} DROPPED (${s.reason}, ${s.width}x${s.height})`);
  for (const p of unique) {
    const ls = m.textLines.filter((l) => l.y0 >= p.y0 && l.y1 <= p.y1 + 4 && l.kind !== 'noise');
    const tag = m.creditPages.includes(p.index) ? 'CREDITS' : 'story  ';
    console.log(`  page ${p.index} ${tag} (${p.y1 - p.y0}px): ${ls.map((l) => `[${l.kind[0]}] ${l.read}`).join(' | ').slice(0, 300)}`);
  }
  if (!sheet) continue;
  const archive = unzipSync(new Uint8Array(await readFile(ch.file)), { filter: (f) => /\.(webp|jpe?g|png|avif|gif|bmp)$/i.test(f.name) && !f.name.startsWith('__MACOSX') });
  const names = Object.keys(archive).sort(naturalCompare);
  const want = [...unique.map((p) => p.index), ...m.skippedPages.map((s) => s.index)];
  for (const idx of [...new Set(want)].sort((a, b) => a - b)) {
    const data = archive[names[idx - 1]];
    if (!data) continue;
    const credit = m.creditPages.includes(idx);
    const dropped = m.skippedPages.some((s) => s.index === idx);
    const img = await sharp(data).resize(200, 300, { fit: 'contain', background: '#111' }).png().toBuffer();
    const short = ch.name.replace(/_Chapter.*$/, '');
    tiles.push({ img, label: `${short} p${idx}${dropped ? ' dropped' : credit ? ' CREDITS' : ''}`, credit: credit || dropped });
  }
}

if (sheet && tiles.length) {
  const tw = 210, th = 330, cols = 10;
  const comp: sharp.OverlayOptions[] = [];
  for (const [i, t] of tiles.entries()) {
    const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
    const color = t.credit ? '#22dd55' : '#dd3333';
    const frame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><rect x="2" y="2" width="${tw - 4}" height="${th - 4}" fill="none" stroke="${color}" stroke-width="4"/><rect x="0" y="${th - 26}" width="${tw}" height="26" fill="#222"/><text x="5" y="${th - 9}" font-size="12" font-family="Arial" fill="#fff">${t.label.replace(/[&<>]/g, '')}</text></svg>`);
    comp.push({ input: t.img, left: x + 5, top: y + 4 }, { input: frame, left: x, top: y });
  }
  await sharp({ create: { width: cols * tw, height: Math.ceil(tiles.length / cols) * th, channels: 3, background: '#000' } }).composite(comp).jpeg({ quality: 82 }).toFile(sheet);
  console.log(`\nsheet: ${tiles.length} pages -> ${sheet}`);
}
