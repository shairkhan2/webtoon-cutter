import { config } from './config.ts';
import type { LineReading } from './detect/reader.ts';
import { intersect, median, pad, union } from './geometry.ts';
import { isCreditText, judgeLettering } from './lettering.ts';
import type { Detection, PageInfo, Rect, Strip, TextBlock, TextLine } from './types.ts';
import { bannerGlue } from './watermarks.ts';

interface LineStats {
  bg: number;
  bgFrac: number;
  frameBgFrac: number;
  inkFrac: number;
}

/**
 * Background level of an OCR line box and how the box splits into background and ink.
 * The detector box is padded around the glyphs, so the background is read from the box's outer
 * frame: bold lettering can cover more than half of the box interior.
 */
export function lineStats(gray: Uint8Array, width: number, r: Rect): LineStats {
  const mx = Math.max(2, Math.round(0.12 * (r.x1 - r.x0)));
  const my = Math.max(2, Math.round(0.2 * (r.y1 - r.y0)));
  const inFrame = (x: number, y: number) => x < r.x0 + mx || x >= r.x1 - mx || y < r.y0 + my || y >= r.y1 - my;
  const hist = new Int32Array(32);
  for (let y = r.y0; y < r.y1; y++) {
    const row = y * width;
    for (let x = r.x0; x < r.x1; x++) if (inFrame(x, y)) hist[gray[row + x] >> 3]++;
  }
  let best = 0;
  let bestCount = -1;
  for (let b = 0; b < 32; b++) {
    const c = hist[b] + (b > 0 ? hist[b - 1] : 0) + (b < 31 ? hist[b + 1] : 0);
    if (c > bestCount) {
      best = b;
      bestCount = c;
    }
  }
  const bg = best * 8 + 4;
  const tol = config.text.bgTolerance;
  let n = 0;
  let near = 0;
  let ink = 0;
  let frameN = 0;
  let frameNear = 0;
  for (let y = r.y0; y < r.y1; y++) {
    const row = y * width;
    for (let x = r.x0; x < r.x1; x++) {
      const d = Math.abs(gray[row + x] - bg);
      n++;
      if (d <= tol) near++;
      else if (d >= config.text.inkContrast) ink++;
      if (inFrame(x, y)) {
        frameN++;
        if (d <= tol) frameNear++;
      }
    }
  }
  return {
    bg,
    bgFrac: near / Math.max(1, n),
    frameBgFrac: frameNear / Math.max(1, frameN),
    inkFrac: ink / Math.max(1, n),
  };
}

/** Share of the ring around `inner` (width `ring`) whose gray level is within tolerance of bg. */
function ringBackground(gray: Uint8Array, width: number, height: number, inner: Rect, ring: number, bg: number): number {
  const outer = pad(inner, ring, width, height);
  const tol = config.text.bgTolerance;
  let n = 0;
  let near = 0;
  for (let y = outer.y0; y < outer.y1; y += 2) {
    const row = y * width;
    const inside = y >= inner.y0 && y < inner.y1;
    for (let x = outer.x0; x < outer.x1; x += 2) {
      if (inside && x >= inner.x0 && x < inner.x1) continue;
      n++;
      if (Math.abs(gray[row + x] - bg) <= tol) near++;
    }
  }
  return n ? near / n : 0;
}

function pageOf(pages: PageInfo[], y: number): PageInfo | undefined {
  return pages.find((p) => y >= p.y0 && y < p.y1);
}

/** Lines repeated at the same place on several pages (site watermarks, page numbers). */
function findWatermarks(lines: Rect[], pages: PageInfo[], width: number): Set<number> {
  const tol = 0.02 * width;
  const info = lines.map((l) => {
    const cy = (l.y0 + l.y1) / 2;
    const p = pageOf(pages, cy);
    return { page: p?.index ?? -1, top: p ? cy - p.y0 : 0, bottom: p ? p.y1 - cy : 0 };
  });
  const marks = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const seen = new Set<number>([info[i].page]);
    for (let j = 0; j < lines.length; j++) {
      if (i === j || info[j].page === info[i].page) continue;
      const a = lines[i];
      const b = lines[j];
      if (Math.abs(a.x0 - b.x0) > tol || Math.abs(a.x1 - b.x1) > tol) continue;
      if (Math.abs(a.y1 - a.y0 - (b.y1 - b.y0)) > tol) continue;
      if (Math.abs(info[i].top - info[j].top) <= tol || Math.abs(info[i].bottom - info[j].bottom) <= tol) seen.add(info[j].page);
    }
    if (seen.size >= config.text.watermarkPages) marks.add(i);
  }
  return marks;
}

