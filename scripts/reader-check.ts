/**
 * Read every OCR line of a processed chapter with the English and Korean recognisers.
 * Usage: npx tsx scripts/reader-check.ts <file.cbz> <chapterId> <out.json>
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStrip } from '../src/core/cbz.ts';
import { createReader } from '../src/core/detect/reader.ts';
import { paths, runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

const [file, id, out] = process.argv.slice(2);
const m = JSON.parse(await readFile(path.join(runDir(id), 'manifest.json'), 'utf8')) as Manifest;
const strip = await loadStrip(file);
const reader = await createReader(paths.models);
const t0 = performance.now();
const rows = [];
for (const [i, l] of m.textLines.entries()) {
  const r = await reader.read(strip, l);
  rows.push({ i, kind: l.kind, box: [l.x0, l.y0, l.x1, l.y1], en: r.en.text, enConf: +r.en.conf.toFixed(3), ko: r.ko.text, koConf: +r.ko.conf.toFixed(3) });
}
const ms = performance.now() - t0;
await reader.release();
await writeFile(out, JSON.stringify(rows, null, 1));
console.log(`${rows.length} lines read in ${(ms / 1000).toFixed(1)}s (${(ms / rows.length).toFixed(1)} ms/line) -> ${out}`);
