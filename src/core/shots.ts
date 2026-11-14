/**
 * Video shot planner: picks 0, 1 or more 16:9-friendly shots inside each art panel, the way an
 * editor frames a recap video ("Video shot rules"):
 * - a face is either whole in a shot or not in it; hair may be trimmed a little, the chin never;
 * - a shot needs a focus: a whole face, a body with its upper part, or drawn detail;
 * - a body fragment (legs under a face that is in another shot) is not a focus;
 * - a little balloon is fine; a lot of balloon compared with the face is not;
 * - no empty stretches; long panels become several shots, empty parts are dropped.
 * A shot is a box shown whole in the 16:9 frame, as in the reference recap video. The sweet spot is
 * a 9:16 box (900×1600 at W = 900) holding as much of the panel's art as fits, a little balloon
 * included; up to 7% taller when that shows something whole. Two people a single box can hold get
 * one box, not two shots.
 * Candidate edges come from subjects (head top, framing lines under the chin, body ends), dialogue
 * zones and content boundaries. The best non-overlapping set per panel is chosen by weighted
 * interval scheduling, then neighbouring shots that one box can replace are merged.
 */
import { config } from './config.ts';
import { area, intersect, iou, median, union } from './geometry.ts';
import type { DetailMap } from './interest.ts';
import type {
  Detection,
  FrameLine,
  PageInfo,
  Panel,
  Rect,
  Shot,
  ShotFocus,
  ShotFraming,
  ShotReject,
  TextBlock,
  TextLine,
} from './types.ts';

export interface ShotInput {
  width: number;
  height: number;
  detail: DetailMap;
  faces: Detection[];
  heads: Detection[];
  persons: Detection[];
  blocks: TextBlock[];
  lines: TextLine[];
  frameLines: FrameLine[];
  pages: PageInfo[];
}

interface Subject {
  face: Rect | null;
  head: Rect | null;
  body: Rect | null;
  f: number; // face height: the ruler for framing
  chin: number;
}

type Candidate = Omit<Shot, 'id' | 'index' | 'panelId' | 'panelIndex' | 'file' | 'motion' | 'pages'> & {
  /** Indexes of the subjects the shot shows (whole face, head, or a body with its top). */
  who: number[];
  /**
   * Score without the size (art kept) term. Which people get a shot is decided on this, so a big box
   * cannot crowd out a small second character; `score` then picks how big each shot is.
   */
  base: number;
};
type Evaluation = Candidate | { reject: ShotReject; note?: string };

/** Height of a box in 16:9 screens at its own width, from its shape (width / height). */
const screensOfBox = (aspect: number) => 16 / (9 * aspect);

const inter = (a: Rect, b: Rect) => {
  const i = intersect(a, b);
  return i ? area(i) : 0;
};
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Summed-area tables over the detail map, so any rectangle's detail is O(1). */
class DetailIndex {
  readonly size: number;
  private readonly iso: Float64Array;
  private readonly busy: Float64Array;
  /** 1 per detail cell that is busy (iso or ink >= 0.02), row-major. */
  readonly busyFlags: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  private readonly wsum: Float64Array;
  private readonly wx: Float64Array;
  private readonly wy: Float64Array;
  private readonly bcols: number;
  private readonly bm: Float64Array; // 2x2-cell block means
  private readonly bm2: Float64Array;

  constructor(d: DetailMap) {
    this.size = d.size;
    this.cols = d.cols;
    this.rows = d.rows;
    this.busyFlags = new Uint8Array(d.cols * d.rows);
    const W1 = d.cols + 1;
    this.iso = new Float64Array(W1 * (d.rows + 1));
    this.busy = new Float64Array(W1 * (d.rows + 1));
    this.wsum = new Float64Array(W1 * (d.rows + 1));
    this.wx = new Float64Array(W1 * (d.rows + 1));
    this.wy = new Float64Array(W1 * (d.rows + 1));
    for (let y = 0; y < d.rows; y++) {
      for (let x = 0; x < d.cols; x++) {
        const c = y * d.cols + x;
        const w = d.iso[c] + d.ink[c];
        const i = (y + 1) * W1 + (x + 1);
        const add = (t: Float64Array, v: number) => (t[i] = v + t[i - 1] + t[i - W1] - t[i - W1 - 1]);
        add(this.iso, d.iso[c]);
        this.busyFlags[c] = d.iso[c] >= 0.02 || d.ink[c] >= 0.02 ? 1 : 0;
        add(this.busy, this.busyFlags[c]);
        add(this.wsum, w);
        add(this.wx, w * (x + 0.5) * d.size);
        add(this.wy, w * (y + 0.5) * d.size);
      }
    }
    this.bcols = d.cols >> 1;
    const brows = d.rows >> 1;
    const B1 = this.bcols + 1;
    this.bm = new Float64Array(B1 * (brows + 1));
    this.bm2 = new Float64Array(B1 * (brows + 1));
    for (let y = 0; y < brows; y++) {
      for (let x = 0; x < this.bcols; x++) {
        const c = 2 * y * d.cols + 2 * x;
        const m = (d.mean[c] + d.mean[c + 1] + d.mean[c + d.cols] + d.mean[c + d.cols + 1]) / 4;
        const i = (y + 1) * B1 + (x + 1);
        this.bm[i] = m + this.bm[i - 1] + this.bm[i - B1] - this.bm[i - B1 - 1];
        this.bm2[i] = m * m + this.bm2[i - 1] + this.bm2[i - B1] - this.bm2[i - B1 - 1];
      }
    }
  }

  private sum(t: Float64Array, w1: number, x0: number, y0: number, x1: number, y1: number): number {
    return t[y1 * w1 + x1] - t[y0 * w1 + x1] - t[y1 * w1 + x0] + t[y0 * w1 + x0];
  }

  of(r: Rect) {
    const s = this.size;
    const x0 = Math.max(0, Math.floor(r.x0 / s));
    const x1 = Math.min(this.cols, Math.ceil(r.x1 / s));
    const y0 = Math.max(0, Math.floor(r.y0 / s));
    const y1 = Math.min(this.rows, Math.ceil(r.y1 / s));
    const W1 = this.cols + 1;
    const n = Math.max(1, (x1 - x0) * (y1 - y0));
    const iso = this.sum(this.iso, W1, x0, y0, x1, y1) / n;
    const busyArea = this.sum(this.busy, W1, x0, y0, x1, y1) * s * s;
    const w = this.sum(this.wsum, W1, x0, y0, x1, y1);
    const centre = w
      ? { x: Math.round(this.sum(this.wx, W1, x0, y0, x1, y1) / w), y: Math.round(this.sum(this.wy, W1, x0, y0, x1, y1) / w) }
      : { x: Math.round((r.x0 + r.x1) / 2), y: Math.round((r.y0 + r.y1) / 2) };
    const B1 = this.bcols + 1;
    const bx0 = Math.ceil(x0 / 2);
    const bx1 = Math.max(bx0, Math.floor(x1 / 2));
    const by0 = Math.ceil(y0 / 2);
    const by1 = Math.max(by0, Math.floor(y1 / 2));
    const bn = Math.max(1, (bx1 - bx0) * (by1 - by0));
    const mu = this.sum(this.bm, B1, bx0, by0, bx1, by1) / bn;
    const contrast = Math.sqrt(Math.max(0, this.sum(this.bm2, B1, bx0, by0, bx1, by1) / bn - mu * mu));
    return { iso, busyArea, contrast, centre };
  }
}

