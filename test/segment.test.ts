import { describe, expect, it } from 'vitest';
import { config } from '../src/core/config.ts';
import { analyzeCells, analyzeRows } from '../src/core/rows.ts';
import { segment } from '../src/core/segment.ts';
import type { Detection, Rect, TextBlock } from '../src/core/types.ts';

const W = 800;
type Band = { h: number; rgb?: [number, number, number] };

/** A strip of bands: drawn art (random texture) when no colour is given, else a flat fill. */
function strip(bands: Band[]) {
  const H = bands.reduce((s, b) => s + b.h, 0);
  const rgb = new Uint8Array(W * H * 3);
  const gray = new Uint8Array(W * H);
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let y0 = 0;
  const at: number[] = [];
  for (const b of bands) {
    at.push(y0);
    for (let y = y0; y < y0 + b.h; y++) {
      for (let x = 0; x < W; x++) {
        const c = b.rgb ?? [rand() * 255, rand() * 255, rand() * 255];
        const i = (y * W + x) * 3;
        rgb[i] = c[0];
        rgb[i + 1] = c[1];
        rgb[i + 2] = c[2];
        gray[y * W + x] = Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
      }
    }
    y0 += b.h;
  }
  return { H, rgb, gray, at };
}

function gutters(bands: Band[], heads: Detection[] = []) {
  const s = strip(bands);
  const seg = segment({
    width: W,
    height: s.H,
    gray: s.gray,
    rgb: s.rgb,
    rows: analyzeRows(s.gray, W, s.H),
    cells: analyzeCells(s.gray, W, s.H),
    heads,
    persons: [],
    blocks: [],
    pages: [{ index: 1, file: '1.jpg', y0: 0, y1: s.H, width: W }],
  });
  // Inner gutters only (not the strip's first and last rows).
  return { at: s.at, inner: seg.gutters.filter((g) => g.y0 > 0 && g.y1 < s.H) };
}

describe('gutters', () => {
  it('cuts at a white or black gap between two pictures', () => {
    expect(gutters([{ h: 900 }, { h: 40, rgb: [255, 255, 255] }, { h: 900 }]).inner).toHaveLength(1);
    expect(gutters([{ h: 900 }, { h: 14, rgb: [6, 6, 8] }, { h: 900 }]).inner).toHaveLength(1);
  });

  it('does not take a thin coloured band inside a picture for a gutter', () => {
    // A brown rail and a strip of dark-brown sky: 10 and 22 px, below 3% of the width.
    expect(gutters([{ h: 900 }, { h: 10, rgb: [101, 44, 14] }, { h: 900 }]).inner).toHaveLength(0);
    expect(gutters([{ h: 900 }, { h: 22, rgb: [53, 40, 29] }, { h: 900 }]).inner).toHaveLength(0);
  });

  it('keeps a coloured gutter that is tall enough', () => {
    expect(gutters([{ h: 900 }, { h: 60, rgb: [250, 220, 230] }, { h: 900 }]).inner).toHaveLength(1);
  });

  it('does not take pale skin inside a close-up face for a white gutter', () => {
    // Head box over the whole picture; a 14 px band of pale skin across its lower half.
    const head: Detection = { kind: 'head', x0: 0, y0: 0, x1: W, y1: 1800, score: 0.9 };
    expect(gutters([{ h: 1200 }, { h: 14, rgb: [254, 243, 236] }, { h: 600 }], [head]).inner).toHaveLength(0);
    // The same band in pure white is still allowed: a head box can overlap a real gutter.
    expect(gutters([{ h: 1200 }, { h: 14, rgb: [255, 255, 255] }, { h: 600 }], [head]).inner).toHaveLength(1);
  });
});

describe('borders', () => {
  /** Two pictures touching at a 6 px black border stroke (rows 900-905), with optional balloons. */
  function pieces(blocks: TextBlock[]) {
    const s = strip([{ h: 900 }, { h: 6, rgb: [0, 0, 0] }, { h: 900 }]);
    return segment({
      width: W,
      height: s.H,
      gray: s.gray,
      rgb: s.rgb,
      rows: analyzeRows(s.gray, W, s.H),
      cells: analyzeCells(s.gray, W, s.H),
      heads: [],
      persons: [],
      blocks,
      pages: [{ index: 1, file: '1.jpg', y0: 0, y1: s.H, width: W }],
    }).pieces;
  }
  const balloon = (text: Rect, zone: Rect): TextBlock => ({ id: 0, lines: [], text, bubble: zone, zone });

  it('cuts at a border between two touching pictures', () => {
    const ps = pieces([]);
    expect(ps).toHaveLength(2);
    expect(ps[0].bottom).toBe('border');
    expect(Math.abs(ps[0].y1 - 903)).toBeLessThan(30);
  });

  it('cuts through a balloon drawn across the border, clear of its lettering', () => {
    // The balloon covers rows 700-1100, so no row near the border is clear of it; its lettering
    // ends 40 px above the border.
    const ps = pieces([balloon({ x0: 150, y0: 780, x1: 350, y1: 860 }, { x0: 100, y0: 700, x1: 400, y1: 1100 })]);
    expect(ps).toHaveLength(2);
    expect(ps[0].y1).toBeGreaterThanOrEqual(860 + config.panels.borderLetteringClear * W);
    expect(Math.abs(ps[0].y1 - 903)).toBeLessThan(30);
  });

  it('does not cut through lettering that sits on the border', () => {
    const ps = pieces([balloon({ x0: 150, y0: 870, x1: 350, y1: 940 }, { x0: 100, y0: 800, x1: 400, y1: 1000 })]);
    expect(ps).toHaveLength(1);
  });
});
