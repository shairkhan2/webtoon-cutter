import { describe, expect, it } from 'vitest';
import type { LineReading } from '../src/core/detect/reader.ts';
import { smallSiteLines } from '../src/core/text.ts';
import type { Detection, Rect, TextLine } from '../src/core/types.ts';
import { bannerGlue, blurMarks } from '../src/core/watermarks.ts';

/** A white image with black vertical strokes (letters) inside `r`. */
function lettered(w: number, h: number, r: Rect): Buffer {
  const b = Buffer.alloc(w * h * 3, 255);
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (x % 6 < 2) b.fill(0, (y * w + x) * 3, (y * w + x) * 3 + 3);
  return b;
}
const px = (b: Buffer, w: number, x: number, y: number) => b[(y * w + x) * 3];

describe('watermark blur', () => {
  it('makes the lettering unreadable and leaves the art around it alone', async () => {
    const w = 300;
    const h = 120;
    const mark = { x0: 100, y0: 50, x1: 200, y1: 70 }; // 20 px lettering
    const img = lettered(w, h, mark);
    // Art just outside the blurred area: a black dot 15 px right of the mark.
    img.fill(0, (60 * w + 215) * 3, (60 * w + 215) * 3 + 3);
    const before = Buffer.from(img);
    await blurMarks(img, w, h, [mark]);
    // Strokes become a flat grey: contrast inside the mark drops from 255 to a few levels.
    let lo = 255;
    let hi = 0;
    for (let x = 110; x < 190; x++) {
      const v = px(img, w, x, 60);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(hi - lo).toBeLessThan(40);
    // Pixels beyond pad + feather (0.35 × 20 = 7 px) are unchanged.
    expect(px(img, w, 215, 60)).toBe(px(before, w, 215, 60));
    expect(px(img, w, 150, 40)).toBe(px(before, w, 150, 40));
    expect(px(img, w, 90, 60)).toBe(px(before, w, 90, 60));
  });
});

describe('banner lines', () => {
  const line = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 });

  it('joins the lines of a stacked corner banner', () => {
    // "YOU CAN READ THE CHAPTER ON:" right over "EN-THUNDERSCANS.COM", left-aligned.
    expect(bannerGlue(line(72, 1000, 255, 1020), line(68, 1014, 256, 1038))).toBe(true);
    // "TO FASTER UPDATE!" centred under "READ AT HIVETOON.COM".
    expect(bannerGlue(line(64, 2056, 398, 2112), line(28, 2000, 432, 2056))).toBe(true);
    // A logo overlapping its ".com".
    expect(bannerGlue(line(188, 3054, 266, 3086), line(62, 3000, 282, 3070))).toBe(true);
  });

  it('does not join lettering that is only nearby', () => {
    // A line far above, a much taller sign, and a line in another column.
    expect(bannerGlue(line(70, 900, 250, 920), line(68, 1014, 256, 1038))).toBe(false);
    expect(bannerGlue(line(124, 4000, 262, 4430), line(0, 4498, 228, 4608))).toBe(false);
    expect(bannerGlue(line(500, 1014, 700, 1038), line(68, 1014, 256, 1038))).toBe(false);
  });
});

describe('small-text pass', () => {
  const det = (x0: number, y0: number, x1: number, y1: number): Detection => ({ kind: 'text', x0, y0, x1, y1, score: 0.8 });
  const read = (en: string, enConf: number, ko = '', koConf = 0): LineReading => ({ en: { text: en, conf: enConf }, ko: { text: ko, conf: koConf } });

  it('keeps site lettering and the banner line on it, drops texture and signs', () => {
    const found = [det(68, 1014, 256, 1038), det(72, 1000, 255, 1020), det(400, 3000, 460, 3020), det(500, 5000, 560, 5030)];
    const readings = [read('En-ThunDerSCAnS.COm', 0.65), read('You can read the chapter on:', 0.95), read('SA', 0.62), read('ARG!', 0.62)];
    const lines = smallSiteLines(found, readings, [] as TextLine[]);
    expect(lines.map((l) => l.read)).toEqual(['En-ThunDerSCAnS.COm', 'You can read the chapter on:']);
    expect(lines.every((l) => l.kind === 'watermark')).toBe(true);
  });

  it('does not attach a box much taller than the badge it overlaps', () => {
    // A 189 px box of art around a 50 px logo watermark.
    const badge: TextLine = {
      x0: 662, y0: 69367, x1: 788, y1: 69417, score: 0.9, kind: 'watermark', read: 'Rsinang', readConf: 0.7,
      why: 'repeats on several pages', bg: 0, bgFrac: 0, inkFrac: 0,
    };
    expect(smallSiteLines([det(592, 69207, 787, 69396)], [read('s', 0.5)], [badge])).toHaveLength(0);
  });

  it('uses the second reader when the first garbles a stylised domain', () => {
    const lines = smallSiteLines([det(100, 50, 280, 74)], [read('En-ThunoERscANS.CQM', 0.3, 'EN-THUNDERSCANS.COM', 0.8)], []);
    expect(lines).toHaveLength(1);
  });
});