/**
 * People in the panel: faces matched to heads, heads matched to bodies. Boxes are clipped to the
 * panel; a box mostly outside it is the neighbouring panel's (its sliver here is no subject).
 */
/**
 * R2b (config.shots.dropObjectHeads): head detections that are objects on a person. H is dropped when
 * no face is centred in it, its score is below 0.5, and some person box holds the centre of H and the
 * centre of another head G with a higher score whose centre is above H's (a coffee cup seen as a
 * head). Works on the detections before clipping, which drops the score.
 */
export function objectHeads(heads: Detection[], faces: Detection[], persons: Detection[]): Detection[] {
  const centre = (r: Rect) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });
  const holds = (b: Rect, p: { x: number; y: number }) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
  return heads.filter((h) => {
    if (h.score >= 0.5) return false;
    const hc = centre(h);
    if (faces.some((f) => holds(h, centre(f)))) return false;
    return persons.some((p) => holds(p, hc) && heads.some((g) => g !== h && g.score > h.score && centre(g).y < hc.y && holds(p, centre(g))));
  });
}

function buildSubjects(input: ShotInput, band: Rect): Subject[] {
  const minInside = config.shots.minSubjectInside;
  const clip = (d: Rect) => {
    const r = intersect(d, band);
    return r && r.y1 - r.y0 >= minInside * (d.y1 - d.y0) ? r : null;
  };
  const keep = (r: Rect | null): r is Rect => !!r && area(r) > 0;
  const faces = input.faces.map(clip).filter(keep);
  const dropped = config.shots.dropObjectHeads ? new Set(objectHeads(input.heads, input.faces, input.persons)) : null;
  const heads = input.heads.filter((h) => !dropped?.has(h)).map(clip).filter(keep);
  const persons = input.persons
    .filter((p) => p.y1 - p.y0 >= 0.08 * input.width)
    .map(clip)
    .filter(keep);
  const centerIn = (a: Rect, b: Rect) => {
    const cx = (a.x0 + a.x1) / 2;
    const cy = (a.y0 + a.y1) / 2;
    return cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1;
  };
  const usedFace = new Set<number>();
  const usedPerson = new Set<number>();
  const subjects: Subject[] = [];
  for (const head of heads) {
    let fi = -1;
    for (const [i, fc] of faces.entries()) {
      if (!usedFace.has(i) && centerIn(fc, head) && (fi < 0 || area(fc) > area(faces[fi]))) fi = i;
    }
    const face = fi >= 0 ? faces[fi] : null;
    if (fi >= 0) usedFace.add(fi);
    let body: Rect | null = null;
    for (const [i, p] of persons.entries()) {
      if (usedPerson.has(i)) continue;
      if (centerIn(head, p) && (head.y0 + head.y1) / 2 <= p.y0 + 0.6 * (p.y1 - p.y0)) {
        body = p;
        usedPerson.add(i);
        break;
      }
    }
    const hh = head.y1 - head.y0;
    subjects.push({ face, head, body, f: face ? face.y1 - face.y0 : 0.75 * hh, chin: face ? face.y1 : head.y1 - 0.1 * hh });
  }
  // Faces the head detector missed: estimate the head around them.
  for (const [i, fc] of faces.entries()) {
    if (usedFace.has(i)) continue;
    const f = fc.y1 - fc.y0;
    const fw = fc.x1 - fc.x0;
    const head = intersect({ x0: fc.x0 - 0.25 * fw, y0: fc.y0 - 0.6 * f, x1: fc.x1 + 0.25 * fw, y1: fc.y1 + 0.1 * f }, band);
    subjects.push({ face: fc, head, body: null, f, chin: fc.y1 });
  }
  for (const [i, p] of persons.entries()) {
    if (usedPerson.has(i)) continue;
    // A second box around a character who already has a head is the same person, not a new one.
    const owner = subjects.find((s) => s.head && (centerIn(s.head, p) || (s.body !== null && iou(s.body, p) > 0.3)));
    if (owner) owner.body = owner.body ? union(owner.body, p) : p;
    else subjects.push({ face: null, head: null, body: p, f: 0.12 * (p.y1 - p.y0), chin: p.y0 });
  }
  return subjects;
}

/** The slanted frame line at a panel edge, if that edge is a slanted border. */
function slantedBorder(lines: FrameLine[], y: number, width: number): FrameLine | null {
  for (const l of lines) {
    const slant = Math.abs(l.yRight - l.yLeft);
    if (slant < 0.01 * width) continue;
    if (Math.abs(y - (l.yLeft + l.yRight) / 2) <= slant / 2 + 0.04 * width) return l;
  }
  return null;
}

/** Area of rect r on the far side of line l (above it when `above`, else below it). */
function areaBeyond(r: Rect, l: FrameLine, width: number, above: boolean): number {
  let a = 0;
  for (let x = r.x0; x < r.x1; x += 8) {
    const w = Math.min(8, r.x1 - x);
    const y = l.yLeft + ((l.yRight - l.yLeft) * (x + w / 2)) / width;
    a += w * (above ? Math.max(0, Math.min(y, r.y1) - r.y0) : Math.max(0, r.y1 - Math.max(y, r.y0)));
  }
  return a;
}

/** The sweet-spot box (9:16) and the largest box allowed, in 16:9 screens at the shot's width. */
const SWEET_SCREENS = screensOfBox(config.shots.sweetBox);
const LARGEST_SCREENS = SWEET_SCREENS * (1 + config.shots.maxOverSweet);
/** Fixed shot lengths tried from every candidate edge, up to the sweet spot. */
const WINDOW_SCREENS = [1, 1.5, 2, 2.5, SWEET_SCREENS];
/** Framing lines under the chin, in face heights: chest, lower chest, waist, hips, knees. */
const FRAMING_LINES = [1.25, 2.0, 3.0, 4.0, 6.0];

class PanelPlanner {
  private readonly cfg = config.shots;
  private readonly W: number;
  private readonly band: Rect;
  private readonly subjects: Subject[];
  private readonly zones: Rect[];
  /** Zones of blocks R2a demoted: still offer side crops and edges, protect nothing. */
  private readonly formerZones: Rect[];
  private readonly formerLines: TextLine[];
  /** R1 guard: per subject, true when its body box is a group box (holds another person's head beside it). */
  private readonly groupBody: boolean[];
  /** R1 floor: per subject, the highest detector confidence among the person boxes in its body box. */
  private readonly bodyConf: number[];
  private readonly dialogue: TextLine[];
  private readonly sfx: TextLine[];
  private readonly marks: TextLine[];
  private readonly topLine: FrameLine | null;
  private readonly bottomLine: FrameLine | null;
  private readonly busyCache = new Map<string, Uint8Array>();
  private readonly artCache = new Map<string, { prefix: Int32Array; best: number }>();
  private cellTable: Int32Array | null = null;
  private balloons: { sat: Int32Array; cy0: number; cols: number; rows: number } | null = null;
  /** Largest candidate area rejected for each reason. */
  private readonly rejectArea = new Map<ShotReject, number>();
  private readonly input: ShotInput;
  private readonly detail: DetailIndex;

