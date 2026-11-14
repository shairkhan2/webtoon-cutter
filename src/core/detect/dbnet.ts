import * as ort from 'onnxruntime-node';
import { toChw, type RawBox } from './yolo.ts';

// imgutils feeds PP-OCR with CLIP normalisation and zero padding to a multiple of 64.
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const ALIGN = 64;
const MIN_SIDE = 3;

/**
 * PP-OCRv4 DBNet text detector. Returns axis-aligned line boxes in input pixels.
 * Webtoon lettering is horizontal, so components are scored and unclipped as rectangles
 * instead of rotated rectangles.
 */
export async function runDbnet(
  session: ort.InferenceSession,
  rgb: Uint8Array,
  width: number,
  height: number,
  heatThreshold: number,
  boxThreshold: number,
  unclipRatio: number,
): Promise<RawBox[]> {
  const pw = Math.ceil(width / ALIGN) * ALIGN;
  const ph = Math.ceil(height / ALIGN) * ALIGN;
  // Zero padding *before* normalisation, as in imgutils.
  const padded = new Uint8Array(pw * ph * 3);
  for (let y = 0; y < height; y++) padded.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * pw * 3);
  const chw = toChw(padded, pw, ph, MEAN, STD);

  const input = new ort.Tensor('float32', chw, [1, 3, ph, pw]);
  const result = await session.run({ [session.inputNames[0]]: input });
  const out = result[session.outputNames[0]];
  const heat = out.data as Float32Array; // [1, 1, ph, pw]
  const boxes = componentsToBoxes(heat, pw, width, height, heatThreshold, boxThreshold, unclipRatio);
  input.dispose();
  out.dispose();
  return boxes;
}

function componentsToBoxes(
  heat: Float32Array,
  stride: number,
  width: number,
  height: number,
  heatThreshold: number,
  boxThreshold: number,
  unclipRatio: number,
): RawBox[] {
  const label = new Int32Array(width * height);
  const stack: number[] = [];
  const boxes: RawBox[] = [];
  let next = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (label[i] || heat[y * stride + x] < heatThreshold) continue;
      next++;
      let x0 = x;
      let x1 = x;
      let y0 = y;
      let y1 = y;
      label[i] = next;
      stack.push(i);
      while (stack.length) {
        const p = stack.pop()!;
        const px = p % width;
        const py = (p - px) / width;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            if (nx < 0 || nx >= width) continue;
            const q = ny * width + nx;
            if (!label[q] && heat[ny * stride + nx] >= heatThreshold) {
              label[q] = next;
              stack.push(q);
            }
          }
        }
      }
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      if (Math.min(w, h) < MIN_SIDE) continue;
      let sum = 0;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) sum += heat[yy * stride + xx];
      const score = sum / (w * h);
      if (score < boxThreshold) continue;
      const d = (w * h * unclipRatio) / (2 * (w + h));
      if (Math.min(w, h) + 2 * d < MIN_SIDE + 2) continue;
      boxes.push({
        x0: Math.max(0, Math.round(x0 - d)),
        y0: Math.max(0, Math.round(y0 - d)),
        x1: Math.min(width, Math.round(x1 + 1 + d)),
        y1: Math.min(height, Math.round(y1 + 1 + d)),
        score,
      });
    }
  }
  return boxes;
}
