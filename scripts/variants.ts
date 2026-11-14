/**
 * Round 2 dry run of the shot-rule switches on saved detections, no models.
 * Variants: base, r1g (bodyCutCost 1 with the group guard), r2ac (shortOpenMinConf 0.8, demoted lines
 * keep their former zone), r3f (signsAreArt as a fallback), pick (all three).
 * Per chapter it writes data/runs/<id>/replan-<variant>.json ({ shots, panels }) for these names only
 * (round 1 outputs replan-r1, r1b, r2a ... are left alone) and writes the report to
 * <outDir>/variants-report-r2.json.
 * Usage: npx tsx scripts/variants.ts [chapterId|all] [outDir]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadStrip } from '../src/core/cbz.ts';
import { config } from '../src/core/config.ts';
import { analyzeDetail } from '../src/core/interest.ts';
import { listChapters, runDir } from '../src/core/library.ts';
import { planShots } from '../src/core/shots.ts';
import { demoteShortOpenText } from '../src/core/text.ts';
import type { Manifest, Panel, Shot, TextLine } from '../src/core/types.ts';

const [which = 'all', outDir = path.join(os.tmpdir(), 'wsc')] = process.argv.slice(2);
type Over = Partial<Record<'bodyCutCost' | 'sideArtKept' | 'shortOpenMinConf' | 'dropObjectHeads' | 'signsAreArt', number | boolean>>;
const R1: Over = { bodyCutCost: 1 };
const R2: Over = { shortOpenMinConf: 0.8 };
const R3: Over = { signsAreArt: true };
const VARIANTS: Record<string, Over> = { base: {}, r1g: R1, r2ac: R2, r3f: R3, pick: { ...R1, ...R2, ...R3 } };
const cfg = config as unknown as { shots: Record<string, unknown>; text: Record<string, unknown> };
const KEYS: [keyof Over, 'shots' | 'text', number | boolean][] = [
  ['bodyCutCost', 'shots', 0],
  ['sideArtKept', 'shots', false],
  ['dropObjectHeads', 'shots', false],
  ['signsAreArt', 'shots', false],
  ['shortOpenMinConf', 'text', 0],
];
const isArt = (p: Panel) => p.role === 'art' || p.role === 'art_text';
const boxKey = (s: Shot) => `${s.x0},${s.y0},${s.x1},${s.y1}`;
const keyOf = (shots: Shot[]) => shots.map(boxKey).sort().join('|');
const desc = (shots: Shot[]) => shots.map((s) => ({ box: [s.x0, s.y0, s.x1, s.y1], score: s.score, focus: s.focus }));

const stats: Record<string, { shots: number; artWithShot: number; gained: number; lost: number; changed: number; noShot: Record<string, number> }> = {};
for (const v of Object.keys(VARIANTS)) stats[v] = { shots: 0, artWithShot: 0, gained: 0, lost: 0, changed: 0, noShot: {} };
type Entry = { id: string; panel: number; before: unknown; after: unknown; demotedLines?: unknown };
const lists: Record<string, { changed: Entry[]; gained: Entry[]; lost: Entry[] }> = {};
for (const v of Object.keys(VARIANTS)) if (v !== 'base') lists[v] = { changed: [], gained: [], lost: [] };
const baseDiff: string[] = [];
const r1Revert: Entry[] = [];
const r1Remain: Entry[] = [];
const r1Other: Entry[] = [];
const r3Remain: Entry[] = [];
const r3Reverted: Entry[] = [];
const r3Other: Entry[] = [];
const interactions: Entry[] = [];
const missingRound1: string[] = [];

const chapters = listChapters().filter((c) => which === 'all' || c.id === which);
for (const ch of chapters) {
  let m: Manifest;
  try {
    m = JSON.parse(await readFile(path.join(runDir(ch.id), 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    continue;
  }
  const strip = await loadStrip(ch.file);
  const detail = analyzeDetail(strip.gray, strip.width, strip.height);
  const faces = m.detections.filter((d) => d.kind === 'face');
  const heads = m.detections.filter((d) => d.kind === 'head');
  const persons = m.detections.filter((d) => d.kind === 'person');
  const res: Record<string, { shots: Shot[]; panels: Panel[]; lines: TextLine[] }> = {};
  for (const [name, over] of Object.entries(VARIANTS)) {
    const saved = KEYS.map(([k, sec]) => [k, sec, cfg[sec][k]] as const);
    try {
      for (const [k, sec, def] of KEYS) cfg[sec][k] = k in over ? over[k] : def;
      const panels: Panel[] = m.panels.map((p) => ({ ...p, shotIds: [], videoSkip: undefined }));
      const t = demoteShortOpenText(m.textLines, m.textBlocks);
      const shots = planShots(panels, {
        width: m.strip.width,
        height: m.strip.height,
        detail,
        faces,
        heads,
        persons,
        blocks: t.blocks,
        lines: t.lines,
        frameLines: m.frameLines,
        pages: m.pages,
      });
      await writeFile(path.join(runDir(ch.id), `replan-${name}.json`), JSON.stringify({ shots, panels }, null, 1));
      res[name] = { shots, panels, lines: t.lines };
      const s = stats[name];
      s.shots += shots.length;
      s.artWithShot += panels.filter((p) => isArt(p) && p.shotIds.length).length;
      for (const p of panels) if (isArt(p) && !p.shotIds.length) s.noShot[p.videoSkip ?? '-'] = (s.noShot[p.videoSkip ?? '-'] ?? 0) + 1;
    } finally {
      for (const [k, sec, v] of saved) cfg[sec][k] = v;
    }
  }
  const base = res.base;
  const savedMap = new Set(m.shots.map(boxKey));
  const mine = new Set(base.shots.map(boxKey));
  for (const x of base.shots) if (!savedMap.has(boxKey(x))) baseDiff.push(`${ch.id} #${x.panelIndex} new box ${boxKey(x)}`);
  for (const x of m.shots) if (!mine.has(boxKey(x))) baseDiff.push(`${ch.id} #${x.panelIndex} missing box ${boxKey(x)}`);
  const by = (shots: Shot[], i: number) => shots.filter((s) => s.panelIndex === i);
  const allIdx = m.panels.map((p) => p.index);
  for (const [name, r] of Object.entries(res)) {
    if (name === 'base') continue;
    for (const i of allIdx) {
      const b = by(base.shots, i);
      const n = by(r.shots, i);
      if (keyOf(b) === keyOf(n)) continue;
      const e: Entry = { id: ch.id, panel: i, before: desc(b), after: desc(n) };
      if (name === 'r2ac' || name === 'pick') {
        const p = m.panels.find((q) => q.index === i)!;
        e.demotedLines = r.lines
          .filter((l, k) => l !== m.textLines[k] && (l.y0 + l.y1) / 2 >= p.contentY0 && (l.y0 + l.y1) / 2 < p.contentY1)
          .map((l) => ({ read: l.read, conf: l.readConf, box: [l.x0, l.y0, l.x1, l.y1], formerZone: l.formerZone }));
      }
      const kind = !b.length ? 'gained' : !n.length ? 'lost' : 'changed';
      lists[name][kind].push(e);
    }
  }
  // Comparisons with round 1 outputs.
  let r1: { shots: Shot[] } | null = null;
  let r3: { shots: Shot[] } | null = null;
  try {
    r1 = JSON.parse(await readFile(path.join(runDir(ch.id), 'replan-r1.json'), 'utf8'));
    r3 = JSON.parse(await readFile(path.join(runDir(ch.id), 'replan-r3.json'), 'utf8'));
  } catch {
    missingRound1.push(ch.id);
  }
  for (const i of allIdx) {
    const b = keyOf(by(base.shots, i));
    if (r1) {
      const o = keyOf(by(r1.shots, i));
      if (o !== b) {
        const n = keyOf(by(res.r1g.shots, i));
        const e: Entry = { id: ch.id, panel: i, before: desc(by(base.shots, i)), after: desc(by(res.r1g.shots, i)) };
        (n === b ? r1Revert : n === o ? r1Remain : r1Other).push(e);
      }
    }
    if (r3) {
      const o = keyOf(by(r3.shots, i));
      if (o !== b) {
        const n = keyOf(by(res.r3f.shots, i));
        const e: Entry = { id: ch.id, panel: i, before: desc(by(base.shots, i)), after: desc(by(res.r3f.shots, i)) };
        (n === b ? r3Reverted : n === o ? r3Remain : r3Other).push(e);
      }
    }
    const pk = keyOf(by(res.pick.shots, i));
    if (pk !== keyOf(by(res.r1g.shots, i)) && pk !== keyOf(by(res.r2ac.shots, i)) && pk !== keyOf(by(res.r3f.shots, i))) {
      interactions.push({
        id: ch.id,
        panel: i,
        before: desc(by(base.shots, i)),
        after: { pick: desc(by(res.pick.shots, i)), r1g: desc(by(res.r1g.shots, i)), r2ac: desc(by(res.r2ac.shots, i)), r3f: desc(by(res.r3f.shots, i)) },
      });
    }
  }
  console.log(`done ${ch.id}`);
}
for (const [v, l] of Object.entries(lists)) {
  stats[v].gained = l.gained.length;
  stats[v].lost = l.lost.length;
  stats[v].changed = l.changed.length;
}
await mkdir(outDir, { recursive: true });
const report = { stats, baseDiff, lists, r1: { revert: r1Revert, remain: r1Remain, other: r1Other }, r3: { remain: r3Remain, reverted: r3Reverted, other: r3Other }, interactions, missingRound1 };
await writeFile(path.join(outDir, 'variants-report-r2.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ stats, baseDiffCount: baseDiff.length, r1: [r1Revert.length, r1Remain.length, r1Other.length], r3: [r3Remain.length, r3Reverted.length, r3Other.length], interactions: interactions.length, missingRound1 }, null, 1));
if (baseDiff.length) console.log(baseDiff.slice(0, 20).join('\n'));