  /** R3: second detail map (signs not masked) for the b-roll focus test only. */
  private readonly signs: DetailIndex;

  constructor(input: ShotInput, detail: DetailIndex, panel: Panel, signs: DetailIndex = detail) {
    this.input = input;
    this.detail = detail;
    this.signs = signs;
    this.W = input.width;
    this.band = { x0: 0, y0: panel.contentY0, x1: input.width, y1: panel.contentY1 };
    this.subjects = buildSubjects(input, this.band);
    this.zones = input.blocks.map((b) => b.zone).filter((z) => intersect(z, this.band));
    const inBand = (l: TextLine) => !!intersect(l, this.band);
    this.formerLines = input.lines.filter((l) => l.formerZone && inBand(l));
    this.formerZones = this.formerLines.map((l) => l.formerZone as Rect).filter((z) => intersect(z, this.band));
    this.groupBody = this.subjects.map((s, i) => {
      const b = s.body;
      if (!b) return false;
      return this.subjects.some((o, j) => {
        if (j === i || !o.head) return false;
        const cx = (o.head.x0 + o.head.x1) / 2;
        const cy = (o.head.y0 + o.head.y1) / 2;
        if (cx < b.x0 || cx > b.x1 || cy < b.y0 || cy > b.y1) return false;
        return !s.head || cx < s.head.x0 || cx > s.head.x1;
      });
    });
    this.bodyConf = this.subjects.map((s) => {
      const b = s.body;
      if (!b) return 0;
      let best = 0;
      for (const p of input.persons) {
        const r = intersect(p, this.band);
        if (r && area(r) > 0 && inter(r, b) >= 0.9 * area(r)) best = Math.max(best, p.score);
      }
      return best;
    });
    this.dialogue = input.lines.filter((l) => l.kind === 'text' && inBand(l));
    this.sfx = input.lines.filter((l) => l.kind === 'sfx' && inBand(l));
    this.marks = input.lines.filter((l) => l.kind === 'watermark' && inBand(l));
    this.topLine = panel.top === 'border' ? slantedBorder(input.frameLines, panel.contentY0, this.W) : null;
    this.bottomLine = panel.bottom === 'border' ? slantedBorder(input.frameLines, panel.contentY1, this.W) : null;
  }

  /**
   * Summed-area table over the panel's detail cells (16 px) that are balloon on screen: inside a
   * balloon zone and of the balloon's colour, or under its lettering. A balloon's bounding box
   * overstates it: a round balloon fills ~80% of its box, and the corners hold art or margin.
   */
  private balloonTable(): { sat: Int32Array; cy0: number; cols: number; rows: number } {
    const d = this.input.detail;
    const s = d.size;
    const cy0 = Math.floor(this.band.y0 / s);
    const rows = Math.max(0, Math.min(d.rows, Math.ceil(this.band.y1 / s)) - cy0);
    const cols = d.cols;
    const tol = config.text.balloonTolerance;
    const blocks = this.input.blocks
      .filter((b) => intersect(b.zone, this.band))
      .map((b) => {
        const bgs = b.lines.map((i) => this.input.lines[i]?.bg).filter((v): v is number => typeof v === 'number');
        return { zone: b.zone, text: b.text, bg: bgs.length ? median(bgs) : 245 };
      });
    const W1 = cols + 1;
    const sat = new Int32Array(W1 * (rows + 1));
    for (let y = 0; y < rows; y++) {
      const py = (cy0 + y + 0.5) * s;
      for (let x = 0; x < cols; x++) {
        const px = (x + 0.5) * s;
        let on = 0;
        for (const b of blocks) {
          const z = b.zone;
          if (px < z.x0 || px >= z.x1 || py < z.y0 || py >= z.y1) continue;
          const t = b.text;
          const inText = px >= t.x0 && px < t.x1 && py >= t.y0 && py < t.y1;
          if (inText || Math.abs(d.mean[(cy0 + y) * cols + x] - b.bg) <= tol) {
            on = 1;
            break;
          }
        }
        const i = (y + 1) * W1 + (x + 1);
        sat[i] = on + sat[i - 1] + sat[i - W1] - sat[i - W1 - 1];
      }
    }
    return { sat, cy0, cols, rows };
  }

  /** Balloon area on screen inside r: balloon cells whose centre is in r, in pixels. */
  private balloonArea(r: Rect): number {
    const t = (this.balloons ??= this.balloonTable());
    const s = this.input.detail.size;
    const x0 = Math.max(0, Math.ceil(r.x0 / s - 0.5));
    const x1 = Math.min(t.cols, Math.ceil(r.x1 / s - 0.5));
    const y0 = Math.max(0, Math.ceil(r.y0 / s - 0.5) - t.cy0);
    const y1 = Math.min(t.rows, Math.ceil(r.y1 / s - 0.5) - t.cy0);
    if (x1 <= x0 || y1 <= y0) return 0;
    const W1 = t.cols + 1;
    return (t.sat[y1 * W1 + x1] - t.sat[y0 * W1 + x1] - t.sat[y1 * W1 + x0] + t.sat[y0 * W1 + x0]) * s * s;
  }

  /** Per detail row inside the panel: 1 when the row holds a subject or drawn detail within [x0, x1). */
  private busyRows(x0: number, x1: number): Uint8Array {
    const key = `${x0}:${x1}`;
    const hit = this.busyCache.get(key);
    if (hit) return hit;
    const s = this.detail.size;
    const cy0 = Math.floor(this.band.y0 / s);
    const cy1 = Math.ceil(this.band.y1 / s);
    const out = new Uint8Array(cy1 - cy0);
    for (let cy = cy0; cy < cy1; cy++) {
      const d = this.detail.of({ x0, y0: cy * s, x1, y1: (cy + 1) * s });
      if (d.busyArea >= 0.05 * (x1 - x0) * s) out[cy - cy0] = 1;
    }
    for (const sub of this.subjects) {
      for (const r of [sub.face, sub.head, sub.body]) {
        if (!r || r.x1 <= x0 || r.x0 >= x1) continue;
        for (let cy = Math.floor(r.y0 / s); cy < Math.ceil(r.y1 / s); cy++) if (cy >= cy0 && cy < cy1) out[cy - cy0] = 1;
      }
    }
    this.busyCache.set(key, out);
    return out;
  }

