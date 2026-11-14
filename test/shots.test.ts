import { describe, expect, it } from 'vitest';
import type { DetailMap } from '../src/core/interest.ts';
import { judgeLettering } from '../src/core/lettering.ts';
import { config } from '../src/core/config.ts';
import { demoteShortOpenText } from '../src/core/text.ts';
import { explainBoxes, objectHeads, pickShots, planShots, type ShotInput } from '../src/core/shots.ts';
import type { Detection, Panel, Rect, TextBlock, TextLine } from '../src/core/types.ts';

const W = 900;

/** Detail map with no drawn detail except in the given rects. */
function detailMap(height: number, busy: Rect[] = []): DetailMap {
  const size = 16;
  const cols = Math.ceil(W / size);
  const rows = Math.ceil(height / size);
  const iso = new Float32Array(cols * rows);
  const ink = new Float32Array(cols * rows);
  const mean = new Float32Array(cols * rows).fill(128);
  for (const r of busy) {
    for (let cy = Math.floor(r.y0 / size); cy < Math.ceil(r.y1 / size); cy++) {
      for (let cx = Math.floor(r.x0 / size); cx < Math.ceil(r.x1 / size); cx++) {
        const c = cy * cols + cx;
        iso[c] = 0.05;
        ink[c] = 0.05;
        mean[c] = ((cx >> 1) + (cy >> 1)) % 2 ? 40 : 220; // contrast between the 2x2-cell blocks
      }
    }
  }
  return { size, cols, rows, iso, ink, mean };
}

const det = (kind: Detection['kind'], x0: number, y0: number, x1: number, y1: number): Detection => ({ kind, x0, y0, x1, y1, score: 0.9 });

function panel(y0: number, y1: number): Panel {
  return {
    id: 'p001', index: 1, y0, y1, contentY0: y0, contentY1: y1, role: 'art', reader: true, top: 'gutter', bottom: 'gutter',
    heads: 1, persons: 1, textBlocks: 0, artFrac: 0.5, pages: [1], tall: false, shotIds: [],
  };
}

function dialogue(r: Rect, lines: Rect[]): { block: TextBlock; lines: TextLine[] } {
  const ls = lines.map((l) => ({ ...l, score: 0.9, kind: 'text' as const, read: 'HELLO THERE', readConf: 0.95, why: 'reads "HELLO THERE"', bg: 244, bgFrac: 0.9, inkFrac: 0.2 }));
  return { block: { id: 0, lines: ls.map((_, i) => i), text: lines.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) })), bubble: r, zone: r }, lines: ls };
}

function input(height: number, extra: Partial<ShotInput> = {}): ShotInput {
  const base: ShotInput = { width: W, height, detail: detailMap(height), faces: [], heads: [], persons: [], blocks: [], lines: [], frameLines: [], pages: [{ index: 1, file: '1.jpg', y0: 0, y1: height, width: W }], ...extra };
  // Balloons are white on screen, as in a real page: the planner measures them by their fill.
  const d = base.detail;
  for (const b of base.blocks) {
    for (let cy = 0; cy < d.rows; cy++) {
      for (let cx = 0; cx < d.cols; cx++) {
        const px = (cx + 0.5) * d.size;
        const py = (cy + 0.5) * d.size;
        if (px >= b.zone.x0 && px < b.zone.x1 && py >= b.zone.y0 && py < b.zone.y1) d.mean[cy * d.cols + cx] = 250;
      }
    }
  }
  return base;
}

describe('pickShots', () => {
  it('chooses the best set of shots that do not overlap vertically', () => {
    const c = (y0: number, y1: number, score: number) => ({ y0, y1, score });
    const picked = pickShots([c(0, 500, 1), c(400, 900, 1.5), c(600, 1000, 0.9)]);
    expect(picked).toEqual([c(0, 500, 1), c(600, 1000, 0.9)]);
  });

  it('adds a second shot only when it is worth more than the extra-shot cost', () => {
    const c = (y0: number, y1: number, score: number) => ({ y0, y1, score });
    expect(pickShots([c(0, 500, 1), c(600, 1000, 0.4)], 0.55)).toEqual([c(0, 500, 1)]);
    expect(pickShots([c(0, 500, 1), c(600, 1000, 0.9)], 0.55)).toHaveLength(2);
  });
});

