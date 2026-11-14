/**
 * Per-cell "is this drawn art or filler" measures, used to judge shots without people.
 *
 * Measured at half resolution so fine noise and sparkles drop out:
 * - iso: strong edges that are NOT part of a parallel-line pattern (speed lines, rain, hatching
 *   have high structure-tensor coherence and are excluded)
 * - ink: thin dark strokes, i.e. line art
 * - mean: mean gray, for tonal contrast between 32 px blocks
 *
 * On 13 hand-judged clips, iso >= 0.008 with block contrast >= 35 kept 6/6 good shots (rocks, a
 * fist, feet, a hand, a magic circle, a figure in fire) and dropped 6/7 fillers (sky, fog, fire
 * wash, vines, grass, speed lines). The miss was an abstract brush streak.
 */
export interface DetailMap {
  size: number; // cell size in full-resolution pixels
  cols: number;
  rows: number;
  iso: Float32Array;
  ink: Float32Array;
  mean: Float32Array;
}

const CELL = 16;
const HALF_CELL = CELL / 2;
const CHUNK = 2048; // half-res rows per chunk
const PAD = 8;

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / n;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

export function analyzeDetail(gray: Uint8Array, width: number, height: number): DetailMap {
  const hw = width >> 1;
  const hh = height >> 1;
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const iso = new Float32Array(cols * rows);
  const ink = new Float32Array(cols * rows);
  const mean = new Float32Array(cols * rows);
  const count = new Float32Array(cols * rows);

  for (let c0 = 0; c0 < hh; c0 += CHUNK) {
    const c1 = Math.min(hh, c0 + CHUNK);
    const a0 = Math.max(0, c0 - PAD);
    const a1 = Math.min(hh, c1 + PAD);
    const h = a1 - a0;
    const px = new Float32Array(hw * h);
    for (let y = 0; y < h; y++) {
      const r0 = (2 * (a0 + y)) * width;
      const r1 = r0 + width;
      for (let x = 0; x < hw; x++) {
        const i = 2 * x;
        px[y * hw + x] = (gray[r0 + i] + gray[r0 + i + 1] + gray[r1 + i] + gray[r1 + i + 1]) / 4;
      }
    }
    const b = boxBlur(px, hw, h, 1);
    const gx = new Float32Array(hw * h);
    const gy = new Float32Array(hw * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < hw - 1; x++) {
        const i = y * hw + x;
        gx[i] = b[i + 1] - b[i - 1];
        gy[i] = b[i + hw] - b[i - hw];
      }
    }
    const jxx = boxBlur(gx.map((v) => v * v), hw, h, 4);
    const jyy = boxBlur(gy.map((v) => v * v), hw, h, 4);
    const jxy = boxBlur(gx.map((v, i) => v * gy[i]), hw, h, 4);
    const local = boxBlur(px, hw, h, 3);
    for (let y = c0; y < c1; y++) {
      const ly = y - a0;
      const crow = Math.floor(y / HALF_CELL) * cols;
      for (let x = 0; x < hw; x++) {
        const i = ly * hw + x;
        const c = crow + Math.floor(x / HALF_CELL);
        count[c]++;
        mean[c] += px[i];
        if (local[i] - px[i] > 35) ink[c]++;
        const mag2 = gx[i] * gx[i] + gy[i] * gy[i];
        if (mag2 > 900) {
          const coh = Math.sqrt((jxx[i] - jyy[i]) ** 2 + 4 * jxy[i] ** 2) / (jxx[i] + jyy[i] + 1e-3);
          if (coh < 0.75) iso[c]++;
        }
      }
    }
  }
  for (let c = 0; c < count.length; c++) {
    if (!count[c]) continue;
    iso[c] /= count[c];
    ink[c] /= count[c];
    mean[c] /= count[c];
  }
  return { size: CELL, cols, rows, iso, ink, mean };
}