  /** Share of the panel's art a box shows (rows holding a subject or drawn detail). */
  private artKept(r: Rect): number {
    const key = `${r.x0}:${r.x1}`;
    const s = this.detail.size;
    let art = this.artCache.get(key);
    if (!art) {
      const busy = this.busyRows(r.x0, r.x1);
      const prefix = new Int32Array(busy.length + 1);
      for (let i = 0; i < busy.length; i++) prefix[i + 1] = prefix[i] + busy[i];
      const largest = LARGEST_SCREENS * this.cfg.frameAspect * (r.x1 - r.x0);
      const rows = Math.min(busy.length, Math.max(1, Math.floor(largest / s)));
      let best = 0;
      for (let i = 0; i + rows <= busy.length; i++) best = Math.max(best, prefix[i + rows] - prefix[i]);
      art = { prefix, best: Math.max(1, best) };
      this.artCache.set(key, art);
    }
    const base = Math.floor(this.band.y0 / s);
    const n = art.prefix.length - 1;
    const a = Math.min(n, Math.max(0, Math.floor(r.y0 / s) - base));
    const b = Math.min(n, Math.max(a, Math.ceil(r.y1 / s) - base));
    return Math.min(1, (art.prefix[b] - art.prefix[a]) / art.best);
  }

  private cellSat: { sat: Int32Array; cy0: number; rows: number } | null = null;

  /** Busy detail cells (lettering-masked map) or cells inside a subject box, in r (summed-area table). */
  private busyCells(r: Rect): number {
    const d = this.detail;
    const s = d.size;
    if (!this.cellSat) {
      const cy0 = Math.floor(this.band.y0 / s);
      const rows = Math.max(0, Math.min(d.rows, Math.ceil(this.band.y1 / s)) - cy0);
      const W1 = d.cols + 1;
      const sat = new Int32Array(W1 * (rows + 1));
      const boxes: Rect[] = [];
      for (const sub of this.subjects) for (const b of [sub.face, sub.head, sub.body]) if (b) boxes.push(b);
      for (let y = 0; y < rows; y++) {
        const py = (cy0 + y + 0.5) * s;
        for (let x = 0; x < d.cols; x++) {
          const px = (x + 0.5) * s;
          const on = d.busyFlags[(cy0 + y) * d.cols + x] || boxes.some((b) => px >= b.x0 && px < b.x1 && py >= b.y0 && py < b.y1) ? 1 : 0;
          const i = (y + 1) * W1 + (x + 1);
          sat[i] = on + sat[i - 1] + sat[i - W1] - sat[i - W1 - 1];
        }
      }
      this.cellSat = { sat, cy0, rows };
    }
    const t = this.cellSat;
    const x0 = Math.max(0, Math.ceil(r.x0 / s - 0.5));
    const x1 = Math.min(d.cols, Math.ceil(r.x1 / s - 0.5));
    const y0 = Math.max(0, Math.ceil(r.y0 / s - 0.5) - t.cy0);
    const y1 = Math.min(t.rows, Math.ceil(r.y1 / s - 0.5) - t.cy0);
    if (x1 <= x0 || y1 <= y0) return 0;
    const W1 = d.cols + 1;
    return t.sat[y1 * W1 + x1] - t.sat[y0 * W1 + x1] - t.sat[y1 * W1 + x0] + t.sat[y0 * W1 + x0];
  }

  /** artKept, with R1b (sideArtKept): a side crop is scaled by its busy cells over the full-width box's. */
  private artKeptSide(r: Rect): number {
    const a = this.artKept(r);
    if (!this.cfg.sideArtKept || r.x1 - r.x0 >= this.W - 1) return a;
    const full = this.busyCells({ x0: 0, y0: r.y0, x1: this.W, y1: r.y1 });
    return full > 0 ? a * Math.min(1, this.busyCells(r) / full) : a;
  }

  /**
   * Full width, plus side crops that step around a balloon or an edge watermark. Watermark crops
   * are only options: a watermark costs nothing (it is blurred in the video image), and narrower
   * shots score lower, so a full-width shot through a watermark wins unless the crop is better
   * for another reason.
   */
  private xRanges(): [number, number][] {
    const W = this.W;
    const minW = this.cfg.minWidth * W;
    const pad = this.cfg.padSide * W;
    const out: [number, number][] = [[0, W]];
    for (const z of [...this.zones, ...this.formerZones]) {
      if (z.x0 - pad >= minW) out.push([0, Math.floor(z.x0 - pad)]);
      if (W - (z.x1 + pad) >= minW) out.push([Math.ceil(z.x1 + pad), W]);
    }
    for (const m of this.marks) {
      if (m.x1 >= 0.9 * W && m.x0 - 4 >= minW) out.push([0, m.x0 - 4]);
      if (m.x0 <= 0.1 * W && W - m.x1 - 4 >= minW) out.push([m.x1 + 4, W]);
    }
    return [...new Map(out.map((r) => [`${r[0]}:${r[1]}`, r])).values()];
  }

  /**
   * Candidate top and bottom edges. The natural ones (panel edges, where the art starts or ends,
   * the top of a head, the end of a body) are where a box may end when it is taller than 9:16.
   */
  private edges(): { tops: number[]; bottoms: number[]; naturalTops: Set<number>; naturalBottoms: Set<number> } {
    const { y0: P0, y1: P1 } = this.band;
    const W = this.W;
    const c = this.cfg;
    const tops = [P0];
    const bottoms = [P1];
    const natTops = [P0];
    const natBottoms = [P1];
    for (const s of this.subjects) {
      if (s.head) {
        const hh = s.head.y1 - s.head.y0;
        tops.push(s.head.y0 - c.headroom * s.f, s.head.y0, s.head.y0 + 0.2 * hh, s.head.y0 + c.hairTrim * hh);
        natTops.push(s.head.y0 - c.headroom * s.f, s.head.y0);
      }
      if (s.face) {
        tops.push(s.face.y0 - 0.25 * s.f, s.face.y0 - 0.05 * s.f);
        bottoms.push(s.chin + 0.1 * s.f, s.chin + 0.3 * s.f, s.chin + 0.6 * s.f, ...FRAMING_LINES.map((t) => s.chin + t * s.f));
      }
      if (s.body) {
        const bh = s.body.y1 - s.body.y0;
        tops.push(s.body.y0 - 0.02 * W);
        bottoms.push(s.body.y1 + 0.02 * W, s.body.y0 + 0.55 * bh);
        natBottoms.push(s.body.y1 + 0.02 * W);
        if (!s.head) natTops.push(s.body.y0 - 0.02 * W);
      }
    }
    for (const z of [...this.zones, ...this.formerZones]) {
      bottoms.push(z.y0 - c.padAbove * W);
      tops.push(z.y1 + c.padBelow * W);
    }
    // Edges inside a balloon but clear of its lettering: a little balloon edge, no text.
    for (const l of [...this.dialogue, ...this.formerLines]) {
      bottoms.push(l.y0 - 6);
      tops.push(l.y1 + 6);
    }
    // Edges at watermarks are options too (a watermark often sits where the art ends); they cost
    // nothing to pass through, so a shot only stops there when that is better anyway.
    for (const m of this.marks) {
      bottoms.push(m.y0 - 4);
      tops.push(m.y1 + 4);
    }
    if (this.topLine) {
      const y = Math.max(this.topLine.yLeft, this.topLine.yRight) + 4;
      tops.push(y);
      natTops.push(y);
    }
    if (this.bottomLine) {
      const y = Math.min(this.bottomLine.yLeft, this.bottomLine.yRight) - 4;
      bottoms.push(y);
      natBottoms.push(y);
    }
    const busy = this.busyRows(0, W);
    const size = this.detail.size;
    const base = Math.floor(P0 / size);
    for (let i = 1; i < busy.length; i++) {
      const y = (base + i) * size;
      if (busy[i] && !busy[i - 1]) tops.push(y), natTops.push(y);
      if (!busy[i] && busy[i - 1]) bottoms.push(y), natBottoms.push(y);
    }
    const snap = (v: number) => Math.round(Math.min(P1, Math.max(P0, v)));
    const clean = (list: number[]) => {
      const sorted = [...new Set(list.map(snap))].sort((a, b) => a - b);
      const out: number[] = [];
      for (const v of sorted) if (!out.length || v - out[out.length - 1] >= 8) out.push(v);
      return out;
    };
    const natural = (cleaned: number[], raw: number[]) => {
      const r = raw.map(snap);
      return new Set(cleaned.filter((v) => r.some((u) => Math.abs(u - v) < 8)));
    };
    const t = clean(tops);
    const b = clean(bottoms);
    return { tops: t, bottoms: b, naturalTops: natural(t, natTops), naturalBottoms: natural(b, natBottoms) };
  }