describe('judgeLettering', () => {
  const read = (en: string, enConf: number, ko = '', koConf = 0) => ({ en: { text: en, conf: enConf }, ko: { text: ko, conf: koConf } });
  it('treats readable English as dialogue, even in a large caption', () => {
    expect(judgeLettering(read("I COULDN'T BELIEVE", 0.99), 60, W).kind).toBe('text');
    expect(judgeLettering(read('I WAS REBORN.', 0.92), 125, W).kind).toBe('text');
  });
  it('treats site names and credits as watermarks', () => {
    expect(judgeLettering(read('ASURASCANS.COM', 0.95), 44, W).kind).toBe('watermark');
    expect(judgeLettering(read('ED: HAZ', 0.8), 38, W).kind).toBe('watermark');
  });
  it('treats Korean and very tall single words as sound effects', () => {
    expect(judgeLettering(read('E6', 0.27, '타', 0.6), 290, W).kind).toBe('sfx');
    expect(judgeLettering(read('Thee', 0.83), 226, W).kind).toBe('sfx');
  });
  it('ignores boxes that read as nothing', () => {
    expect(judgeLettering(read('', 0, '1', 0.75), 108, W).kind).toBe('noise');
  });
  it('falls back to the second model for stylised English', () => {
    expect(judgeLettering(read('What ki e t', 0.56, 'Whatkdedywan?', 0.83), 44, W).kind).toBe('text');
  });
});

describe('planShots', () => {
  // One character: head 400-800 (face 500-760), body 400-1500, in a 0-1600 panel.
  const person = { heads: [det('head', 300, 400, 600, 800)], faces: [det('face', 330, 500, 570, 760)], persons: [det('person', 200, 400, 700, 1500)] };

  it('frames a single character without cutting the face', () => {
    const p = panel(0, 1600);
    const shots = planShots([p], input(1600, person));
    expect(shots.length).toBeGreaterThan(0);
    const s = shots.find((x) => x.focus === 'face')!;
    expect(s.y0).toBeLessThanOrEqual(500);
    expect(s.y1).toBeGreaterThanOrEqual(760);
    expect(s.dialogueShare).toBe(0);
  });

  it('accepts a balloon edge under the chin but keeps its text out', () => {
    // Balloon starts just above the chin; its first line is well below it.
    const { block, lines } = dialogue({ x0: 50, y0: 740, x1: 500, y1: 1100 }, [{ x0: 120, y0: 860, x1: 430, y1: 910 }, { x0: 120, y0: 910, x1: 430, y1: 960 }]);
    const p = panel(0, 1100);
    const shots = planShots([p], input(1100, { ...person, persons: [det('person', 200, 400, 700, 1100)], blocks: [block], lines }));
    const s = shots.find((x) => x.focus === 'face');
    expect(s).toBeDefined();
    expect(s!.y1).toBeLessThanOrEqual(860);
    expect(s!.dialogueLines).toBe(0);
  });

  it('rejects a panel whose balloon covers the face', () => {
    const { block, lines } = dialogue({ x0: 300, y0: 450, x1: 650, y1: 800 }, [{ x0: 340, y0: 560, x1: 600, y1: 610 }]);
    const p = panel(0, 1600);
    const shots = planShots([p], input(1600, { ...person, blocks: [block], lines }));
    expect(shots.filter((s) => s.focus === 'face')).toHaveLength(0);
  });

  it('trims hair to keep the text of a balloon above the head out, never the face', () => {
    // Balloon over the top of the hair; its last line ends at 440, the face starts at 500.
    const { block, lines } = dialogue({ x0: 250, y0: 250, x1: 650, y1: 470 }, [
      { x0: 300, y0: 300, x1: 600, y1: 350 },
      { x0: 300, y0: 350, x1: 600, y1: 440 },
    ]);
    const shots = planShots([panel(0, 1600)], input(1600, { ...person, blocks: [block], lines }));
    const s = shots.find((x) => x.focus === 'face')!;
    expect(s).toBeDefined();
    expect(s.y0).toBeGreaterThan(440);
    expect(s.y0).toBeLessThanOrEqual(500);
    expect(s.dialogueLines).toBe(0);
    expect(s.why).toContain('hair trimmed');
  });

  it('drops empty background and keeps drawn scenery as b-roll', () => {
    const empty = panel(0, 1200);
    expect(planShots([empty], input(1200))).toHaveLength(0);
    expect(empty.videoSkip).toBe('empty_stretch');
    const scenery = panel(0, 1200);
    const shots = planShots([scenery], input(1200, { detail: detailMap(1200, [{ x0: 0, y0: 200, x1: 900, y1: 900 }]) }));
    expect(shots).toHaveLength(1);
    expect(shots[0].tier).toBe('B');
  });

  it('excludes credits pages', () => {
    const p = { ...panel(0, 1600), role: 'credits' as const };
    expect(planShots([p], input(1600, person))).toHaveLength(0);
    expect(p.videoSkip).toBe('credits');
  });
});

