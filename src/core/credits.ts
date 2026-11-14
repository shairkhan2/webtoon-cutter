import type { PageInfo, Panel, TextBlock, TextLine } from './types.ts';

/** Scanlation credits, promo and publisher pages sit at the start and the end of a chapter. */
const HEAD_PAGES = 3;
const TAIL_PAGES = 5;

/**
 * Promo wording, counted only on those pages. Story dialogue rarely says these, and almost never
 * twice on one end page: "thanks for reading", "join our Discord", "read it on our website",
 * recruiting, donations, "exclusively on", "faster updates", "dear readers", a list of roles,
 * a group name with "scans", the publisher's staff page ("PD", "Studio").
 */
const PROMO_RE = new RegExp(
  [
    'thanks? ?(you )?for reading',
    'please (read|support)',
    'continue reading',
    'read (this|the) (chapter|novel|rest|series)',
    'read (it |this )?(only|from|on)\\b',
    '^\\W*read\\s+a?t\\b',
    'make sure (that )?you',
    '(on|at|from) (this|our|the official) (web)?site',
    'official (web)?site',
    'previews? of the original',
    'please buy',
    'buy the (comic|original|raws?)',
    'launch(ing|es|ed)? on',
    'please look forward',
    'release faster',
    'join (our|us on)',
    'let us know',
    'support (us|our|the (artist|author|creator))',
    // "WE ARE RECRUITING", not a file named New_Recruit_Orientation in the story.
    '\\brecruit(ing|ment)\\b',
    'donat(e|ion)',
    'early access',
    'advance chapters?',
    'exclusive(ly)?\\b',
    '(faster|fast|quick) (updates?|releases?)',
    'more (content|chapters)',
    'better quality',
    'dear readers',
    'happy reading',
    'unlock',
    'announcement',
    'joined forces',
    'check (out )?our',
    'other works',
    'brought to you',
    'do not repost',
    'purchas(e|ing) (the )?raws',
    'discover more',
    'chapters? up to',
    '\\bscans\\b',
    '^\\W*(pd|studios?|staff|credits?|links?)\\W*$',
    '^\\W*(translat(or|ors|ion)|proofread(er|ing)?|typeset(ter|ting)?|clean(er|ing)?|redraw(er|ing)?|quality check(er)?|editors?|raw provider|cleaner\\/redrawer)\\W*$',
    '\\bUCI\\s*:',
  ].join('|'),
  'i',
);

/** Korean publisher pages: copyright notice and staff roles (원작 original, 각색 adaptation, ...). */
const KO_CREDIT_RE = /저작권|무단|불법|복제|원작|각색|연출|채색|선화|식자|총괄|제작/;

/** Site lines (reads as a domain, link or credit role) and promo or publisher lines. */
export function isPromoLine(l: TextLine): boolean {
  if (l.kind === 'watermark' && l.why.startsWith('reads')) return true;
  if (l.read && PROMO_RE.test(l.read)) return true;
  const ko = l.readKo ?? /Korean "(.*)"/.exec(l.why)?.[1] ?? '';
  return KO_CREDIT_RE.test(ko);
}

/**
 * Credit and promo pages among the first 3 and last 5: a page with two or more promo lines, or
 * one large site line (a banner). Promo comes last in a chapter (first at the start), so every
 * page after the last such page at the end, and before the first one at the start, goes too.
 */
export function findCreditPages(pages: PageInfo[], lines: TextLine[], width: number): number[] {
  const isCredit = (p: PageInfo) => {
    const onPage = lines.filter((l) => l.y0 >= p.y0 && l.y1 <= p.y1 + 4);
    const promo = onPage.filter(isPromoLine);
    const large = promo.some((l) => l.kind === 'watermark' && l.y1 - l.y0 >= 0.08 * width);
    return promo.length >= 2 || large;
  };
  const out = new Set<number>();
  const head = pages.slice(0, Math.min(HEAD_PAGES, pages.length));
  const lastHead = head.map(isCredit).lastIndexOf(true);
  for (let i = 0; i <= lastHead; i++) out.add(head[i].index);
  const tailStart = Math.max(head.length, pages.length - TAIL_PAGES);
  const tail = pages.slice(tailStart);
  const firstTail = tail.map(isCredit).indexOf(true);
  if (firstTail >= 0) for (const p of tail.slice(firstTail)) out.add(p.index);
  return [...out].sort((a, b) => a - b);
}

