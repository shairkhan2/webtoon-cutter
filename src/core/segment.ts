import { config } from './config.ts';
import { findFrameLines } from './frames.ts';
import { overlapY, runs } from './geometry.ts';
import type { CellMap, RowStats } from './rows.ts';
import type { CutKind, Detection, FrameLine, Interval, PageInfo, Panel, PanelRole, Rect, TextBlock } from './types.ts';

export interface SegmentInput {
  width: number;
  height: number;
  gray: Uint8Array;
  /** Packed RGB of the strip. When given, gutter colour checks also look at hue. */
  rgb?: Uint8Array;
  rows: RowStats;
  cells: CellMap;
  heads: Detection[];
  persons: Detection[];
  blocks: TextBlock[];
  pages: PageInfo[];
}

export interface Piece {
  y0: number;
  y1: number;
  top: CutKind;
  bottom: CutKind;
}

export interface PieceStats {
  role: PanelRole;
  heads: number;
  persons: number;
  textBlocks: number;
  artFrac: number;
}

/** Row-level protection shared by segmentation, video cropping and the checks. */
export class Protection {
  readonly zone: Uint8Array; // dialogue zones: never cut, even on empty rows
  readonly head: Uint8Array;
  readonly personCore: Uint8Array;
  readonly personSoft: Uint8Array;
  readonly textCells: Uint8Array;
  private readonly detailSum: Float64Array;
  private readonly input: SegmentInput;

  constructor(input: SegmentInput) {
    this.input = input;
    const { height, heads, persons, blocks, cells } = input;
    this.zone = new Uint8Array(height);
    this.head = new Uint8Array(height);
    this.personCore = new Uint8Array(height);
    this.personSoft = new Uint8Array(height);
    for (const b of blocks) this.zone.fill(1, b.zone.y0, b.zone.y1);
    for (const h of heads) {
      const s = Math.round(0.1 * (h.y1 - h.y0));
      this.head.fill(1, h.y0 + s, h.y1 - s);
    }
    for (const p of persons) {
      const s = Math.round(config.panels.personSoftEdge * (p.y1 - p.y0));
      this.personSoft.fill(1, p.y0, p.y1);
      this.personCore.fill(1, p.y0 + s, p.y1 - s);
    }
    this.textCells = new Uint8Array(cells.cols * cells.rows);
    for (const b of blocks) {
      const z = b.zone;
      for (let cy = Math.floor(z.y0 / cells.size); cy < Math.ceil(z.y1 / cells.size) && cy < cells.rows; cy++) {
        for (let cx = Math.floor(z.x0 / cells.size); cx < Math.ceil(z.x1 / cells.size) && cx < cells.cols; cx++) {
          this.textCells[cy * cells.cols + cx] = 1;
        }
      }
    }
    this.detailSum = new Float64Array(height + 1);
    for (let y = 0; y < height; y++) this.detailSum[y + 1] = this.detailSum[y] + input.rows.detail[y];
  }

  /** Clear person protection inside a frame band: a detector box cannot continue across a verified border. */
  clipPersons(band: Interval): void {
    this.personCore.fill(0, Math.max(0, band.y0), Math.min(this.input.height, band.y1));
  }

  /**
   * May a full-width horizontal cut sit on row y inside a piece? Gutters were already taken out of
   * pieces, so a flat row here is either a sliver or a smooth band inside a subject: no exemption.
   */
  cutOk(y: number): boolean {
    if (y <= 0 || y >= this.input.height) return true;
    return !this.zone[y] && !this.head[y] && !this.personCore[y];
  }

  detailAround(y: number, r = 6): number {
    const a = Math.max(0, y - r);
    const b = Math.min(this.input.height, y + r + 1);
    return (this.detailSum[b] - this.detailSum[a]) / Math.max(1, b - a);
  }
}

export interface Segmentation {
  gutters: Interval[];
  frameLines: FrameLine[];
  pieces: (Piece & PieceStats)[];
  protection: Protection;
}

