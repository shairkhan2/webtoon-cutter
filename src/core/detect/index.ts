import type * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { stripRows } from '../cbz.ts';
import { config } from '../config.ts';
import { containment, iou, runs, union } from '../geometry.ts';
import type { Detection, DetectionKind, Interval, ProgressFn, Strip } from '../types.ts';
import { runDbnet } from './dbnet.ts';
import { openSession } from './models.ts';
import { createReader, type Reader } from './reader.ts';
import { runYolo } from './yolo.ts';

export interface Detector {
  head: ort.InferenceSession;
  face: ort.InferenceSession;
  person: ort.InferenceSession;
  text: ort.InferenceSession;
  reader: Reader;
  release(): Promise<void>;
}

export async function createDetector(modelDir: string): Promise<Detector> {
  const [head, face, person, text, reader] = await Promise.all([
    openSession('head', modelDir),
    openSession('face', modelDir),
    openSession('person', modelDir),
    openSession('text', modelDir),
    createReader(modelDir),
  ]);
  return {
    head,
    face,
    person,
    text,
    reader,
    async release() {
      await Promise.all([head.release(), face.release(), person.release(), text.release(), reader.release()]);
    },
  };
}

/** Windows over content, skipping long blank stretches. Short regions grow to a square window. */
export function planWindows(flat: Uint8Array, width: number, height: number): Interval[] {
  const c = config.detect;
  const content = runs(flat.map((v) => (v ? 0 : 1)));
  const bridge = Math.round(c.bridgeGap * width);
  const regions: Interval[] = [];
  for (const r of content) {
    const last = regions[regions.length - 1];
    if (last && r.y0 - last.y1 <= bridge) last.y1 = r.y1;
    else regions.push({ ...r });
  }

  const winH = Math.round(c.windowAspect * width);
  const stride = Math.round(winH * (1 - c.overlap));
  const windows: Interval[] = [];
  for (const r of regions) {
    const h = r.y1 - r.y0;
    if (h <= winH) {
      const target = Math.min(height, Math.max(h, width));
      const mid = (r.y0 + r.y1) / 2;
      const y0 = Math.max(0, Math.min(height - target, Math.round(mid - target / 2)));
      windows.push({ y0, y1: y0 + target });
      continue;
    }
    for (let y0 = r.y0; ; y0 += stride) {
      const s = Math.min(y0, r.y1 - winH);
      windows.push({ y0: s, y1: s + winH });
      if (s + winH >= r.y1) break;
    }
  }
  return windows;
}

interface Candidate extends Detection {
  truncated: boolean; // touches the top or bottom edge of its window (not the strip edge)
}