/**
 * Panels to leave out as credits, among those mostly on a credit page. The story starts or ends
 * on the same page as the promo, so reading order decides: at the start of the chapter, every
 * panel up to the last one holding a promo line; at the end, every panel from the first one
 * holding a promo line, except panels with a speech balloon and no promo line (story dialogue
 * between promo lines). A credit page without any promo panel is left out whole.
 */
export function creditPanels(
  panels: Panel[],
  pages: PageInfo[],
  creditPages: number[],
  lines: TextLine[],
  blocks: TextBlock[] = [],
): Panel[] {
  const headPages = new Set(creditPages.filter((i) => pages.findIndex((p) => p.index === i) < HEAD_PAGES));
  const onPages = (p: Panel, set: Set<number>) =>
    pages
      .filter((pg) => set.has(pg.index))
      .reduce((s, pg) => s + Math.max(0, Math.min(pg.y1, p.contentY1) - Math.max(pg.y0, p.contentY0)), 0) >=
    0.5 * (p.contentY1 - p.contentY0);
  // A line belongs to the panel its centre is in: text boxes are padded and can stick out a few
  // pixels past the panel's content rows.
  const centreIn = (r: { y0: number; y1: number }, p: Panel) => (r.y0 + r.y1) / 2 >= p.contentY0 && (r.y0 + r.y1) / 2 < p.contentY1;
  const inside = (p: Panel) => lines.filter((l) => centreIn(l, p));
  const hasPromo = (p: Panel) => inside(p).some(isPromoLine);
  // The page holding most of a panel: does it carry promo lines of its own (not only follow one)?
  const mainPage = (p: Panel) =>
    pages.reduce((a, b) =>
      Math.min(b.y1, p.contentY1) - Math.max(b.y0, p.contentY0) > Math.min(a.y1, p.contentY1) - Math.max(a.y0, p.contentY0) ? b : a,
    );
  const promoPage = (pg: PageInfo) => lines.filter((l) => l.y0 >= pg.y0 && l.y1 <= pg.y1 + 4 && isPromoLine(l)).length >= 2;
  // Story dialogue swept in after the end promo starts: a balloon, no promo line, on a page that
  // has none of its own (a catalog title box on a promo page is not story).
  const storyBalloon = (p: Panel) =>
    !hasPromo(p) &&
    !promoPage(mainPage(p)) &&
    blocks.some((b) => b.bubble !== null && centreIn(b.text, p));
  // A promo panel can sit mostly on the page next to the credit page ("check out our other works").
  const touches = (p: Panel, set: Set<number>) => pages.some((pg) => set.has(pg.index) && p.contentY1 > pg.y0 && p.contentY0 < pg.y1);
  const promoPanel = (p: Panel, set: Set<number>) => touches(p, set) && inside(p).filter(isPromoLine).length >= 2;
  const near = (p: Panel, set: Set<number>) => onPages(p, set) || promoPanel(p, set);

  const out: Panel[] = [];
  const head = panels.filter((p) => near(p, headPages));
  if (head.length) {
    const last = head.map(hasPromo).lastIndexOf(true);
    out.push(...(last >= 0 ? head.slice(0, last + 1) : head));
  }
  const tailPages = new Set(creditPages.filter((i) => !headPages.has(i)));
  const tail = panels.filter((p) => near(p, tailPages));
  if (tail.length) {
    const first = tail.map(hasPromo).indexOf(true);
    out.push(...(first >= 0 ? tail.slice(first).filter((p) => !storyBalloon(p)) : tail));
  }
  return out;
}
