import { describe, expect, it } from 'vitest';
import { creditPanels, findCreditPages } from '../src/core/credits.ts';
import { isCreditText, nameMatcher } from '../src/core/lettering.ts';
import type { PageInfo, Panel, TextBlock, TextLine } from '../src/core/types.ts';

describe('credit and site lettering, from any source', () => {
  it('recognises site names, links and credit roles of other groups', () => {
    for (const t of [
      'ASURASCANS.COM',
      'ELFTOON.COM',
      '.com',
      'REAPERSCANS.COM',
      'reaperscans . com',
      'FLAMESCANS.ORG',
      'mangagalaxy.me',
      'hivetoon.com',
      'NIGHTSCANS',
      'Read at luminous',
      'READ THE LATEST CHAPTERS AT',
      'TL: Haz',
      'PR - Ann',
      'QC:Mira',
      'Typesetter: Bo',
      'Translated by Night Team',
      'JOIN OUR DISCORD',
      'discord.gg/abc123',
      'patreon.com/team',
      'Support us on Ko-fi',
      'https://example',
      'www.example',
      'Raw provider: Kim',
    ]) {
      expect(isCreditText(t, null), t).toBe(true);
    }
  });

  it('leaves ordinary dialogue alone', () => {
    for (const t of [
      'ME. ME!',
      'Help... me...',
      'UP AND CRAWL. TO AVOID',
      'HE SCANS THE ROOM.',
      'I READ COMICS.',
      'WHAT IS IT, DEAR?',
      "I'LL GO TO THE STORE",
      'PR-PRINCE?!',
      'RED: THE COLOR OF BLOOD',
      'NO WAY.',
    ]) {
      expect(isCreditText(t, null), t).toBe(false);
    }
  });

  it('adds group names from a list (data/sources.json)', () => {
    const names = nameMatcher(['Night Owl Team', 'KSG']);
    expect(isCreditText('NIGHTOWL TEAM', names)).toBe(true);
    expect(isCreditText('ksg', names)).toBe(true);
    expect(isCreditText('THE NIGHT IS LONG', names)).toBe(false);
    expect(nameMatcher([])).toBeNull();
  });
});

describe('credit pages', () => {
  const W = 800;
  const pages: PageInfo[] = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, file: `${i + 1}.jpg`, y0: i * 1000, y1: (i + 1) * 1000, width: W }));
  const line = (page: number, read: string, kind: TextLine['kind'], h = 40): TextLine => ({
    x0: 100, y0: (page - 1) * 1000 + 300, x1: 600, y1: (page - 1) * 1000 + 300 + h,
    score: 0.9, kind, read, readConf: 0.9, why: `reads "${read}"`, bg: 255, bgFrac: 0.9, inkFrac: 0.2,
  });

  it('finds an end page with promo wording and a site line', () => {
    const lines = [line(10, 'THANKS FOR READING', 'text'), line(10, 'NIGHTSCANS.NET', 'watermark')];
    expect(findCreditPages(pages, lines, W)).toEqual([10]);
  });

  it('finds the publisher staff page (PD, Studio) next to "Read at"', () => {
    const lines = [line(10, 'PD', 'text'), line(10, 'Studio', 'text'), line(10, 'Read t.', 'text')];
    expect(findCreditPages(pages, lines, W)).toEqual([10]);
  });

  it('does not take a story page for credits', () => {
    // One promo-like line on the last page, and site lines on a page in the middle.
    const lines = [line(10, 'PLEASE READ THIS LETTER', 'text'), line(5, 'NIGHTSCANS.NET', 'watermark'), line(5, 'TL: Kim', 'watermark')];
    expect(findCreditPages(pages, lines, W)).toEqual([]);
  });

  it("finds the publisher's Korean copyright page", () => {
    const ko = (page: number, text: string) => ({ ...line(page, '2 49e eag0', 'sfx'), readKo: text, why: `Korean "${text}"` });
    const lines = [ko(10, '본작품은저작권법에의해보호를받는저작물이므로불법복제'), ko(10, '원작각색연출')];
    expect(findCreditPages(pages, lines, W)).toEqual([10]);
  });

  it('takes every page after the end promo with it (a catalog of other series)', () => {
    const lines = [line(8, 'CHECK OUT OUR OTHER WORKS', 'text'), line(8, 'STONESCAPE.XYZ', 'watermark'), line(9, 'VALHALLA SAGA', 'text')];
    expect(findCreditPages(pages, lines, W)).toEqual([8, 9, 10]);
  });
});