export function segment(input: SegmentInput): Segmentation {
  const { width, height, rows, blocks } = input;
  const p = config.panels;

  // 1. Gutters: empty full-width rows, except between the lines of a dialogue block.
  const textRows = new Uint8Array(height);
  for (const b of blocks) textRows.fill(1, b.text.y0, b.text.y1);
  const gutterMask = new Uint8Array(height);
  for (let y = 0; y < height; y++) gutterMask[y] = rows.flat[y] && !textRows[y] ? 1 : 0;
  // A flat full-width band is not always a gutter. Inside one picture it can be a smooth band of
  // skin in a close-up, a rail or floor line across the scene, or empty sky between figures.
  // Real gutters are white or black, or taller. So: inside a detected head or body, a band must be
  // white/black or tall; anywhere, a thin coloured band is part of the picture.
  const subject = new Uint8Array(height);
  for (const h of input.heads) subject.fill(1, h.y0 + Math.round(0.1 * (h.y1 - h.y0)), h.y1 - Math.round(0.1 * (h.y1 - h.y0)));
  for (const pr of input.persons) {
    const s = Math.round(p.personSoftEdge * (pr.y1 - pr.y0));
    subject.fill(1, pr.y0 + s, pr.y1 - s);
  }
  const gutters = runs(gutterMask).filter((g) => {
    const len = g.y1 - g.y0;
    if (g.y0 === 0 || g.y1 === height) return true;
    if (len < config.rows.minGutterPx) return false;
    const neutral = gutterColour(input, g);
    const tall = len >= p.subjectGutterHeight * width;
    if (subject.subarray(g.y0, g.y1).some(Boolean) && !tall && !neutral) return false;
    return neutral || len >= p.minColourGutter * width;
  });

  let pieces: Piece[] = [];
  let cursor = 0;
  for (const g of gutters) {
    if (g.y0 > cursor) pieces.push({ y0: cursor, y1: g.y0, top: 'gutter', bottom: 'gutter' });
    cursor = g.y1;
  }
  if (cursor < height) pieces.push({ y0: cursor, y1: height, top: 'gutter', bottom: 'gutter' });

  // 2. Touching panels: split at verified frame borders.
  const protection = new Protection(input);
  const frameLines: FrameLine[] = [];
  const minSide = 0.12 * width;
  const split: Piece[] = [];
  for (const piece of pieces) {
    const cuts: number[] = [];
    const pieceBlocks = blocks.filter((b) => b.zone.y1 > piece.y0 && b.zone.y0 < piece.y1);
    const occluders = pieceBlocks.map((b) => b.zone);
    for (const line of findFrameLines(input.gray, width, piece, occluders)) {
      const band = { y0: Math.min(line.yLeft, line.yRight) - 2, y1: Math.max(line.yLeft, line.yRight) + 3 };
      const ext = Math.round(0.03 * width);
      const lo = Math.max(piece.y0 + minSide, band.y0 - ext);
      const hi = Math.min(piece.y1 - minSide, band.y1 + ext);
      const mid = (band.y0 + band.y1) / 2;
      const reach = (band.y1 - band.y0) / 2 + ext;
      // First a row clear of every balloon. Failing that, a row through a balloon drawn across the
      // border, clear of its lettering: the border is the artist's cut, and the lettering stays
      // whole in one panel.
      let best = -1;
      for (const dialogue of [(y: number) => protection.zone[y] > 0, dialogueAtBorder(pieceBlocks, line, width)]) {
        let bestCost = Infinity;
        for (let y = Math.ceil(lo); y <= hi; y++) {
          const inBand = y >= band.y0 && y < band.y1;
          if (dialogue(y) || protection.head[y] || (!inBand && protection.personCore[y])) continue;
          const cost = protection.detailAround(y, 3) + (0.5 * Math.abs(y - mid)) / Math.max(1, reach);
          if (cost < bestCost) {
            bestCost = cost;
            best = y;
          }
        }
        if (best >= 0) break;
      }
      if (best < 0 || cuts.some((c) => Math.abs(c - best) < minSide)) continue;
      cuts.push(best);
      frameLines.push(line);
      protection.clipPersons(band);
    }
    cuts.sort((a, b) => a - b);
    let start = piece.y0;
    let top = piece.top;
    for (const c of cuts) {
      split.push({ y0: start, y1: c, top, bottom: 'border' });
      start = c;
      top = 'border';
    }
    split.push({ y0: start, y1: piece.y1, top, bottom: piece.bottom });
  }
  pieces = split;

  // 3. Classify, then fold decor (specks, floating SFX, small logos) into the nearest neighbour.
  const stats = pieces.map((pc) => classify(input, protection, pc));
  for (let i = 0; i < pieces.length; i++) {
    if (stats[i].role !== 'decor' || pieces.length < 2) continue;
    const gapUp = i > 0 ? pieces[i].y0 - pieces[i - 1].y1 : Infinity;
    const gapDn = i < pieces.length - 1 ? pieces[i + 1].y0 - pieces[i].y1 : Infinity;
    if (Math.min(gapUp, gapDn) > 0.3 * width) continue;
    const j = gapUp <= gapDn ? i - 1 : i + 1;
    pieces[j] =
      j < i
        ? { ...pieces[j], y1: pieces[i].y1, bottom: pieces[i].bottom }
        : { ...pieces[j], y0: pieces[i].y0, top: pieces[i].top };
    stats[j] = classify(input, protection, pieces[j]);
    pieces.splice(i, 1);
    stats.splice(i, 1);
    i = Math.max(-1, Math.min(i, j) - 2);
  }

  // 4. A run of dialogue-only pieces close together reads as one exchange.
  for (let i = 0; i < pieces.length - 1; i++) {
    const a = pieces[i];
    const b = pieces[i + 1];
    if (stats[i].role !== 'text' || stats[i + 1].role !== 'text') continue;
    if (b.y0 - a.y1 > p.textJoinGap * width || b.y1 - a.y0 > p.textJoinMaxHeight * width) continue;
    pieces[i] = { ...a, y1: b.y1, bottom: b.bottom };
    pieces.splice(i + 1, 1);
    stats.splice(i + 1, 1);
    stats[i] = classify(input, protection, pieces[i]);
    i--;
  }

  // 5. Oversize art: split at the quietest safe rows. Protected subjects stay whole.
  const final: Piece[] = [];
  for (const [i, pc] of pieces.entries()) {
    if (stats[i].role === 'art' || stats[i].role === 'art_text') final.push(...splitTall(pc, protection, width));
    else final.push(pc);
  }
  return {
    gutters,
    frameLines: frameLines.sort((a, b) => a.yLeft - b.yLeft),
    pieces: final.map((pc) => ({ ...pc, ...classify(input, protection, pc) })),
    protection,
  };
}