describe('shot size (sweet spot 9:16, up to 7% taller to show something whole)', () => {
  const sweet = (16 / 9) * W; // 1600 px at W = 900
  const largest = 1.07 * sweet; // 1712 px
  const character = (top: number, bodyEnd: number) => ({
    heads: [det('head', 300, top, 600, top + 400)],
    faces: [det('face', 330, top + 100, 570, top + 360)],
    persons: [det('person', 200, top, 700, bodyEnd)],
  });
  const drawn = (height: number) => detailMap(height, [{ x0: 0, y0: 0, x1: W, y1: height }]);

  it('frames a figure taller than any box in a full 9:16 box', () => {
    // Head 400-800, body down to 2600.
    const shots = planShots([panel(0, 3000)], input(3000, character(400, 2600)));
    const s = shots.find((x) => x.focus === 'face')!;
    expect(s).toBeDefined();
    expect(s.y1 - s.y0).toBeGreaterThanOrEqual(0.95 * sweet);
    expect(s.y1 - s.y0).toBeLessThanOrEqual(sweet + 4);
  });

  it('fills the 9:16 box with the drawn scene around a short figure', () => {
    // Body ends at 1300; drawn background fills the whole panel.
    const shots = planShots([panel(0, 3000)], input(3000, { ...character(400, 1300), detail: drawn(3000) }));
    const s = shots.find((x) => x.focus === 'face')!;
    expect(s.y0).toBeLessThanOrEqual(400);
    expect(s.y1 - s.y0).toBeGreaterThanOrEqual(0.95 * sweet);
  });

  it('goes past 9:16 to show a whole panel that is slightly taller', () => {
    const shots = planShots([panel(0, 1700)], input(1700, { ...character(100, 1650), detail: drawn(1700) }));
    expect(shots).toHaveLength(1);
    expect(shots[0].y1 - shots[0].y0).toBe(1700);
  });

  it('stays 9:16 when going taller would show nothing whole', () => {
    // Drawn art and the body continue far past any box: no natural place to end.
    const shots = planShots([panel(0, 4000)], input(4000, { ...character(1000, 3900), detail: drawn(4000) }));
    for (const s of shots) {
      expect(s.y1 - s.y0).toBeLessThanOrEqual(sweet + 4);
      expect(s.y1 - s.y0).toBeLessThanOrEqual(largest);
    }
  });

  it('gives two people one box when one box can hold both', () => {
    const a = character(100, 900);
    const b = { heads: [det('head', 300, 800, 600, 1100)], faces: [det('face', 330, 870, 570, 1080)], persons: [det('person', 200, 800, 700, 1500)] };
    const shots = planShots([panel(0, 1600)], input(1600, { heads: [...a.heads, ...b.heads], faces: [...a.faces, ...b.faces], persons: [...a.persons, ...b.persons] }));
    expect(shots).toHaveLength(1);
    expect(shots[0].faces).toBe(2);
  });

  it('keeps two shots when the people are too far apart for one box', () => {
    const a = character(100, 900);
    const b = character(2900, 3700);
    const shots = planShots([panel(0, 4000)], input(4000, { heads: [...a.heads, ...b.heads], faces: [...a.faces, ...b.faces], persons: [...a.persons, ...b.persons] }));
    expect(shots).toHaveLength(2);
    expect(shots.map((s) => s.faces)).toEqual([1, 1]);
  });

  it('lets b-roll show as much of a tall scene as a box holds', () => {
    const shots = planShots([panel(0, 2400)], input(2400, { detail: drawn(2400) }));
    expect(shots).toHaveLength(1);
    expect(shots[0].tier).toBe('B');
    expect(shots[0].y1 - shots[0].y0).toBeGreaterThanOrEqual(0.95 * sweet);
    expect(shots[0].y1 - shots[0].y0).toBeLessThanOrEqual(sweet + 4);
  });

  it('drops a weak b-roll strip that only continues the scene under a shot', () => {
    // Panel 1: a figure in a 9:16 panel. Panel 2: 400 px more of the same drawn scene, joined
    // to panel 1 by a border (no gutter).
    const scene = (cut: 'border' | 'gutter') => {
      const panels: Panel[] = [
        { ...panel(0, 1600), bottom: cut },
        { ...panel(1600, 2000), id: 'p002', index: 2, top: cut, heads: 0, persons: 0 },
      ];
      const shots = planShots(panels, input(2000, { ...character(300, 1500), detail: drawn(2000) }));
      return { panels, second: shots.filter((s) => s.panelId === 'p002') };
    };
    const joined = scene('border');
    expect(joined.second).toHaveLength(0);
    expect(joined.panels[1].videoSkip).toBe('leftover');
    // With a gutter between them the second panel is its own scene and keeps its b-roll.
    expect(scene('gutter').second).toHaveLength(1);
  });

  it('keeps the whole width and height around a corner watermark, and lists it for blurring', () => {
    // A site badge in the bottom-left corner, inside the art.
    const mark: TextLine = {
      x0: 10, y0: 1500, x1: 250, y1: 1540, score: 0.9, kind: 'watermark', read: 'NIGHTSCANS.NET', readConf: 0.95,
      why: 'reads "NIGHTSCANS.NET"', bg: 0, bgFrac: 0, inkFrac: 0,
    };
    const shots = planShots([panel(0, 1600)], input(1600, { ...character(100, 1550), detail: drawn(1600), lines: [mark] }));
    const s = shots.find((x) => x.focus === 'face')!;
    expect(s.x0).toBe(0);
    expect(s.x1).toBe(W);
    expect(s.y1).toBeGreaterThanOrEqual(1540);
    expect(s.watermarks).toEqual([{ x0: 10, y0: 1500, x1: 250, y1: 1540 }]);
  });

  it('keeps a small balloon instead of shrinking the box to leave it out', () => {
    // One short line in a small balloon below the face; art continues down to 1700.
    const { block, lines } = dialogue({ x0: 80, y0: 1150, x1: 330, y1: 1300 }, [{ x0: 120, y0: 1200, x1: 300, y1: 1240 }]);
    const shots = planShots([panel(0, 1800)], input(1800, { ...character(100, 1700), detail: drawn(1800), blocks: [block], lines }));
    const s = shots.find((x) => x.focus === 'face')!;
    expect(s.y1).toBeGreaterThan(1300);
    expect(s.dialogueLines).toBe(1);
  });
});