async function resizeRaw(rgb: Buffer, width: number, height: number, outW: number, outH: number): Promise<Buffer> {
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(outW, outH, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer();
}

export async function detectObjects(
  strip: Strip,
  flat: Uint8Array,
  detector: Detector,
  progress?: ProgressFn,
): Promise<{ detections: Detection[]; windows: Interval[] }> {
  const c = config.detect;
  const { width, height } = strip;
  const windows = planWindows(flat, width, height);
  const found: Candidate[] = [];

  const add = (kind: DetectionKind, win: Interval, b: { x0: number; y0: number; x1: number; y1: number; score: number }) => {
    const y0 = win.y0 + b.y0;
    const y1 = win.y0 + b.y1;
    if (b.x1 - b.x0 < 4 || y1 - y0 < 4) return;
    const truncated = (b.y0 <= 2 && win.y0 > 0) || (b.y1 >= win.y1 - win.y0 - 2 && win.y1 < height);
    found.push({ kind, x0: b.x0, y0, x1: b.x1, y1, score: b.score, truncated });
  };

  for (const [i, win] of windows.entries()) {
    const h = win.y1 - win.y0;
    const rows = stripRows(strip, win.y0, win.y1);
    const square = await resizeRaw(rows, width, h, c.yoloSize, c.yoloSize);
    for (const b of await runYolo(detector.head, square, c.yoloSize, width, h, c.headConf, c.headIou)) add('head', win, b);
    for (const b of await runYolo(detector.face, square, c.yoloSize, width, h, c.faceConf, c.faceIou)) add('face', win, b);
    for (const b of await runYolo(detector.person, square, c.yoloSize, width, h, c.personConf, c.personIou)) add('person', win, b);

    const tw = Math.max(32, Math.round(width * c.textScale));
    const th = Math.max(32, Math.round(h * c.textScale));
    const small = await resizeRaw(rows, width, h, tw, th);
    for (const b of await runDbnet(detector.text, small, tw, th, c.textHeat, c.textBox, c.textUnclip)) {
      add('text', win, {
        x0: Math.round(b.x0 / c.textScale),
        y0: Math.round(b.y0 / c.textScale),
        x1: Math.min(width, Math.round(b.x1 / c.textScale)),
        y1: Math.min(h, Math.round(b.y1 / c.textScale)),
        score: b.score,
      });
    }
    progress?.('detect', (i + 1) / windows.length);
  }
  return { detections: mergeDetections(found), windows };
}

/**
 * Second text pass, at `scale` instead of the usual half resolution, inside some regions only
 * (video shots): finds small lettering such as corner banners. Returns line boxes that the first
 * pass did not have (less than 30% covered by a known box), in strip pixels.
 */
export async function detectSmallText(
  strip: Strip,
  regions: { x0: number; y0: number; x1: number; y1: number }[],
  known: Detection[],
  detector: Detector,
  scale: number,
): Promise<Detection[]> {
  const c = config.detect;
  const { width } = strip;
  const area = (r: { x0: number; y0: number; x1: number; y1: number }) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
  const inter = (a: Detection, b: Detection) =>
    area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
  const winH = Math.round(c.windowAspect * width);
  const step = winH - Math.round(0.1 * width);
  const found: Detection[] = [];
  for (const r of regions) {
    const w = r.x1 - r.x0;
    for (let y0 = r.y0; y0 < r.y1; y0 += step) {
      const y1 = Math.min(r.y1, y0 + winH);
      const h = y1 - y0;
      const crop = Buffer.allocUnsafe(w * h * 3);
      for (let y = 0; y < h; y++) {
        const src = ((y0 + y) * width + r.x0) * 3;
        crop.set(strip.rgb.subarray(src, src + w * 3), y * w * 3);
      }
      const tw = Math.max(32, Math.round(w * scale));
      const th = Math.max(32, Math.round(h * scale));
      const img = await resizeRaw(crop, w, h, tw, th);
      for (const b of await runDbnet(detector.text, img, tw, th, c.textHeat, c.textBox, c.textUnclip)) {
        const d: Detection = {
          kind: 'text',
          x0: r.x0 + Math.round((b.x0 * w) / tw),
          y0: y0 + Math.round((b.y0 * h) / th),
          x1: r.x0 + Math.round((b.x1 * w) / tw),
          y1: y0 + Math.round((b.y1 * h) / th),
          score: b.score,
        };
        if (known.some((k) => k.kind === 'text' && inter(k, d) >= 0.3 * area(d))) continue;
        if (found.some((f) => inter(f, d) >= 0.5 * Math.min(area(f), area(d)))) continue;
        found.push(d);
      }
      if (y1 >= r.y1) break;
    }
  }
  return found.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/**
 * Merge duplicates from overlapping windows. Boxes cut off at a window edge also merge
 * with the same object seen from the neighbouring window.
 */
export function mergeDetections(input: Candidate[]): Detection[] {
  const c = config.detect;
  let boxes = [...input].sort((a, b) => b.score - a.score);
  for (let changed = true; changed; ) {
    changed = false;
    const kept: Candidate[] = [];
    for (const b of boxes) {
      const k = kept.find((k) => k.kind === b.kind && shouldMerge(k, b, c.mergeIou, c.mergeContain));
      if (k) {
        Object.assign(k, union(k, b));
        k.truncated = k.truncated && b.truncated;
        changed = true;
      } else kept.push({ ...b });
    }
    boxes = kept;
  }
  return boxes
    .map(({ truncated: _t, ...d }) => d)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

function shouldMerge(a: Candidate, b: Candidate, iouMin: number, containMin: number): boolean {
  if (iou(a, b) >= iouMin || containment(a, b) >= containMin) return true;
  if (!a.truncated && !b.truncated) return false;
  if (a.kind === 'text') return false;
  const xOverlap = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const xUnion = Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0);
  const yOverlap = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return xOverlap / xUnion >= 0.6 && yOverlap >= 0.3 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
}