/**
 * Rows a border cut may not take when no row near the line is clear of balloons: the lettering of
 * each balloon the border runs through (plus `borderLetteringClear`), and the whole of every other
 * dialogue zone.
 */
function dialogueAtBorder(blocks: TextBlock[], line: FrameLine, width: number): (y: number) => boolean {
  const clear = config.panels.borderLetteringClear * width;
  const lineAt = (x: number) => line.yLeft + ((line.yRight - line.yLeft) * x) / width;
  const kept = blocks.map((b) => {
    const z = b.zone;
    const top = Math.min(lineAt(z.x0), lineAt(z.x1));
    const bottom = Math.max(lineAt(z.x0), lineAt(z.x1));
    const across = top < z.y1 - clear && bottom > z.y0 + clear;
    return across ? { y0: b.text.y0 - clear, y1: b.text.y1 + clear } : z;
  });
  return (y) => kept.some((k) => y >= k.y0 && y < k.y1);
}

function meanGray(gray: Uint8Array, width: number, iv: Interval): number {
  let sum = 0;
  for (let i = iv.y0 * width; i < iv.y1 * width; i++) sum += gray[i];
  return sum / Math.max(1, (iv.y1 - iv.y0) * width);
}

/**
 * Is the band white or black (gutter colour)? Near-black counts whatever its tint; near-white must
 * also be neutral, so pale skin or a cream wall is not taken for a white gutter.
 */
function gutterColour(input: SegmentInput, iv: Interval): boolean {
  const gray = meanGray(input.gray, input.width, iv);
  if (gray <= 24) return true;
  if (gray < 232) return false;
  if (!input.rgb) return true;
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = iv.y0; y < iv.y1; y++) {
    for (let x = 0; x < input.width; x += 2) {
      const i = (y * input.width + x) * 3;
      sum[0] += input.rgb[i];
      sum[1] += input.rgb[i + 1];
      sum[2] += input.rgb[i + 2];
      n++;
    }
  }
  const mean = sum.map((v) => v / Math.max(1, n));
  return Math.max(...mean) - Math.min(...mean) <= config.panels.gutterChroma;
}

function splitTall(pc: Piece, prot: Protection, width: number): Piece[] {
  const maxH = config.panels.maxHeight * width;
  const minSide = Math.round(config.panels.minSplitHeight * width);
  if (pc.y1 - pc.y0 <= maxH) return [pc];
  const mid = (pc.y0 + pc.y1) / 2;
  const halfH = (pc.y1 - pc.y0) / 2;
  let best = -1;
  let bestCost = Infinity;
  for (let y = pc.y0 + minSide; y <= pc.y1 - minSide; y += 2) {
    if (!prot.cutOk(y)) continue;
    const cost = prot.detailAround(y) + (0.35 * Math.abs(y - mid)) / halfH + (prot.personSoft[y] ? 0.3 : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = y;
    }
  }
  if (best < 0) return [pc];
  return [
    ...splitTall({ y0: pc.y0, y1: best, top: pc.top, bottom: 'split' }, prot, width),
    ...splitTall({ y0: best, y1: pc.y1, top: 'split', bottom: pc.bottom }, prot, width),
  ];
}