  private evaluate(r: Rect): Evaluation {
    const c = this.cfg;
    const W = this.W;
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    const frameH = c.frameAspect * w;
    const screens = h / frameH;
    const wholePanel = h >= 0.9 * (this.band.y1 - this.band.y0);
    if (w < c.minWidth * W - 1 || screens < (wholePanel ? c.minScreensWholePanel : c.minScreens)) return { reject: 'too_small' };
    if (screens > LARGEST_SCREENS * 1.002) return { reject: 'too_long' };

    let beyond = 0;
    if (this.topLine) beyond += areaBeyond(r, this.topLine, W, true);
    if (this.bottomLine) beyond += areaBeyond(r, this.bottomLine, W, false);
    if (beyond > c.maxNeighbourShare * area(r)) return { reject: 'crosses_border' };

    let faces = 0;
    let faceArea = 0;
    let people = 0;
    let bodyArea = 0;
    let hairTrim = 0;
    let faceNearEdge = false;
    let fragment = false;
    let mainFace: Rect | null = null;
    let mainBody: Rect | null = null;
    let onFramingLine = false; // bottom edge on a framing line under a chin, or at a body end
    let chinDepth = Infinity;
    const who: number[] = [];
    for (const [i, s] of this.subjects.entries()) {
      if (s.face) {
        const fi = inter(s.face, r) / area(s.face);
        if (fi > 0.03 && fi < 0.97) return { reject: 'cuts_face' };
        if (fi >= 0.97) {
          if (s.head) {
            const hh = s.head.y1 - s.head.y0;
            const hw = s.head.x1 - s.head.x0;
            const top = Math.max(0, r.y0 - s.head.y0) / hh;
            const side = Math.max(r.x0 - s.head.x0, s.head.x1 - r.x1, 0) / hw;
            if (top > c.hairTrim + 0.01 || side > c.sideTrim + 0.01) return { reject: 'cuts_head' };
            hairTrim = Math.max(hairTrim, top);
          }
          const below = s.f >= c.closeUpFace * frameH ? c.minBelowChinCloseUp : c.minBelowChin;
          if (r.y1 < this.band.y1 - 4 && r.y1 < s.chin + below * s.f) return { reject: 'cuts_chin' };
          for (const z of this.zones) if (inter(z, s.face) > 0.15 * area(s.face)) return { reject: 'dialogue_on_face' };
          faces++;
          people++;
          who.push(i);
          faceArea += area(s.face);
          const fcx = (s.face.x0 + s.face.x1) / 2;
          if (fcx - r.x0 < 0.05 * w || r.x1 - fcx < 0.05 * w) faceNearEdge = true;
          if (!mainFace || area(s.face) > area(mainFace)) mainFace = s.face;
          chinDepth = Math.min(chinDepth, (r.y1 - s.chin) / s.f);
          const d = (r.y1 - s.chin) / s.f;
          if (FRAMING_LINES.some((t) => Math.abs(d - t) <= 0.35 + 0.05 * t)) onFramingLine = true;
          if (s.body) {
            if (r.y1 >= s.body.y1 - 0.02 * W) onFramingLine = true;
            bodyArea += inter(s.body, r);
          }
          continue;
        }
      }
      if (s.head) {
        const hi = inter(s.head, r) / area(s.head);
        if (hi > 0.1 && hi < 0.6) return { reject: 'cuts_head' };
        if (hi >= 0.6) {
          // Most of the head but not its face: a shot of hair.
          if (s.face) return { reject: 'cuts_face' };
          people++; // back of a head, or a face the face detector missed
          who.push(i);
          if (s.body) bodyArea += inter(s.body, r);
          continue;
        }
      }
      if (s.body) {
        const b = s.body;
        const bh = b.y1 - b.y0;
        const share = inter(b, r) / area(b);
        // A body taller than a pan can still be shown from the top down.
        const coveredH = Math.min(r.y1, b.y1) - Math.max(r.y0, b.y0);
        const xCover = (Math.min(r.x1, b.x1) - Math.max(r.x0, b.x0)) / (b.x1 - b.x0);
        const enough = share >= 0.5 || (xCover >= 0.6 && coveredH >= Math.min(0.5 * bh, 1.2 * frameH));
        const headIn = !s.head || inter(s.head, r) >= 0.6 * area(s.head);
        if (enough && r.y0 <= b.y0 + 0.15 * bh && headIn) {
          people++;
          who.push(i);
          bodyArea += inter(b, r);
          if (!mainBody || area(b) > area(mainBody)) mainBody = b;
        } else if (share > 0.15) {
          fragment = true; // part of a body whose head is elsewhere
        }
      }
    }

    // R1: a side crop leaves out the share of a shown body's width that lies outside it.
    let bodyCut = 0;
    if (c.bodyCutCost > 0 && w < W - 1) {
      for (const i of who) {
        const b = this.subjects[i].body;
        if (!b || this.groupBody[i] || this.bodyConf[i] < c.bodyCutMinConf) continue;
        bodyCut = Math.max(bodyCut, (Math.max(0, r.x0 - b.x0) + Math.max(0, b.x1 - r.x1)) / Math.max(1, b.x1 - b.x0));
      }
    }

    // Dialogue: a little is fine, a lot compared with the face is not. Balloons are measured by
    // what they cover on screen, not by their bounding boxes.
    const D = this.balloonArea(r);
    const dialogueShare = D / area(r);
    let dialogueLines = 0;
    let sliver = false; // an edge through a line's padding: allowed, but a clean edge is better
    for (const l of this.dialogue) {
      const share = inter(l, r) / area(l);
      if (share > 0.15 && share < 0.95) return { reject: 'dialogue_text', note: 'edge through a line' };
      if (share >= 0.95) dialogueLines++;
      else if (share > 0.01) sliver = true;
    }
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    // A face that carries the shot must not be outweighed by balloons ("a lot of balloon and little
    // face is not fine"). In a wide shot no face is big enough to carry it: the drawn scene does,
    // so only the balloons' share of the box counts.
    const bigFace = mainFace !== null && mainFace.y1 - mainFace.y0 >= c.minFaceHeight * W;
    if (people > 0) {
      const subjectArea = faceArea + 0.25 * bodyArea;
      if (dialogueShare > c.maxDialogueShare) return { reject: 'too_much_dialogue', note: `balloon ${pct(dialogueShare)} of box` };
      if (bigFace && D > c.maxDialogueVsFace * subjectArea + 1) return { reject: 'too_much_dialogue', note: `balloon ${(D / Math.max(1, subjectArea)).toFixed(1)}x subject` };
    } else if (dialogueShare > c.maxDialogueShareBroll) return { reject: 'too_much_dialogue', note: `b-roll balloon ${pct(dialogueShare)}` };
    if (dialogueLines > c.maxDialogueLines) return { reject: 'dialogue_text', note: `${dialogueLines} lines` };

    // Empty stretches.
    const busy = this.busyRows(r.x0, r.x1);
    const size = this.detail.size;
    const base = Math.floor(this.band.y0 / size);
    let run = 0;
    let maxRun = 0;
    let empty = 0;
    let rowsN = 0;
    for (let cy = Math.floor(r.y0 / size); cy < Math.ceil(r.y1 / size); cy++) {
      rowsN++;
      if (busy[cy - base]) run = 0;
      else {
        empty++;
        maxRun = Math.max(maxRun, ++run);
      }
    }
    if ((maxRun * size) / frameH > c.maxEmptyScreens) return { reject: 'empty_stretch' };
    const emptyShare = rowsN ? empty / rowsN : 0;

    // Focus.
    let focus: ShotFocus;
    let focusValue: number;
    let focusPoint: { x: number; y: number };
    if (mainFace) {
      focus = 'face';
      // A crowd of tiny faces is a wide shot: worth less than one readable face.
      focusValue = (bigFace ? 1 : 0.6) + 0.1 * Math.min(2, faces - 1);
      focusPoint = { x: Math.round((mainFace.x0 + mainFace.x1) / 2), y: Math.round((mainFace.y0 + mainFace.y1) / 2) };
    } else if (people > 0) {
      focus = 'body';
      focusValue = 0.6;
      // R2c: look at the largest shown head; without a head, the top quarter of the largest shown
      // body; else the box fallback. (Before, the box centre / quarter down landed on objects.)
      let bigHead: Rect | null = null;
      for (const i of who) {
        const h = this.subjects[i].head;
        if (h && (!bigHead || area(h) > area(bigHead))) bigHead = h;
      }
      if (bigHead) focusPoint = { x: Math.round((bigHead.x0 + bigHead.x1) / 2), y: Math.round((bigHead.y0 + bigHead.y1) / 2) };
      else {
        let shownBody: Rect | null = null;
        for (const i of who) {
          const sb = this.subjects[i].body;
          if (sb && (!shownBody || area(sb) > area(shownBody))) shownBody = sb;
        }
        const b = shownBody ?? mainBody ?? r;
        focusPoint = { x: Math.round((b.x0 + b.x1) / 2), y: Math.round(b.y0 + 0.25 * (b.y1 - b.y0)) };
      }
    } else {
      if (fragment) return { reject: 'no_focus' };
      const d = this.signs.of(r);
      const busyArea = this.detail.of(r).busyArea; // busy checks keep the fully masked map
      if (
        d.iso < c.detailIso ||
        d.contrast < c.detailContrast ||
        busyArea < c.minDetailBusy * area(r) ||
        busyArea < c.minDetailFrames * frameH * w
      ) {
        return { reject: 'no_focus' };
      }
      focus = 'detail';
      focusValue = 0.3 + 0.3 * Math.min(1, (d.iso - c.detailIso) / 0.02);
      focusPoint = d.centre;
    }

    // Framing quality.
    let q = 1;
    if (focus === 'face') {
      if (!onFramingLine) q *= 1 - c.framingCost;
      q *= 1 - 0.4 * hairTrim;
      if (faceNearEdge) q *= 0.85;
    }
    if (bodyCut > 0) q *= 1 - c.bodyCutCost * Math.min(1, bodyCut);
    // A little text costs a little: the box should not shrink and lose art to leave a balloon out.
    q *= 1 - c.balloonCost * dialogueShare;
    q *= 1 - c.lineCost * dialogueLines;
    if (sliver) q *= 0.95;
    if (emptyShare > 0.4) q *= 1 - (emptyShare - 0.4);
    const sfxShare = this.sfx.reduce((s, l) => s + inter(l, r), 0) / area(r);
    if (sfxShare > 0.3) q *= 0.8;
    // Watermarks inside (whole or cut by an edge) are blurred in the video image: no score cost.
    const watermarks = this.marks
      .filter((m) => inter(m, r) > 0)
      .map((m) => ({ x0: Math.max(m.x0, r.x0), y0: Math.max(m.y0, r.y0), x1: Math.min(m.x1, r.x1), y1: Math.min(m.y1, r.y1) }));
    // Size: a shot shows as much of the panel's art as the box holds (people shots get this after
    // the base score, below). Past 9:16 it costs a little, so the box stays 9:16 unless it gains.
    const sizeReward = 1 - c.artWeight + c.artWeight * this.artKeptSide(r);
    if (focus === 'detail') q *= sizeReward;
    if (screens > SWEET_SCREENS) q *= 1 - c.overCost * (screens / SWEET_SCREENS - 1);
    q *= 0.85 + 0.15 * (w / W);
    q *= 0.7 + 0.3 * this.coverage(r, focus === 'detail' ? null : who);
    const baseScore = focusValue * Math.max(0, q);
    const tier: 'A' | 'B' = focus === 'detail' ? 'B' : 'A';
    if (baseScore < (tier === 'A' ? c.minScoreA : c.minScoreB)) return { reject: 'no_focus' };
    const score = tier === 'A' ? baseScore * sizeReward : baseScore;

    let framing: ShotFraming = 'wide';
    if (focus === 'face' && bigFace) {
      framing = chinDepth < 1.0 ? 'close_up' : chinDepth < 2.0 ? 'medium_close' : chinDepth < 4.0 ? 'medium' : 'full';
    } else if (focus === 'body') framing = 'full';

    const why = [
      focus === 'face' ? `${faces} face${faces > 1 ? 's' : ''}` : focus === 'body' ? 'body, no face visible' : 'drawn detail',
      framing.replace('_', ' '),
      hairTrim > 0.05 ? `hair trimmed ${Math.round(hairTrim * 100)}%` : '',
      dialogueShare > 0.005 ? `${Math.round(dialogueShare * 100)}% balloon` : '',
      w < W - 1 ? 'side crop' : '',
      watermarks.length ? 'watermark blurred' : '',
    ]
      .filter(Boolean)
      .join(', ');
    return {
      x0: r.x0,
      y0: r.y0,
      x1: r.x1,
      y1: r.y1,
      score: r3(score),
      tier,
      focus,
      framing,
      screens: Math.round(screens * 100) / 100,
      focusPoint,
      faces,
      people,
      dialogueShare: r3(dialogueShare),
      dialogueLines,
      sfxShare: r3(sfxShare),
      emptyShare: r3(emptyShare),
      watermarks,
      why,
      who,
      base: baseScore,
    };
  }