describe('credit panels on a page shared with the story', () => {
  const W = 800;
  const pages: PageInfo[] = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, file: `${i + 1}.jpg`, y0: i * 1000, y1: (i + 1) * 1000, width: W }));
  const panel = (index: number, y0: number, y1: number): Panel => ({
    id: `p${index}`, index, y0, y1, contentY0: y0, contentY1: y1, role: 'art', reader: true, top: 'gutter', bottom: 'gutter',
    heads: 0, persons: 0, textBlocks: 0, artFrac: 0.5, pages: [], tall: false, shotIds: [],
  });
  const text = (y: number, read: string, kind: TextLine['kind'] = 'text'): TextLine => ({
    x0: 100, y0: y, x1: 600, y1: y + 40, score: 0.9, kind, read, readConf: 0.9, why: `reads "${read}"`, bg: 255, bgFrac: 0.9, inkFrac: 0.2,
  });

  it('keeps the first story panel that shares the promo page', () => {
    // Page 1: a merger announcement, then the story's first caption, then art running onto page 2.
    const panels = [panel(1, 0, 400), panel(2, 500, 700), panel(3, 800, 2500)];
    const lines = [text(50, 'MERGER ANNOUNCEMENT'), text(100, 'NIGHT SCANS AND AURORA SCANS JOINED FORCES'), text(600, 'MONSTERS MANIFEST IN THE WORLD.')];
    const credits = creditPanels(panels, pages, [1], lines);
    expect(credits.map((p) => p.index)).toEqual([1]);
  });

  it('counts a promo line whose box sticks out of the panel by a few pixels', () => {
    // "Read on FLAME.COM" starts 7 px above the panel's content rows (text boxes are padded).
    const panels = [panel(10, 9000, 9500), panel(11, 9607, 9740), panel(12, 9800, 10000)];
    const lines = [text(9200, 'THE METRO IS DEPARTING.'), text(9600, '> Read on FLAMECOMICS.COM', 'watermark'), text(9640, 'for faster updates.', 'watermark'), text(9850, 'CARROT OON')];
    const blocks: TextBlock[] = [{ id: 0, lines: [0], text: { x0: 100, y0: 9200, x1: 600, y1: 9240 }, bubble: { x0: 80, y0: 9150, x1: 620, y1: 9300 }, zone: { x0: 80, y0: 9150, x1: 620, y1: 9300 } }];
    const credits = creditPanels(panels, pages, [10], lines, blocks);
    expect(credits.map((p) => p.index)).toEqual([11, 12]);
  });

  it('keeps the last story balloon that shares the end promo page', () => {
    const panels = [panel(10, 9000, 9500), panel(11, 9600, 10000)];
    const lines = [text(9200, 'I REALLY WANT TO TASTE YOUR BLOOD.'), text(9700, 'READ ONLY AT THUNDERSCANS'), text(9800, 'DISCORD.GG/ABC', 'watermark')];
    const blocks: TextBlock[] = [{ id: 0, lines: [0], text: { x0: 100, y0: 9200, x1: 600, y1: 9240 }, bubble: { x0: 80, y0: 9150, x1: 620, y1: 9300 }, zone: { x0: 80, y0: 9150, x1: 620, y1: 9300 } }];
    const credits = creditPanels(panels, pages, [10], lines, blocks);
    expect(credits.map((p) => p.index)).toEqual([11]);
  });
});