const THUMB_W = 48;
const THUMB_H = 12;

/**
 * Mean-free, unit-norm thumbnail of the box: compares lettering independent of brightness.
 * With `edges`, each cell holds local gradient magnitude, which survives a semi-transparent
 * badge being laid over different art.
 */
export function thumbnail(gray: Uint8Array, width: number, r: Rect, edges = false): Float32Array {
  const out = new Float32Array(THUMB_W * THUMB_H);
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  let mean = 0;
  for (let ty = 0; ty < THUMB_H; ty++) {
    for (let tx = 0; tx < THUMB_W; tx++) {
      const x = r.x0 + Math.floor(((tx + 0.5) * w) / THUMB_W);
      const y = r.y0 + Math.floor(((ty + 0.5) * h) / THUMB_H);
      const i = y * width + x;
      const v = edges
        ? Math.abs(gray[Math.min(i + 1, gray.length - 1)] - gray[Math.max(0, i - 1)]) +
          Math.abs(gray[Math.min(i + width, gray.length - 1)] - gray[Math.max(0, i - width)])
        : gray[i];
      out[ty * THUMB_W + tx] = v;
      mean += v;
    }
  }
  mean /= out.length;
  let norm = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Identical lettering on several pages, wherever it sits (site watermarks placed by hand). */
function findRepeatedLettering(lines: Rect[], pages: PageInfo[], gray: Uint8Array, width: number): Set<number> {
  const t = config.text;
  const thumbs = lines.map((l) => thumbnail(gray, width, l));
  const page = lines.map((l) => pageOf(pages, (l.y0 + l.y1) / 2)?.index ?? -1);
  const marks = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const wi = lines[i].x1 - lines[i].x0;
    const hi = lines[i].y1 - lines[i].y0;
    if (wi < 2 * hi) continue; // single glyphs repeat legitimately
    const seen = new Set<number>([page[i]]);
    for (let j = 0; j < lines.length; j++) {
      if (i === j || page[j] === page[i]) continue;
      const wj = lines[j].x1 - lines[j].x0;
      const hj = lines[j].y1 - lines[j].y0;
      if (Math.abs(wi - wj) > 0.1 * wi || Math.abs(hi - hj) > 0.15 * hi) continue;
      if (Math.abs(lines[i].x0 - lines[j].x0) > 0.03 * width) continue;
      let dot = 0;
      for (let k = 0; k < thumbs[i].length; k++) dot += thumbs[i][k] * thumbs[j][k];
      if (dot >= t.watermarkSimilarity) seen.add(page[j]);
    }
    // Repeated dialogue ("...", "HUH?") sits mid-page; watermark badges hug a side of the strip.
    const atSide = lines[i].x0 <= 0.05 * width || lines[i].x1 >= 0.95 * width;
    if (seen.size >= 3 || (atSide && seen.size >= 2)) marks.add(i);
  }
  return marks;
}

/**
 * Flood fill the balloon interior (pixels close to the text background level) outward from the
 * text, at half resolution. Returns null when the fill leaks out of the search area, which means
 * the text sits on open background rather than inside an enclosed balloon.
 */
export function traceBalloon(gray: Uint8Array, width: number, height: number, text: Rect, bg: number): Rect | null {
  return traceRegion(gray, width, height, text, bg)?.rect ?? null;
}