  /**
   * Share of the panel's subjects a shot keeps: faces count most, then heads and bodies. In a
   * people shot only the people it shows earn credit (`who`); a slice of someone whose head is
   * elsewhere earns nothing. B-roll (`who` null) gets credit for any part of anyone.
   */
  private coverage(r: Rect, who: number[] | null): number {
    let total = 0;
    let kept = 0;
    for (const [i, s] of this.subjects.entries()) {
      const shown = !who || who.includes(i);
      for (const [box, weight] of [
        [s.face, 3],
        [s.head, 1],
        [s.body, 1],
      ] as const) {
        if (!box) continue;
        total += weight;
        if (shown) kept += (weight * inter(box, r)) / area(box);
      }
    }
    return total ? kept / total : 1;
  }

  plan(): Candidate[] {
    const { tops, bottoms, naturalTops, naturalBottoms } = this.edges();
    const { y0: P0, y1: P1 } = this.band;
    const cands: Candidate[] = [];
    const seen = new Set<string>();
    const reject = (reason: ShotReject, r: Rect) => this.rejectArea.set(reason, Math.max(this.rejectArea.get(reason) ?? 0, area(r)));
    const tryRect = (r: Rect) => {
      if (r.y1 - r.y0 < 16) return;
      const key = `${r.x0}:${r.y0}:${r.x1}:${r.y1}`;
      if (seen.has(key)) return;
      seen.add(key);
      // Taller than 9:16 only to show something whole: both ends must be natural edges.
      const over = r.y1 - r.y0 > SWEET_SCREENS * this.cfg.frameAspect * (r.x1 - r.x0) * 1.002;
      if (over && !(naturalTops.has(r.y0) && naturalBottoms.has(r.y1))) return reject('too_long', r);
      const e = this.evaluate(r);
      if ('reject' in e) reject(e.reject, r);
      else cands.push(e);
    };
    for (const [x0, x1] of this.xRanges()) {
      // Besides edge-to-edge pairs, fixed-length windows from every edge: a subject taller than
      // a pan still gets a shot of its best part.
      const fh = this.cfg.frameAspect * (x1 - x0);
      for (const y0 of tops) {
        for (const y1 of bottoms) tryRect({ x0, y0, x1, y1 });
        for (const k of WINDOW_SCREENS) tryRect({ x0, y0, x1, y1: Math.min(P1, Math.round(y0 + k * fh)) });
      }
      for (const y1 of bottoms) {
        for (const k of WINDOW_SCREENS) tryRect({ x0, y0: Math.max(P0, Math.round(y1 - k * fh)), x1, y1 });
      }
    }
    // A panel with people is about the people: its leftovers (hair, clothes, a corner of the room)
    // are not b-roll, and an extra shot must show another real subject. A panel without people
    // gives at most one b-roll shot, its best.
    const people = cands.filter((c) => c.tier === 'A');
    if (people.length) {
      const picked = pickShots(people, this.cfg.extraShotCost, (c) => c.base);
      return this.merge(this.grow(picked, people), people);
    }
    const broll = cands.filter((c) => c.tier === 'B');
    return broll.length ? [broll.reduce((a, b) => (b.score > a.score ? b : a))] : [];
  }

