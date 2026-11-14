import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LineReading } from './detect/reader.ts';
import { paths } from './library.ts';
import type { TextLineKind } from './types.ts';

/**
 * Site names, URLs and scanlation credits, matched on the English reading. Written for any source,
 * not a list of groups: domains, link words, "<name>scans", credit roles, promo phrases.
 */
const CREDIT_PATTERNS: RegExp[] = [
  // Domains whose ending is not an English word; OCR may put a space around the dot, or read the
  // ".com" under a logo as a line of its own.
  /[a-z0-9]\s?\.\s?(com|net|org|xyz|io|gg)\b|^\W*\.\s?(com|net|org|xyz|io|gg)\b/i,
  // Endings that are also words ("to", "me", "one", "fun") count only when written as a domain.
  /[a-z0-9]\.(me|to|co|cc|tv|us|info|site|online|club|fun|top|live|app|dev|moe|lol|vip|pro|art|ink|space|world|one|link|biz)\b/i,
  /https?:|www\.|discord|patreon|ko-?fi|paypal|buy ?me ?a ?coffee/i,
  // Group names written as one word: "ASURASCANS", "REAPERSCANS". ("HE SCANS THE ROOM" is not.)
  /[a-z]scans\b/i,
  // "Read at ...", "for more chapters", "translated by"
  /^\W*read (it |this |more |the latest )?(at|on)\b|(read|for) (the )?(latest|more|next|new|early) chapters?|translated by|scanlat(ed|ion|or)|raw provider/i,
  // Credit roles: "TL: Haz", "PR - Ann". A stutter ("PR-PRINCE") has no space after the hyphen.
  /\b(tl|pr|ed|qc|ts|cl|rd|rp|raws?|typeset(ter)?|clean(er)?|translat(or|ion)|proofread(er)?|redraw(er)?|editor)\s*(:|-\s)/i,
];

/** One pattern for a list of group or site names. Spaces inside a name are optional. */
export function nameMatcher(names: string[]): RegExp | null {
  const parts = names
    .map((n) => n.trim())
    .filter((n) => n.length >= 3)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
  return parts.length ? new RegExp(`\\b(${parts.join('|')})\\b`, 'i') : null;
}

/**
 * Extra source names from data/sources.json, for a group whose watermark is a bare name the
 * patterns above miss: { "names": ["Some Group", "Other Site"] }.
 */
let extraNames: RegExp | null | undefined;
function sourceNames(): RegExp | null {
  if (extraNames !== undefined) return extraNames;
  const file = path.join(paths.data, 'sources.json');
  if (!existsSync(file)) return (extraNames = null);
  try {
    const { names } = JSON.parse(readFileSync(file, 'utf8')) as { names?: string[] };
    return (extraNames = nameMatcher(names ?? []));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
  }
}

/** Does this reading look like a site name, URL or scanlation credit? */
export function isCreditText(text: string, names: RegExp | null = sourceNames()): boolean {
  return CREDIT_PATTERNS.some((re) => re.test(text)) || (names !== null && names.test(text));
}

export interface LetteringVerdict {
  kind: TextLineKind;
  /** Why the line got its kind; shown in the viewer. */
  why: string;
}

const HANGUL_RE = /[\uAC00-\uD7A3\u3131-\u318E]/;

/**
 * Decide what an OCR line is from what it reads as.
 * - dialogue: readable English words of normal line height
 * - credit: a site name, URL or scanlation credit
 * - sfx: Korean lettering, or a glyph too tall to be a dialogue line
 * - noise: not readable as text at all (strokes of a face, hair, texture)
 */
export function judgeLettering(r: LineReading, lineHeight: number, stripWidth: number): LetteringVerdict {
  const en = r.en.text;
  const nonSpace = en.replace(/\s/g, '');
  const letters = (en.match(/[A-Za-z]/g) ?? []).length;
  const hangul = HANGUL_RE.test(r.ko.text) && r.ko.conf >= 0.5;
  const tall = lineHeight > 0.12 * stripWidth;

  if (r.en.conf >= 0.6 && isCreditText(en)) return { kind: 'watermark', why: `reads "${en}"` };
  const english = r.en.conf >= 0.6 && letters >= 2 && letters >= 0.5 * nonSpace.length && !(hangul && r.ko.conf > r.en.conf);
  if (english) {
    // Height alone does not decide: shouted dialogue and captions are often as tall as sound
    // effects. A very tall single word the reader is unsure of is a sound effect.
    if (lineHeight > 0.2 * stripWidth && !/\s/.test(en.trim()) && r.en.conf < 0.9) {
      return { kind: 'sfx', why: `large single word "${en}"` };
    }
    return { kind: 'text', why: `reads "${en}"` };
  }
  // Stylised fonts can defeat the English model; the second model's Latin reading is the fallback.
  const ko = r.ko.text;
  const latin = (ko.match(/[A-Za-z]/g) ?? []).length;
  if (r.ko.conf >= 0.7 && latin >= 5 && latin >= 0.7 * ko.replace(/\s/g, '').length) {
    return { kind: 'text', why: `reads "${ko}" (second model)` };
  }
  if (hangul) return { kind: 'sfx', why: `Korean "${r.ko.text}"` };
  return { kind: 'noise', why: tall ? 'large unreadable lettering (sound effect)' : 'not readable' };
}
