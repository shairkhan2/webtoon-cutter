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
 * Panels to leave out as credits. A credits block is a short run of panels at the very start or
 * the very end of the chapter, and the story begins where it ends. So walk the panels from each
 * end of the chapter towards the middle, over panels on a credit page: a panel holding a promo
 * line belongs to the block (and with it any blank or text-only panel before it); the first story
 * panel ends the walk. A story panel has a drawn person (head or person detection) or a speech
 * balloon, and no promo line of its own.
 *
 * This works on panels, not on whole source pages. A chapter can come as two or three very tall
 * images, so its first 3 and last 5 pages can be the whole chapter; and a site watermark lettered
 * into the art deep inside the story is a promo line too. "Every panel on a credit page up to the
 * last promo line" then took the story with it. The result is never every panel: a chapter
 * cannot consist of credits.
 */
export function creditPanels(
  panels: Panel[],
  pages: PageInfo[],
  creditPages: number[],
  lines: TextLine[],
  blocks: TextBlock[] = [],
): Panel[] {
  // A line belongs to the panel its centre is in: text boxes are padded and can stick out a few
  // pixels past the panel's content rows.
  const centreIn = (r: { y0: number; y1: number }, p: Panel) => (r.y0 + r.y1) / 2 >= p.contentY0 && (r.y0 + r.y1) / 2 < p.contentY1;
  const hasPromo = (p: Panel) => lines.some((l) => centreIn(l, p) && isPromoLine(l));
  const balloon = (p: Panel) => blocks.some((b) => b.bubble !== null && centreIn(b.text, p));
  const story = (p: Panel) => !hasPromo(p) && (p.heads > 0 || p.persons > 0 || balloon(p));
  const credit = new Set(creditPages);
  const onCreditPage = (p: Panel) => pages.some((pg) => credit.has(pg.index) && p.contentY1 > pg.y0 && p.contentY0 < pg.y1);

  // How many panels at the start of `seq` (read from the chapter's edge inwards) are credits.
  const run = (seq: Panel[]): number => {
    let last = -1;
    for (const [i, p] of seq.entries()) {
      if (!onCreditPage(p) || story(p)) break;
      if (hasPromo(p)) last = i;
    }
    return last + 1;
  };

  const head = run(panels);
  const rest = panels.slice(head);
  const tail = run([...rest].reverse());
  const out = [...panels.slice(0, head), ...rest.slice(rest.length - tail)];
  // Never the whole chapter: if nothing in it reads as story, the detections failed, not the art.
  return out.length >= panels.length ? [] : out;
}
