import * as ort from 'onnxruntime-node';
import type { Rect } from '../types.ts';

export interface RawBox extends Rect {
  score: number;
}

/** Planar CHW float tensor in [0, 1] from packed RGB. */
export function toChw(rgb: Uint8Array, width: number, height: number, mean?: number[], std?: number[]): Float32Array {
  const plane = width * height;
  const out = new Float32Array(plane * 3);
  for (let i = 0, j = 0; i < plane; i++, j += 3) {
    for (let c = 0; c < 3; c++) {
      const v = rgb[j + c] / 255;
      out[c * plane + i] = mean && std ? (v - mean[c]) / std[c] : v;
    }
  }
  return out;
}

export function nms(boxes: RawBox[], iouThreshold: number): RawBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep: RawBox[] = [];
  const dead = new Uint8Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    if (dead[i]) continue;
    const a = sorted[i];
    keep.push(a);
    const areaA = (a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1);
    for (let j = i + 1; j < sorted.length; j++) {
      if (dead[j]) continue;
      const b = sorted[j];
      const w = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1);
      const h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1);
      const inter = w * h;
      const areaB = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
      if (inter / (areaA + areaB - inter) > iouThreshold) dead[j] = 1;
    }
  }
  return keep;
}

/**
 * Single-class YOLOv8 detector, matching imgutils: the input is stretched to size×size,
 * the output is [1, 4 + classes, anchors] with centre-x, centre-y, w, h in input pixels.
 */
export async function runYolo(
  session: ort.InferenceSession,
  rgb: Uint8Array,
  size: number,
  srcWidth: number,
  srcHeight: number,
  conf: number,
  iouThreshold: number,
): Promise<RawBox[]> {
  const input = new ort.Tensor('float32', toChw(rgb, size, size), [1, 3, size, size]);
  const result = await session.run({ [session.inputNames[0]]: input });
  const out = result[session.outputNames[0]];
  const data = out.data as Float32Array;
  const [, d1, d2] = out.dims as number[];
  // Channels-first [1, 5, N] is the usual export; handle [1, N, 5] too.
  const channelsFirst = d1 < d2;
  const n = channelsFirst ? d2 : d1;
  const ch = channelsFirst ? d1 : d2;
  const at = (c: number, i: number) => (channelsFirst ? data[c * n + i] : data[i * ch + c]);
  const sx = srcWidth / size;
  const sy = srcHeight / size;

  const boxes: RawBox[] = [];
  for (let i = 0; i < n; i++) {
    let score = 0;
    for (let c = 4; c < ch; c++) score = Math.max(score, at(c, i));
    if (score <= conf) continue;
    const cx = at(0, i);
    const cy = at(1, i);
    const w = at(2, i);
    const h = at(3, i);
    boxes.push({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, score });
  }
  input.dispose();
  out.dispose();
  const clampTo = (v: number, max: number) => Math.round(Math.min(max, Math.max(0, v)));
  return nms(boxes, iouThreshold).map((b) => ({
    x0: clampTo(b.x0 * sx, srcWidth),
    y0: clampTo(b.y0 * sy, srcHeight),
    x1: clampTo(b.x1 * sx, srcWidth),
    y1: clampTo(b.y1 * sy, srcHeight),
    score: b.score,
  }));
}