  /**
   * Sizes each picked shot: the best-scoring candidate that shows at least the same people and
   * stays clear of the neighbouring shots.
   */
  private grow(picked: Candidate[], cands: Candidate[]): Candidate[] {
    const out = [...picked].sort((a, b) => a.y0 - b.y0);
    for (let i = 0; i < out.length; i++) {
      const lo = i > 0 ? out[i - 1].y1 : -Infinity;
      const hi = i + 1 < out.length ? out[i + 1].y0 : Infinity;
      const need = out[i].who;
      let best = out[i];
      for (const c of cands) {
        if (c.score <= best.score || c.y0 < lo || c.y1 > hi) continue;
        if (need.every((k) => c.who.includes(k))) best = c;
      }
      out[i] = best;
    }
    return out;
  }

  /**
   * One box rather than two: neighbouring shots are replaced by the best single candidate that
   * shows everyone in both and stays clear of the other shots, when it scores at least mergeFloor
   * of the better one. Shots stay apart only when their people are too far apart for one box.
   */
  private merge(picked: Candidate[], cands: Candidate[]): Candidate[] {
    const out = [...picked].sort((a, b) => a.y0 - b.y0);
    for (let i = 0; i + 1 < out.length; ) {
      const a = out[i];
      const b = out[i + 1];
      const need = [...new Set([...a.who, ...b.who])];
      const lo = i > 0 ? out[i - 1].y1 : -Infinity;
      const hi = i + 2 < out.length ? out[i + 2].y0 : Infinity;
      let best: Candidate | null = null;
      for (const c of cands) {
        if (c.y0 < lo || c.y1 > hi || (best && c.score <= best.score)) continue;
        if (need.every((k) => c.who.includes(k))) best = c;
      }
      if (best && best.score >= this.cfg.mergeFloor * Math.max(a.score, b.score)) {
        out.splice(i, 2, best);
        i = Math.max(0, i - 1);
      } else i++;
    }
    return out;
  }

  /** Debugging: how one box would be judged (the reject reason, or its score and parts). */
  explain(r: Rect): { reject: ShotReject; note?: string } | { score: number; base: number; why: string; parts: string } {
    const e = this.evaluate(r);
    if ('reject' in e) return e;
    const parts = `art ${r3(this.artKept(r))} cover ${r3(this.coverage(r, e.tier === 'B' ? null : e.who))} balloon ${r3(e.dialogueShare)} lines ${e.dialogueLines} empty ${e.emptyShare} ${e.framing}`;
    return { score: e.score, base: e.base, why: e.why, parts };
  }

  /**
   * Why no shot was found: the reason that rejected the largest candidate. Size reasons only count
   * when nothing else was found (a panel too short for any frame).
   */
  mainReject(): ShotReject {
    const size = new Set<ShotReject>(['too_small', 'too_long', 'crosses_border']);
    let best: ShotReject | null = null;
    let bestArea = -1;
    for (const pass of [false, true]) {
      for (const [reason, a] of this.rejectArea) {
        if ((pass || !size.has(reason)) && a > bestArea) {
          best = reason;
          bestArea = a;
        }
      }
      if (best) return best;
    }
    return 'no_focus';
  }
}

