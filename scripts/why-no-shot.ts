/**
 * Why an art panel got no video shot: tries every box on a 16 px grid (full width, and side crops
 * that step around each balloon), runs each through the shot rules, and tallies what rejected
 * them. Then shows the biggest boxes stopped by each rule, with their balloon share measured two
 * more ways for comparison: the balloon's bounding box and its white pixels. (The rule's own note
 * uses the balloon fill measured in shots.ts.)
 * Usage: npx tsx scripts/why-no-shot.ts <chapterId|name> <panelIndex>...
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStrip } from '../src/core/cbz.ts';
import { config } from '../src/core/config.ts';
import { analyzeDetail } from '../src/core/interest.ts';
import { listChapters, runDir } from '../src/core/library.ts';
import { explainBoxes, type ShotInput } from '../src/core/shots.ts';
import type { Manifest, Rect } from '../src/core/types.ts';

const [which, ...idx] = process.argv.slice(2);
const ch = listChapters().find((c) => c.id === which || c.name.includes(which))!;
const m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
const strip = await loadStrip(ch.file);
const W = m.strip.width;
const input: ShotInput = {
  width: W,
  height: m.strip.height,
  detail: analyzeDetail(strip.gray, W, strip.height),
  faces: m.detections.filter((d) => d.kind === 'face'),
  heads: m.detections.filter((d) => d.kind === 'head'),
  persons: m.detections.filter((d) => d.kind === 'person'),
  blocks: m.textBlocks,
  lines: m.textLines,
  frameLines: m.frameLines,
  pages: m.pages,
};
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const clip = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
/** Balloon pixels on screen: white-ish pixels inside the balloon zones that fall in the box. */
function balloonPixels(r: Rect): number {
  let n = 0;
  for (const b of m.textBlocks) {
    const z = clip(b.zone, r);
    if (area(z) <= 0) continue;
    for (let y = z.y0; y < z.y1; y++) for (let x = z.x0; x < z.x1; x++) if (strip.gray[y * W + x] >= 215) n++;
  }
  return n;
}

for (const n of idx.map(Number)) {
  const p = m.panels.find((q) => q.index === n)!;
  const P0 = p.contentY0;
  const P1 = p.contentY1;
  const zones = m.textBlocks.map((b) => b.zone).filter((z) => z.y1 > P0 && z.y0 < P1);
  const pad = config.shots.padSide * W;
  const minW = config.shots.minWidth * W;
  const xr: [number, number][] = [[0, W]];
  for (const z of zones) {
    if (z.x0 - pad >= minW) xr.push([0, Math.floor(z.x0 - pad)]);
    if (W - (z.x1 + pad) >= minW) xr.push([Math.ceil(z.x1 + pad), W]);
  }
  const boxes: Rect[] = [];
  for (const [x0, x1] of xr) {
    const frame = (9 / 16) * (x1 - x0);
    for (let y0 = P0; y0 < P1; y0 += 16) {
      for (let y1 = Math.min(P1, y0 + Math.round(0.3 * frame)); y1 <= P1; y1 = y1 === P1 ? P1 + 1 : Math.min(P1, y1 + 16)) {
        if (y1 - y0 > 3.4 * frame) break;
        boxes.push({ x0, y0, x1, y1 });
      }
    }
  }
  const res = explainBoxes(p, input, boxes);
  const tally = new Map<string, Rect[]>();
  let ok = 0;
  res.forEach((r, i) => {
    if (!('reject' in r)) return void ok++;
    const key = `${r.reject}${r.note ? ` (${r.note.replace(/[\d.]+/g, 'n')})` : ''}`;
    tally.set(key, [...(tally.get(key) ?? []), boxes[i]]);
  });
  console.log(`\n#${n} ${p.role} ${P0}-${P1} (${P1 - P0}px, ${((P1 - P0) / ((9 / 16) * W)).toFixed(2)} screens), x ranges ${xr.map((r) => r.join('-')).join(', ')}: ${boxes.length} boxes, ${ok} pass`);
  for (const [k, list] of [...tally.entries()].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(list.length).padStart(5)}  ${k}`);
  // The biggest boxes stopped by each dialogue rule, with on-screen balloon share.
  for (const [k, list] of tally) {
    if (!k.startsWith('too_much_dialogue') && !k.startsWith('too_small')) continue;
    const top = [...list].sort((a, b) => area(b) - area(a)).slice(0, 3);
    for (const r of top) {
      const e = res[boxes.indexOf(r)] as { reject: string; note?: string };
      const zoneShare = zones.reduce((s, z) => s + area(clip(z, r)), 0) / area(r);
      console.log(`    ${k.split(' ')[0]}: x${r.x0}-${r.x1} y${r.y0}-${r.y1} (${r.x1 - r.x0}x${r.y1 - r.y0}) ${e.note ?? ''} | balloon box ${(zoneShare * 100).toFixed(0)}%, white pixels ${((balloonPixels(r) / area(r)) * 100).toFixed(0)}%`);
    }
  }
}
