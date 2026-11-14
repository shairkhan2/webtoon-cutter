/**
 * Shot size report over processed chapters: box shapes, how much of each panel's height the
 * shots keep, and panels cut into several shots.
 * Usage: npx tsx scripts/shot-sizes.ts [chapterId ...]   (default: every run)
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { paths, runDir } from '../src/core/library.ts';
import type { Manifest } from '../src/core/types.ts';

const args = process.argv.slice(2);
const ids = args.length ? args : await readdir(paths.runs);
const screensOf = (w: number, h: number) => h / ((9 / 16) * w);
/** A 9:16 box (the reference video's tallest single panel) measured in 16:9 screens: 256/81. */
const TALL_BOX_SCREENS = screensOf(9, 16);
const hist = (vals: number[], edges: number[], fmt = (v: number) => v.toFixed(2)) => {
  const counts = new Array(edges.length + 1).fill(0);
  for (const v of vals) {
    let i = 0;
    while (i < edges.length && v >= edges[i]) i++;
    counts[i]++;
  }
  return counts
    .map((n, i) => `${i === 0 ? `<${fmt(edges[0])}` : i === edges.length ? `>=${fmt(edges[i - 1])}` : `${fmt(edges[i - 1])}-${fmt(edges[i])}`}: ${n}`)
    .join('  ');
};
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

const screens: number[] = [];
const aspects: number[] = [];
const keptShare: number[] = [];
const panelScreens: number[] = [];
let shots = 0;
let fullWidth = 0;
let multi = 0;
let multiFitsOneBox = 0;
const multiRows: string[] = [];
for (const id of ids) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    continue;
  }
  const W = m.strip.width;
  const sizes = new Map<string, number>();
  for (const s of m.shots) {
    const w = s.x1 - s.x0;
    const h = s.y1 - s.y0;
    shots++;
    if (w >= W - 1) fullWidth++;
    screens.push(screensOf(w, h));
    aspects.push(w / h);
    const key = `${w}x${Math.round(h / 50) * 50}`;
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  for (const p of m.panels) {
    if (!p.shotIds.length) continue;
    const ph = p.contentY1 - p.contentY0;
    panelScreens.push(screensOf(W, ph));
    const own = p.shotIds.map((sid) => m.shots.find((s) => s.id === sid)!);
    const kept = own.reduce((a, s) => a + (s.y1 - s.y0), 0);
    keptShare.push(kept / ph);
    if (own.length > 1) {
      multi++;
      const y0 = Math.min(...own.map((s) => s.y0));
      const y1 = Math.max(...own.map((s) => s.y1));
      const unionScreens = screensOf(W, y1 - y0);
      if (unionScreens <= TALL_BOX_SCREENS) multiFitsOneBox++;
      multiRows.push(
        `  ${id.slice(0, 22)} #${p.index} panel ${screensOf(W, ph).toFixed(2)}scr -> ${own
          .map((s) => `${s.id} ${s.framing} ${s.faces}f ${(s.y1 - s.y0)}px`)
          .join(' | ')} | union ${unionScreens.toFixed(2)}scr`,
      );
    }
  }
  const top = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  console.log(`${id.slice(0, 40)} W=${W} shots=${m.shots.length} common boxes: ${top.map(([k, n]) => `${k} (${n})`).join(', ')}`);
}
console.log(`\nshots ${shots}, full width ${fullWidth}`);
console.log(`shot height in screens (h / 0.5625w), median ${median(screens).toFixed(2)}:`);
console.log('  ' + hist(screens, [1, 1.25, 1.5, 1.75, 2, 2.5, 3.2]));
console.log(`box aspect w/h, median ${median(aspects).toFixed(2)}:`);
console.log('  ' + hist(aspects, [0.5625, 0.7, 0.8, 0.9, 1.0, 1.15, 1.3, 1.78]));
console.log(`panel height in screens (panels with shots), median ${median(panelScreens).toFixed(2)}:`);
console.log('  ' + hist(panelScreens, [1, 1.5, 2, 2.5, 3.2, 4, 6]));
console.log(`share of the panel height kept by its shots, median ${median(keptShare).toFixed(2)}:`);
console.log('  ' + hist(keptShare, [0.3, 0.5, 0.7, 0.9]));
console.log(`\npanels with 2+ shots: ${multi}; their shots' union fits one 9:16 box (<= 3.16 screens): ${multiFitsOneBox}`);
console.log(multiRows.join('\n'));