describe('rule switches (R1, R1b, R2a, R2b, R2c, R3)', () => {
  const cfg = config.shots as unknown as Record<string, number | boolean>;
  const tcfg = config.text as unknown as Record<string, number>;
  const withCfg = <T>(c: Record<string, number | boolean>, set: Record<string, number | boolean>, fn: () => T): T => {
    const old = Object.fromEntries(Object.keys(set).map((k) => [k, c[k]]));
    Object.assign(c, set);
    try {
      return fn();
    } finally {
      Object.assign(c, old);
    }
  };
  const score = (e: unknown) => ('score' in (e as object) ? (e as { score: number }).score : -1);

  it('R1 bodyCutCost: a side crop that leaves out part of a body scores lower', () => {
    const inp = input(1600, { heads: [det('head', 450, 100, 750, 400)], faces: [det('face', 480, 130, 720, 380)], persons: [det('person', 100, 100, 800, 1000)] });
    const box = { x0: 450, y0: 0, x1: 900, y1: 700 };
    const off = withCfg(cfg, { bodyCutCost: 0 }, () => score(explainBoxes(panel(0, 1600), inp, [box])[0]));
    const on = withCfg(cfg, { bodyCutCost: 1 }, () => score(explainBoxes(panel(0, 1600), inp, [box])[0]));
    expect(off).toBeGreaterThan(0);
    expect(on).toBeLessThan(off);
  });

  it('R1b sideArtKept: a side crop that drops a drawn side no longer counts as keeping all the art', () => {
    const inp = input(800, { detail: detailMap(800, [{ x0: 0, y0: 0, x1: 900, y1: 800 }]) });
    const box = { x0: 450, y0: 0, x1: 900, y1: 800 };
    const off = score(explainBoxes(panel(0, 800), inp, [box])[0]);
    const on = withCfg(cfg, { sideArtKept: true }, () => score(explainBoxes(panel(0, 800), inp, [box])[0]));
    expect(off).toBeGreaterThan(0);
    expect(on).toBeLessThan(off);
    const full = { x0: 0, y0: 0, x1: 900, y1: 800 };
    expect(withCfg(cfg, { sideArtKept: true }, () => score(explainBoxes(panel(0, 800), inp, [full])[0]))).toBe(score(explainBoxes(panel(0, 800), inp, [full])[0]));
  });

  it('R2a shortOpenMinConf: short low-confidence open text becomes sfx or noise, balloons stay', () => {
    const line = (read: string, conf: number, ko: string): TextLine => ({ x0: 0, y0: 0, x1: 100, y1: 40, score: 0.9, kind: 'text', read, readConf: conf, readKo: ko, why: '', bg: 240, bgFrac: 0.9, inkFrac: 0.2 });
    const lines = [line('ye', 0.617, '\uD544\uB77C'), line('Hi', 0.7, ''), line('HELLO', 0.5, ''), line('ok', 0.9, '')];
    const r = { x0: 0, y0: 0, x1: 100, y1: 40 };
    const blocks: TextBlock[] = [0, 1, 2, 3].map((i) => ({ id: i, lines: [i], text: r, bubble: i === 1 ? r : null, zone: r }));
    expect(demoteShortOpenText(lines, blocks, 0).blocks).toHaveLength(4);
    const out = demoteShortOpenText(lines, blocks, 0.8);
    expect(out.lines.map((l) => l.kind)).toEqual(['sfx', 'text', 'text', 'text']);
    expect(out.blocks.map((b) => b.id)).toEqual([0, 1, 2]);
    expect(lines[0].kind).toBe('text');
    expect(withCfg(tcfg, { shortOpenMinConf: 0.8 }, () => demoteShortOpenText(lines, blocks).blocks.length)).toBe(3);
  });

  it('R2b dropObjectHeads: a weak head under a stronger head on one person is an object', () => {
    const head = (x0: number, y0: number, x1: number, y1: number, score: number) => ({ ...det('head', x0, y0, x1, y1), score });
    const g = head(40, 100, 130, 200, 0.87);
    const cup = head(170, 300, 220, 380, 0.45);
    const persons = [det('person', 0, 90, 210, 700)];
    expect(objectHeads([g, cup], [], persons)).toEqual([cup]);
    expect(objectHeads([g, cup], [det('face', 175, 310, 215, 370)], persons)).toEqual([]);
    expect(objectHeads([g, head(170, 300, 220, 380, 0.6)], [], persons)).toEqual([]);
    expect(objectHeads([g, cup], [], [det('person', 0, 90, 150, 700)])).toEqual([]);
  });

  it('R2c: a body shot looks at the head it shows, not the box fallback', () => {
    const inp = input(1600, { heads: [det('head', 300, 400, 600, 800)], persons: [det('person', 200, 400, 700, 1500)] });
    const s = planShots([panel(0, 1600)], inp).find((x) => x.focus === 'body')!;
    expect(s).toBeDefined();
    expect(s.focusPoint).toEqual({ x: 450, y: 600 });
  });

  it('R3 signsAreArt: a sign read as noise counts as drawn detail for the focus test only', () => {
    const stripes = [100, 450, 800, 1150, 1500].map((y) => ({ x0: 0, y0: y, x1: 900, y1: y + 48 }));
    const d = detailMap(1600, stripes);
    const sign = { x0: 0, y0: 240, x1: 900, y1: 300 };
    for (let cy = Math.floor(sign.y0 / 16); cy < Math.ceil(sign.y1 / 16); cy++) for (let cx = 0; cx < d.cols; cx++) d.iso[cy * d.cols + cx] = 0.5;
    const lines: TextLine[] = [{ ...sign, score: 0.9, kind: 'noise', read: 'EHH', readConf: 0.31, why: 'not readable', bg: 128, bgFrac: 0.5, inkFrac: 0.2 }];
    const inp = input(1600, { detail: d, lines });
    const full = { x0: 0, y0: 0, x1: 900, y1: 1600 };
    const off = withCfg(cfg, { signsAreArt: false }, () => explainBoxes(panel(0, 1600), inp, [full])[0]);
    expect('reject' in off && off.reject).toBe('no_focus');
    const on = withCfg(cfg, { signsAreArt: true }, () => explainBoxes(panel(0, 1600), inp, [full])[0]);
    expect('score' in on).toBe(true);
  });

  it('R1 guard: a second head beside the shown head means a group box (no cost); one below it does not', () => {
    const body = det('person', 100, 100, 900, 1000);
    const mine = { heads: [det('head', 450, 100, 750, 400)], faces: [det('face', 480, 130, 720, 380)] };
    const box = { x0: 450, y0: 0, x1: 900, y1: 700 };
    const run = (inp: ShotInput) => [0, 1].map((on) => withCfg(cfg, { bodyCutCost: on }, () => score(explainBoxes(panel(0, 1600), inp, [box])[0])));
    const beside = run(input(1600, { ...mine, heads: [...mine.heads, det('head', 150, 150, 300, 330)], persons: [body] }));
    expect(beside[0]).toBeGreaterThan(0);
    expect(beside[1]).toBe(beside[0]);
    const below = run(input(1600, { ...mine, heads: [...mine.heads, det('head', 500, 800, 700, 950)], persons: [body] }));
    expect(below[1]).toBeLessThan(below[0]);
  });

  it('R2a former zone: a demoted line over a face blocks nothing', () => {
    const r = { x0: 400, y0: 200, x1: 560, y1: 260 };
    const line: TextLine = { ...r, score: 0.9, kind: 'text', read: 'ye', readConf: 0.6, readKo: '필', why: '', bg: 240, bgFrac: 0.9, inkFrac: 0.2 };
    const block: TextBlock = { id: 0, lines: [0], text: r, bubble: null, zone: r };
    const ch = { heads: [det('head', 300, 100, 600, 500)], faces: [det('face', 330, 200, 570, 460)], persons: [det('person', 200, 100, 700, 1500)] };
    const mk = (on: number) => withCfg(tcfg, { shortOpenMinConf: on }, () => {
      const t = demoteShortOpenText([line], [block]);
      return planShots([panel(0, 1600)], input(1600, { ...ch, detail: detailMap(1600, [{ x0: 0, y0: 0, x1: W, y1: 1600 }]), blocks: t.blocks, lines: t.lines }));
    });
    expect(mk(0).some((s) => s.focus === 'face')).toBe(false);
    expect(mk(0.8).some((s) => s.focus === 'face')).toBe(true);
    expect(demoteShortOpenText([line], [block], 0.8).lines[0].formerZone).toEqual(r);
  });

  it('R3 fallback: a panel that already has a shot is unchanged when signsAreArt is on', () => {
    const inp = input(1600, { heads: [det('head', 300, 400, 600, 800)], persons: [det('person', 200, 400, 700, 1500)] });
    const off = JSON.stringify(planShots([panel(0, 1600)], inp));
    const on = withCfg(cfg, { signsAreArt: true }, () => JSON.stringify(planShots([panel(0, 1600)], inp)));
    expect(on).toBe(off);
  });
});
