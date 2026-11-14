/**
 * Before/after sheet in the reference video's layout: each shot is a box fitted to a 16:9 frame
 * over a blurred copy of itself. One row per panel: current shots (manifest.json) on the left,
 * re-planned shots (replan.json from scripts/replan.ts) on the right.
 * Option --variant=<name>: read replan-<name>.json (scripts/variants.ts) instead of replan.json.
 * Option --base=<name>: the left "OLD" column reads its shots from replan-<name>.json instead of manifest.json
 *   (panels still come from the manifest); use it to compare two re-plans made with the same code.
 * Usage: npx tsx scripts/frame-sheet.ts <chapterId|all> <out.jpg> <#3,#7 | changed:N | multi>
 *   changed:N  N panels whose shots changed most, spread over the chapters
 *   multi      panels that had 2+ shots before
 *   sample:N[:offset]  N evenly spaced panels
 *   balloon:N  N panels whose re-planned shots carry the most balloon
 *   over:N     N panels whose re-planned shots are taller than 9:16
 *   gained:N[:offset]  panels that had no shot and have one after re-planning
 *   lost:N[:offset]    panels that had a shot and have none after re-planning
 *   from=list.json[=N[=offset]]  panels listed as [{ "id": chapterId, "panel": index }]
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { paths, runDir } from '../src/core/library.ts';
import type { Manifest, Panel, Rect, Shot } from '../src/core/types.ts';

// "gained=12=0" is accepted for "gained:12:0" (some shells and tools read "x:12" as host:port).
const variantArg = process.argv.find((a) => a.startsWith('--variant='));
const variant = variantArg ? variantArg.slice(10) : null; // reads replan-<variant>.json instead of replan.json
const baseArg = process.argv.find((a) => a.startsWith('--base='));
const base = baseArg ? baseArg.slice(7) : null; // reads the OLD shots from replan-<base>.json instead of manifest.json
const [which, out, rawSelector = 'changed:12'] = process.argv.slice(2).filter((a) => !a.startsWith('--variant=') && !a.startsWith('--base='));
const selector = rawSelector.replace(/=/g, ':');
const ids = which === 'all' ? await readdir(paths.runs) : [which];
const FW = 384;
const FH = 216;
const LABEL = 34;
const PER_SIDE = 2;

interface Row {
  id: string;
  m: Manifest;
  panel: Panel;
  before: Shot[];
  after: Shot[];
  change: number;
}

const overlap = (a: Shot[], b: Shot[]) => {
  // Intersection over union of the rows covered, a cheap "how different" measure.
  const cover = (s: Shot[]) => s.map((x) => [x.y0, x.y1] as const);
  const len = (iv: (readonly [number, number])[]) => iv.reduce((t, [a0, a1]) => t + a1 - a0, 0);
  let inter = 0;
  for (const [a0, a1] of cover(a)) for (const [b0, b1] of cover(b)) inter += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const uni = len(cover(a)) + len(cover(b)) - inter;
  return uni > 0 ? inter / uni : 1;
};

const rows: Row[] = [];
for (const id of ids) {
  let m: Manifest;
  let re: { shots: Shot[]; panels: Panel[] };
  let old: Shot[] | null = null;
  try {
    m = JSON.parse(await readFile(path.join(runDir(id), 'manifest.json'), 'utf8')) as Manifest;
    re = JSON.parse(await readFile(path.join(runDir(id), variant ? `replan-${variant}.json` : 'replan.json'), 'utf8'));
    if (base) old = (JSON.parse(await readFile(path.join(runDir(id), `replan-${base}.json`), 'utf8')) as { shots: Shot[] }).shots;
  } catch {
    continue;
  }
  for (const p of m.panels) {
    const before = (old ?? m.shots).filter((s) => s.panelId === p.id);
    const after = re.shots.filter((s) => s.panelId === p.id);
    if (!before.length && !after.length) continue;
    rows.push({ id, m, panel: p, before, after, change: 1 - overlap(before, after) });
  }
}

let picked: Row[];
if (selector.startsWith('#')) {
  const want = selector.split(',').map((x) => Number(x.slice(1)));
  picked = rows.filter((r) => want.includes(r.panel.index));
} else if (selector === 'multi') {
  picked = rows.filter((r) => r.before.length > 1);
} else if (rawSelector.startsWith('from=')) {
  // A JSON list of { id, panel } written by another script, in its order: "from=list.json[=N[=offset]]".
  const [, file, n = '12', off = '0'] = rawSelector.split('=');
  const want = (JSON.parse(await readFile(file, 'utf8')) as { id: string; panel: number }[]).slice(Number(off), Number(off) + Number(n));
  picked = want.map((w) => rows.find((r) => r.id === w.id && r.panel.index === w.panel)).filter((r): r is Row => !!r);
} else if (selector.startsWith('gained:') || selector.startsWith('lost:')) {
  // Panels that had no shot and now have one (gained), or the reverse (lost); offset optional.
  const [kind, n = '12', off = '0'] = selector.split(':');
  const hit = rows.filter((r) => (kind === 'gained' ? !r.before.length && r.after.length : r.before.length && !r.after.length));
  picked = hit.slice(Number(off), Number(off) + Number(n));
} else if (selector.startsWith('balloon:')) {
  // Panels whose re-planned shots carry the most balloon.
  const n = Number(selector.split(':')[1] ?? 10);
  const most = (r: Row) => Math.max(0, ...r.after.map((s) => s.dialogueShare));
  picked = [...rows].sort((a, b) => most(b) - most(a)).slice(0, n);
} else if (selector.startsWith('over:')) {
  // Panels whose re-planned shots are taller than 9:16, spread over the list.
  const n = Number(selector.split(':')[1] ?? 10);
  const over = rows.filter((r) => r.after.some((s) => s.y1 - s.y0 > (16 / 9) * (s.x1 - s.x0) * 1.01));
  const step = Math.max(1, Math.floor(over.length / n));
  picked = over.filter((_, i) => i % step === 0).slice(0, n);
} else if (selector.startsWith('sample:')) {
  // Evenly spaced panels, from an offset: "sample:8" or "sample:8:3".
  const parts = selector.split(':');
  const n = Number(parts[1] ?? 8);
  const off = Number(parts[2] ?? 0);
  const step = Math.max(1, Math.floor(rows.length / n));
  picked = rows.filter((_, i) => (i + off) % step === 0).slice(0, n);
} else {
  const n = Number(selector.split(':')[1] ?? 12);
  // Round-robin over chapters, most changed first.
  const byChapter = new Map<string, Row[]>();
  for (const r of rows.filter((x) => x.change > 0.05).sort((a, b) => b.change - a.change)) {
    byChapter.set(r.id, [...(byChapter.get(r.id) ?? []), r]);
  }
  picked = [];
  for (let k = 0; picked.length < n && k < 50; k++) {
    for (const list of byChapter.values()) if (list[k] && picked.length < n) picked.push(list[k]);
  }
}

const stripCache = new Map<string, Buffer>();
async function crop(id: string, m: Manifest, r: Rect): Promise<Buffer> {
  const parts: sharp.OverlayOptions[] = [];
  for (const c of m.strip.chunks) {
    const t0 = Math.max(r.y0, c.y0);
    const t1 = Math.min(r.y1, c.y1);
    if (t0 >= t1) continue;
    const key = `${id}/${c.file}`;
    let buf = stripCache.get(key);
    if (!buf) {
      buf = await readFile(path.join(runDir(id), 'strip', c.file));
      stripCache.set(key, buf);
    }
    const piece = await sharp(buf).extract({ left: r.x0, top: t0 - c.y0, width: r.x1 - r.x0, height: t1 - t0 }).toBuffer();
    parts.push({ input: piece, left: 0, top: t0 - r.y0 });
  }
  return sharp({ create: { width: r.x1 - r.x0, height: r.y1 - r.y0, channels: 3, background: '#000' } })
    .composite(parts)
    .png()
    .toBuffer();
}

/** The reference layout: box as tall as the frame (minus a small margin), blurred copy behind. */
async function frame(id: string, m: Manifest, s: Shot): Promise<Buffer> {
  const box = await crop(id, m, s);
  const bg = await sharp(box).resize(FW, FH, { fit: 'cover' }).blur(14).modulate({ brightness: 0.7 }).toBuffer();
  const fg = await sharp(box).resize(Math.round(FW * 0.96), Math.round(FH * 0.96), { fit: 'inside' }).toBuffer();
  const meta = await sharp(fg).metadata();
  return sharp(bg)
    .composite([{ input: fg, left: Math.round((FW - meta.width!) / 2), top: Math.round((FH - meta.height!) / 2) }])
    .toBuffer();
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const label = (text: string, sub: string, color: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${FW}" height="${LABEL}"><rect width="100%" height="100%" fill="#1b1b1b"/>` +
      `<text x="5" y="14" font-size="13" font-family="Arial" fill="${color}">${esc(text)}</text>` +
      `<text x="5" y="29" font-size="12" font-family="Arial" fill="#9cf">${esc(sub)}</text></svg>`,
  );
const tiles: sharp.OverlayOptions[] = [];
const cols = 2 * PER_SIDE;
const gap = 12;
const rowH = FH + LABEL + 6;
for (const [i, row] of picked.entries()) {
  // Short chapter tag: "A2", "E1", or the source's first word plus chapter and id hash.
  const chapter = row.m.source.file.replace(/^(Asura Scans|Elf Toon)_Chapter (\d+).*$/, (_, g, n) => `${g === 'Elf Toon' ? 'E' : 'A'}${n}`).replace(
    /^([^_ ]+)[^_]*_Chapter (\d+)_?([0-9a-f]{0,6}).*$/i,
    (_, g, n, h) => `${g.slice(0, 8)}${n}${h ? `-${h.slice(0, 3)}` : ''}`,
  );
  for (const [side, list] of [
    [0, row.before],
    [1, row.after],
  ] as const) {
    for (let k = 0; k < PER_SIDE; k++) {
      const s = list[k];
      const x = side * (PER_SIDE * FW + gap) + k * FW;
      const y = i * rowH;
      if (!s) continue;
      const w = s.x1 - s.x0;
      const h = s.y1 - s.y0;
      const head = `${side ? 'NEW' : 'OLD'} ${chapter} #${row.panel.index} ${s.id}${list.length > PER_SIDE && k === PER_SIDE - 1 ? ` (+${list.length - PER_SIDE})` : ''}`;
      const sub = `${w}x${h} · box ${(w / h).toFixed(2)} · ${s.screens} scr · ${s.framing} · ${s.faces}f · ${s.score}`;
      tiles.push({ input: label(head, sub, side ? '#8f8' : '#fc8'), left: x, top: y }, { input: await frame(row.id, row.m, s), left: x, top: y + LABEL });
    }
  }
}
const width = cols * FW + gap;
await sharp({ create: { width, height: Math.max(1, picked.length) * rowH, channels: 3, background: '#000' } })
  .composite(tiles)
  .jpeg({ quality: 82 })
  .toFile(out);
console.log(`${picked.length} panels -> ${out}`);
