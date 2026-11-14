/**
 * Compare the reading-based lettering verdict with the old geometric kind.
 * Usage: npx tsx scripts/lettering-flips.ts <readings.json> <stripWidth>
 */
import { readFile } from 'node:fs/promises';
import { judgeLettering } from '../src/core/lettering.ts';

const [file, w] = process.argv.slice(2);
const rows = JSON.parse(await readFile(file, 'utf8')) as {
  kind: string;
  box: number[];
  en: string;
  enConf: number;
  ko: string;
  koConf: number;
}[];
const counts = new Map<string, number>();
const flips: string[] = [];
for (const r of rows) {
  const v = judgeLettering({ en: { text: r.en, conf: r.enConf }, ko: { text: r.ko, conf: r.koConf } }, r.box[3] - r.box[1], Number(w));
  const key = `${r.kind.padEnd(9)} -> ${v.kind}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  if (r.kind !== v.kind) flips.push(`${key}  y${r.box[1]} h${r.box[3] - r.box[1]}  ${v.why}`);
}
console.log([...counts.entries()].sort().map(([k, n]) => `${k}: ${n}`).join('\n'));
console.log('\nflips:\n' + flips.join('\n'));