/** Enclosed region around the text plus the gray-level spread inside it (flat balloon vs. shaded art). */
export function traceRegion(
  gray: Uint8Array,
  width: number,
  height: number,
  text: Rect,
  bg: number,
): { rect: Rect; std: number; area: number } | null {
  const reach = Math.max(config.text.balloonReach * width, text.y1 - text.y0);
  const roi = pad(text, reach, width, height);
  const s = 2;
  const rw = Math.ceil((roi.x1 - roi.x0) / s);
  const rh = Math.ceil((roi.y1 - roi.y0) / s);
  const tol = config.text.balloonTolerance;
  const inMask = (cx: number, cy: number) => {
    const x = Math.min(width - 1, roi.x0 + cx * s);
    const y = Math.min(height - 1, roi.y0 + cy * s);
    return Math.abs(gray[y * width + x] - bg) <= tol;
  };
  const seen = new Uint8Array(rw * rh);
  const stack: number[] = [];
  const tx0 = Math.floor((text.x0 - roi.x0) / s);
  const tx1 = Math.ceil((text.x1 - roi.x0) / s);
  const ty0 = Math.floor((text.y0 - roi.y0) / s);
  const ty1 = Math.ceil((text.y1 - roi.y0) / s);
  for (let cy = Math.max(0, ty0); cy < Math.min(rh, ty1); cy++) {
    for (let cx = Math.max(0, tx0); cx < Math.min(rw, tx1); cx++) {
      const i = cy * rw + cx;
      if (!seen[i] && inMask(cx, cy)) {
        seen[i] = 1;
        stack.push(i);
      }
    }
  }
  if (!stack.length) return null;
  let x0 = rw;
  let y0 = rh;
  let x1 = 0;
  let y1 = 0;
  let n = 0;
  let sum = 0;
  let sq = 0;
  while (stack.length) {
    const i = stack.pop()!;
    const cx = i % rw;
    const cy = (i - cx) / rw;
    if (cx === 0 || cy === 0 || cx === rw - 1 || cy === rh - 1) return null; // leaked
    const v = gray[Math.min(height - 1, roi.y0 + cy * s) * width + Math.min(width - 1, roi.x0 + cx * s)];
    n++;
    sum += v;
    sq += v * v;
    if (cx < x0) x0 = cx;
    if (cx > x1) x1 = cx;
    if (cy < y0) y0 = cy;
    if (cy > y1) y1 = cy;
    for (const j of [i - 1, i + 1, i - rw, i + rw]) {
      if (seen[j]) continue;
      const jx = j % rw;
      const jy = (j - jx) / rw;
      if (inMask(jx, jy)) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  const margin = Math.round(config.text.balloonMargin * width);
  const mean = sum / n;
  return {
    rect: pad(
      { x0: roi.x0 + x0 * s, y0: roi.y0 + y0 * s, x1: roi.x0 + (x1 + 1) * s, y1: roi.y0 + (y1 + 1) * s },
      margin,
      width,
      height,
    ),
    std: Math.sqrt(Math.max(0, sq / n - mean * mean)),
    area: n * s * s,
  };
}

/**
 * A traced region is a balloon or caption box when it is flat (any size: "..." in a big white
 * balloon), or moderately flat and not much larger than its lettering (painted/gradient caption
 * boxes). A large shaded area around a stray OCR hit on the art fails both.
 */
export function isBalloon(region: { std: number; area: number }, text: Rect): boolean {
  const t = config.text;
  if (region.std <= t.balloonFlatStd) return true;
  const textArea = (text.x1 - text.x0) * (text.y1 - text.y0);
  return region.std <= t.balloonMaxStd && region.area <= t.balloonMaxAreaRatio * textArea;
}

export interface TextAnalysis {
  lines: TextLine[];
  blocks: TextBlock[];
}

/** OCR detections big enough to be lettering. Their order matches the readings passed to analyzeText. */
export function lineCandidates(detections: Detection[]): Detection[] {
  const t = config.text;
  return detections.filter((d) => d.kind === 'text' && d.x1 - d.x0 >= t.minLinePx && d.y1 - d.y0 >= t.minLinePx);
}

const normalise = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Two normalised readings of the same lettering: at most 35% of the characters differ. */
const similarReading = (a: string, b: string) =>
  a.length >= 4 && b.length >= 4 && levenshtein(a, b) <= 0.35 * Math.max(a.length, b.length);

export function analyzeText(strip: Strip, raw: Detection[], readings: LineReading[]): TextAnalysis {
  const { gray, width, height } = strip;
  const t = config.text;
  const repeated = findWatermarks(raw, strip.pages, width);
  for (const i of findRepeatedLettering(raw, strip.pages, gray, width)) repeated.add(i);

  // What a line reads as decides its kind (lettering.ts). Background colour does not: narration
  // sits in red, pink or black boxes as often as in white balloons.
  const lines: TextLine[] = raw.map((d, i) => {
    const r = { x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
    const s = lineStats(gray, width, r);
    const v = judgeLettering(readings[i], d.y1 - d.y0, width);
    return {
      ...r,
      score: d.score,
      kind: v.kind,
      read: readings[i].en.text,
      readConf: round3(readings[i].en.conf),
      readKo: readings[i].ko.text,
      why: v.why,
      bg: s.bg,
      bgFrac: round3(s.frameBgFrac),
      inkFrac: round3(s.inkFrac),
    };
  });

  // A repeated badge is a watermark unless it is dialogue. Dialogue repeated by layout (same
  // balloon position on several pages) reads differently each time; a badge reads (nearly) the
  // same, even when the reader garbles a logo in another script ("Reinang", "Reinane", ...).
  const repeatedList = [...repeated];
  const pageOfLine = (i: number) => pageOf(strip.pages, (lines[i].y0 + lines[i].y1) / 2)?.index ?? -1;
  for (const i of repeatedList) {
    const l = lines[i];
    if (l.kind === 'watermark') continue;
    const key = normalise(l.read);
    const pages = new Set<number>([pageOfLine(i)]);
    for (const j of repeatedList) {
      if (j !== i && similarReading(key, normalise(lines[j].read))) pages.add(pageOfLine(j));
    }
    const sameReading = pages.size >= 2;
    if (l.kind !== 'text' || sameReading) {
      l.kind = 'watermark';
      l.why = sameReading ? `repeats on several pages: "${l.read}"` : 'repeats on several pages';
    }
  }

  // The rest of a site banner: lettering stacked right against a site line, about as tall and
  // aligned with it ("TO FASTER UPDATE!" under "READ AT HIVETOON.COM", a logo over its ".com").
  // Dialogue next to a badge stays dialogue: a line with more dialogue lines around it is speech.
  const siteLines = lines.filter((l) => l.kind === 'watermark');
  const speechNear = (l: TextLine) =>
    lines.some(
      (o) =>
        o !== l &&
        o.kind === 'text' &&
        Math.max(o.y0, l.y0) - Math.min(o.y1, l.y1) <= t.joinGapLines * Math.min(o.y1 - o.y0, l.y1 - l.y0) &&
        Math.min(o.x1, l.x1) - Math.max(o.x0, l.x0) > 0 &&
        !siteLines.some((m) => bannerGlue(o, m)),
    );
  for (const l of lines) {
    if (l.kind === 'watermark' || l.kind === 'noise') continue;
    const mark = siteLines.find((m) => bannerGlue(l, m));
    if (!mark || speechNear(l)) continue;
    l.kind = 'watermark';
    l.why = `part of a site banner with "${mark.read}"`;
  }
  return demoteShortOpenText(lines, buildBlocks(gray, width, height, lines));
}

/**
 * Dialogue blocks from classified lines: group lines, trace each group's balloon, merge blocks
 * whose zones overlap, sort and number. Split out of analyzeText so scripts can rebuild blocks
 * from saved lines.
 */
export function buildBlocks(gray: Uint8Array, width: number, height: number, lines: TextLine[]): TextBlock[] {
  const t = config.text;
  // Group dialogue lines: vertically adjacent, horizontally overlapping.
  const cand = lines.map((_, i) => i).filter((i) => lines[i].kind === 'text');
  const parent = new Map<number, number>(cand.map((i) => [i, i]));
  const find = (i: number): number => {
    while (parent.get(i) !== i) i = parent.get(i)!;
    return i;
  };
  for (let a = 0; a < cand.length; a++) {
    for (let b = a + 1; b < cand.length; b++) {
      const p = lines[cand[a]];
      const q = lines[cand[b]];
      const lh = Math.min(p.y1 - p.y0, q.y1 - q.y0);
      const vGap = Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1);
      const hGap = Math.max(p.x0, q.x0) - Math.min(p.x1, q.x1);
      if (vGap <= t.joinGapLines * lh && hGap <= lh) {
        parent.set(find(cand[a]), find(cand[b]));
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (const i of cand) {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }

  let blocks: TextBlock[] = [];
  for (const members of groups.values()) {
    const text = members.map((i) => lines[i] as Rect).reduce(union);
    const lineH = median(members.map((i) => lines[i].y1 - lines[i].y0));
    const bg = Math.round(median(members.map((i) => lines[i].bg)));
    // Dialogue = lettering in an enclosed flat region (balloon, caption box, system window), or on
    // plain surroundings (narration on a gutter). Anything else is lettering drawn into the art.
    // The balloon outline, when there is one, gives the protected zone; otherwise the text is padded.
    const region = traceRegion(gray, width, height, text, bg);
    const bubble = region && isBalloon(region, text) ? region.rect : null;
    const zone = bubble
      ? union(bubble, pad(text, 4, width, height))
      : pad(text, Math.max(12, Math.round(t.loosePadLines * lineH)), width, height);
    blocks.push({ id: 0, lines: members.sort((a, b) => a - b), text, bubble, zone });
  }

  // Overlapping zones belong to the same protected area (touching balloons, two lines blocks in one balloon).
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        if (!intersect(blocks[i].zone, blocks[j].zone)) continue;
        const a = blocks[i];
        const b = blocks[j];
        blocks[i] = {
          id: 0,
          lines: [...a.lines, ...b.lines].sort((x, y) => x - y),
          text: union(a.text, b.text),
          bubble: a.bubble && b.bubble ? union(a.bubble, b.bubble) : (a.bubble ?? b.bubble),
          zone: union(a.zone, b.zone),
        };
        blocks.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  blocks = blocks.sort((a, b) => a.zone.y0 - b.zone.y0).map((b, i) => ({ ...b, id: i }));
  return blocks;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Lines from the small-text pass (lib detectSmallText) that are site lettering: they read as a
 * domain, link or credit (either reader, at config.blur.minConf), or they are a banner line
 * stacked on such a line or on a known watermark ("YOU CAN READ THE CHAPTER ON:" over
 * "EN-THUNDERSCANS.COM"). Everything else the pass finds (texture, small sound effects, signs in
 * the art) is dropped: it is part of the picture.
 */
export function smallSiteLines(found: Detection[], readings: LineReading[], known: TextLine[]): TextLine[] {
  const minConf = config.blur.minConf;
  const asLine = (d: Detection, i: number, why: string): TextLine => ({
    x0: d.x0,
    y0: d.y0,
    x1: d.x1,
    y1: d.y1,
    score: d.score,
    kind: 'watermark',
    read: readings[i].en.text,
    readConf: round3(readings[i].en.conf),
    readKo: readings[i].ko.text,
    why,
    bg: 0,
    bgFrac: 0,
    inkFrac: 0,
  });
  const site: TextLine[] = [];
  found.forEach((d, i) => {
    const { en, ko } = readings[i];
    if (en.conf >= minConf && isCreditText(en.text)) site.push(asLine(d, i, `small lettering reads "${en.text}"`));
    else if (ko.conf >= minConf && isCreditText(ko.text)) site.push(asLine(d, i, `small lettering reads "${ko.text}" (second model)`));
  });
  const marks = [...site, ...known.filter((l) => l.kind === 'watermark')];
  const glued: TextLine[] = [];
  found.forEach((d, i) => {
    if (site.some((s) => s.x0 === d.x0 && s.y0 === d.y0)) return;
    // A banner line is about as tall as the line it is stacked on. A much taller box over a
    // badge is art around it (or the badge's glow), and blurring it would cost art.
    const mark = marks.find((m) => bannerGlue(d, m) && d.y1 - d.y0 <= 1.6 * (m.y1 - m.y0));
    if (mark) glued.push(asLine(d, i, `small lettering in a site banner with "${mark.read}"`));
  });
  return [...site, ...glued];
}

const HANGUL = /[가-힣ㄱ-ㆎ]/;

/**
 * R2a (config.text.shortOpenMinConf, 0 = off). A block with no traced balloon whose every line reads
 * as 3 or fewer letters A-Z in the English reader at a confidence below the limit is not dialogue:
 * a sound effect read as English ('ye'). Its lines become 'sfx' (Hangul in the Korean reading) or
 * 'noise', and the block is removed (ids renumbered); each line keeps the block's zone as `formerZone`, so the planner still offers its crops and edges. Line indices do not change. Pure: returns new
 * arrays and copies of changed lines; used by analyzeText and by scripts/variants.ts on saved data.
 */
export function demoteShortOpenText(lines: TextLine[], blocks: TextBlock[], minConf: number = config.text.shortOpenMinConf): TextAnalysis {
  if (!(minConf > 0)) return { lines, blocks };
  const short = (l: TextLine) => ((l.read ?? '').match(/[A-Za-z]/g) ?? []).length <= 3 && l.readConf < minConf;
  const out = lines.slice();
  const keep: TextBlock[] = [];
  for (const b of blocks) {
    if (b.bubble !== null || !b.lines.every((i) => short(lines[i]))) {
      keep.push(b);
      continue;
    }
    for (const i of b.lines) {
      const l = lines[i];
      const ko = HANGUL.test(l.readKo ?? '');
      out[i] = { ...l, kind: ko ? 'sfx' : 'noise', formerZone: b.zone, why: `short open text "${l.read}" (conf ${l.readConf}) is ${ko ? 'a sound effect (Hangul in the Korean reading)' : 'not readable'}, not dialogue` };
    }
  }
  return { lines: out, blocks: keep.map((b, i) => ({ ...b, id: i })) };
}