/** Content cells in the rect that are not covered by dialogue. */
function artCells(cells: CellMap, textCells: Uint8Array, r: Rect): { art: number; free: number } {
  let art = 0;
  let free = 0;
  const cy0 = Math.floor(r.y0 / cells.size);
  const cy1 = Math.min(cells.rows, Math.ceil(r.y1 / cells.size));
  const cx0 = Math.floor(r.x0 / cells.size);
  const cx1 = Math.min(cells.cols, Math.ceil(r.x1 / cells.size));
  for (let cy = cy0; cy < cy1; cy++) {
    for (let cx = cx0; cx < cx1; cx++) {
      const i = cy * cells.cols + cx;
      if (textCells[i]) continue;
      free++;
      if (cells.content[i]) art++;
    }
  }
  return { art, free };
}

export function classify(input: SegmentInput, prot: Protection, pc: Interval): PieceStats {
  const { width, cells } = input;
  const p = config.panels;
  const full = { x0: 0, y0: pc.y0, x1: width, y1: pc.y1 };
  const h = pc.y1 - pc.y0;
  const { art, free } = artCells(cells, prot.textCells, full);
  const artFrac = free ? art / free : 0;

  // A detection counts only when there is drawn content under it in this piece.
  const backed = (d: Detection, minShare: number) => {
    const ov = overlapY(d, pc);
    if (ov <= 0) return false;
    const r = { x0: d.x0, y0: Math.max(d.y0, pc.y0), x1: d.x1, y1: Math.min(d.y1, pc.y1) };
    const c = artCells(cells, prot.textCells, r);
    return c.free > 0 && c.art >= Math.max(4, minShare * c.free);
  };
  const heads = input.heads.filter((d) => overlapY(d, pc) >= 0.5 * (d.y1 - d.y0) && backed(d, 0.3)).length;
  const persons = input.persons.filter(
    (d) => (overlapY(d, pc) >= 0.3 * (d.y1 - d.y0) || overlapY(d, pc) >= 0.5 * h) && backed(d, 0.15),
  ).length;
  const textBlocks = input.blocks.filter((b) => {
    const cy = (b.text.y0 + b.text.y1) / 2;
    return cy >= pc.y0 && cy < pc.y1;
  }).length;

  // Scenery without people (sky, buildings, effects) counts as art when it covers enough area.
  const cellArea = cells.size * cells.size;
  const sceneArt = artFrac >= p.artFrac && art * cellArea >= p.sceneArtArea * width * width;
  let role: PanelRole;
  if (heads || persons || sceneArt) role = textBlocks ? 'art_text' : 'art';
  else role = textBlocks ? 'text' : 'decor';
  return { role, heads, persons, textBlocks, artFrac: Math.round(artFrac * 1000) / 1000 };
}

/** Turn pieces into reader panels, keeping a little gutter around each one. */
export function buildPanels(seg: Segmentation, pages: PageInfo[], width: number, height: number): Panel[] {
  const m = config.panels.marginPx;
  const ps = seg.pieces;
  return ps.map((pc, i) => {
    const prev = ps[i - 1];
    const next = ps[i + 1];
    let y0 = pc.y0;
    let y1 = pc.y1;
    let top: CutKind = pc.top;
    let bottom: CutKind = pc.bottom;
    if (!prev) {
      y0 = Math.max(0, pc.y0 - m);
      top = 'start';
    } else if (pc.y0 > prev.y1) y0 = pc.y0 - Math.min(m, Math.floor((pc.y0 - prev.y1) / 2));
    if (!next) {
      y1 = Math.min(height, pc.y1 + m);
      bottom = 'end';
    } else if (next.y0 > pc.y1) y1 = pc.y1 + Math.min(m, Math.floor((next.y0 - pc.y1) / 2));
    const id = `p${String(i + 1).padStart(3, '0')}`;
    return {
      id,
      index: i + 1,
      y0,
      y1,
      contentY0: pc.y0,
      contentY1: pc.y1,
      role: pc.role,
      reader: true,
      top,
      bottom,
      heads: pc.heads,
      persons: pc.persons,
      textBlocks: pc.textBlocks,
      artFrac: pc.artFrac,
      pages: pages.filter((pg) => pg.y0 < y1 && pg.y1 > y0).map((pg) => pg.index),
      tall: y1 - y0 > config.panels.maxHeight * width,
      shotIds: [],
    };
  });
}