/**
 * Non-overlapping shots (vertically) with the highest total score, where every shot after the
 * first costs `extraCost` (weighted interval scheduling). With a cost, a second shot is only
 * added when it is worth more than the cost; the best single shot is always kept.
 */
export function pickShots<T extends { y0: number; y1: number; score: number }>(
  cands: T[],
  extraCost = 0,
  value: (c: T) => number = (c) => c.score,
): T[] {
  if (!cands.length) return [];
  const sorted = [...cands].sort((a, b) => a.y1 - b.y1);
  const n = sorted.length;
  const best = new Float64Array(n + 1);
  const take = new Uint8Array(n);
  const prev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = i;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].y1 <= sorted[i].y0) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo; // candidates [0, lo) end at or above this one's top
    const withIt = value(sorted[i]) - extraCost + best[lo];
    take[i] = withIt > best[i] ? 1 : 0;
    best[i + 1] = take[i] ? withIt : best[i];
  }
  const out: T[] = [];
  for (let i = n - 1; i >= 0; ) {
    if (take[i]) {
      out.push(sorted[i]);
      i = prev[i] - 1;
    } else i--;
  }
  if (!out.length) return [cands.reduce((a, b) => (value(b) > value(a) ? b : a))];
  return out.reverse();
}

/** Lettering and balloons are not drawn detail: zero the detail cells they cover. */
function maskLettering(d: DetailMap, boxes: Rect[]): DetailMap {
  const iso = d.iso.slice();
  const ink = d.ink.slice();
  for (const b of boxes) {
    const cx0 = Math.max(0, Math.floor(b.x0 / d.size));
    const cx1 = Math.min(d.cols, Math.ceil(b.x1 / d.size));
    const cy0 = Math.max(0, Math.floor(b.y0 / d.size));
    const cy1 = Math.min(d.rows, Math.ceil(b.y1 / d.size));
    for (let cy = cy0; cy < cy1; cy++) {
      iso.fill(0, cy * d.cols + cx0, cy * d.cols + cx1);
      ink.fill(0, cy * d.cols + cx0, cy * d.cols + cx1);
    }
  }
  return { ...d, iso, ink };
}

/**
 * R3 (config.shots.signsAreArt), used only as a fallback for a panel the normal planner left without a shot: detail map for the b-roll focus test in which sfx and noise lines
 * outside every dialogue zone are not masked (a drawn sign is art). Dialogue, watermark lines and
 * dialogue zones stay masked. Off: the fully masked index itself.
 */
function signsIndex(input: ShotInput, masked: DetailIndex): DetailIndex {
  if (!config.shots.signsAreArt) return masked;
  const zones = input.blocks.map((b) => b.zone);
  const lettering = [
    ...input.lines.filter((l) => !((l.kind === 'sfx' || l.kind === 'noise') && !zones.some((z) => intersect(z, l)))),
    ...zones,
  ];
  return new DetailIndex(maskLettering(input.detail, lettering));
}

/** Debugging (scripts/why-small.ts): how the planner would judge some boxes inside one panel. */
export function explainBoxes(panel: Panel, input: ShotInput, boxes: Rect[]) {
  const lettering = [...input.lines, ...input.blocks.map((b) => b.zone)];
  const idx = new DetailIndex(maskLettering(input.detail, lettering));
  let planner = new PanelPlanner(input, idx, panel, idx);
  if (config.shots.signsAreArt && !planner.plan().length) planner = new PanelPlanner(input, idx, panel, signsIndex(input, idx));
  return boxes.map((r) => planner.explain(r));
}

/**
 * Drops b-roll shots that are leftovers of a neighbouring panel's shot: the two shots meet at a cut
 * with no gutter (border or split), so the b-roll shows the rest of a scene the neighbour already
 * shows. Next to a people shot, or a bigger b-roll shot, a b-roll shot stays only when it stands on
 * its own. Panels left without a shot get videoSkip 'leftover'.
 */
function dropLeftovers(panels: Panel[], plans: Candidate[][], width: number): void {
  const c = config.shots;
  const tol = 0.05 * width;
  const strong = (s: Candidate) => s.score >= c.leftoverMinScore && s.screens >= c.leftoverMinScreens;
  const leftover = new Set<Candidate>();
  for (const [i, panel] of panels.entries()) {
    for (const s of plans[i]) {
      if (s.tier !== 'B' || strong(s)) continue;
      for (const side of ['above', 'below'] as const) {
        const cut = side === 'above' ? panel.top : panel.bottom;
        const j = side === 'above' ? i - 1 : i + 1;
        if ((cut !== 'border' && cut !== 'split') || j < 0 || j >= panels.length) continue;
        const y = side === 'above' ? panel.contentY0 : panel.contentY1;
        if (Math.abs((side === 'above' ? s.y0 : s.y1) - y) > tol) continue;
        const ny = side === 'above' ? panels[j].contentY1 : panels[j].contentY0;
        const meets = plans[j].filter((n) => Math.abs((side === 'above' ? n.y1 : n.y0) - ny) <= tol);
        if (meets.some((n) => n.tier === 'A' || area(n) > area(s) || (area(n) === area(s) && side === 'above'))) leftover.add(s);
      }
    }
  }
  for (const [i, panel] of panels.entries()) {
    const kept = plans[i].filter((s) => !leftover.has(s));
    if (plans[i].length && !kept.length) panel.videoSkip = 'leftover';
    plans[i] = kept;
  }
}

export function planShots(panels: Panel[], input: ShotInput): Shot[] {
  const lettering = [...input.lines, ...input.blocks.map((b) => b.zone)];
  const detail = new DetailIndex(maskLettering(input.detail, lettering));
  let signs: DetailIndex | undefined;
  const plans: Candidate[][] = panels.map(() => []);
  for (const [i, panel] of panels.entries()) {
    panel.shotIds = [];
    panel.videoSkip = undefined;
    if (panel.role === 'credits') {
      panel.videoSkip = 'credits';
      continue;
    }
    if (panel.role !== 'art' && panel.role !== 'art_text') continue;
    const planner = new PanelPlanner(input, detail, panel, detail);
    plans[i] = planner.plan();
    if (!plans[i].length && config.shots.signsAreArt) plans[i] = new PanelPlanner(input, detail, panel, (signs ??= signsIndex(input, detail))).plan();
    if (!plans[i].length) panel.videoSkip = planner.mainReject();
  }
  dropLeftovers(panels, plans, input.width);
  const shots: Shot[] = [];
  for (const [i, panel] of panels.entries()) {
    for (const { who: _who, base: _base, ...c } of plans[i]) {
      const index = shots.length + 1;
      const id = `s${String(index).padStart(3, '0')}`;
      shots.push({
        ...c,
        id,
        index,
        panelId: panel.id,
        panelIndex: panel.index,
        file: `${id}_${panel.id}.jpg`,
        motion: c.screens > 1.05 ? 'pan' : 'still',
        pages: input.pages.filter((p) => p.y0 < c.y1 && p.y1 > c.y0).map((p) => p.index),
      });
      panel.shotIds.push(id);
    }
  }
  return shots;
}
