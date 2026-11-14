/**
 * Candidate "is this real art or filler" measures on clips judged by eye.
 * Usage: npx tsx scripts/detail-eval.ts <file.cbz> <chapterId>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStrip } from '../src/core/cbz.ts';
import { runDir } from '../src/core/library.ts';
import type { Manifest, Rect } from '../src/core/types.ts';

const [file, id] = process.argv.slice(2);
const m = JSON.parse(await readFile(path.join(runDir(id), 'manifest.json'), 'utf8')) as Manifest;
const strip = await loadStrip(file);
const W = strip.width;
const judged: Record<string, 'good' | 'filler'> = {
  v029: 'good', v038: 'good', v044: 'good', v047: 'good', v051: 'good', v068: 'good',
  v004: 'filler', v011: 'filler', v032: 'filler', v050: 'filler', v054: 'filler', v060: 'filler', v069: 'filler',
};

/** Half-resolution gray of a rect, box filtered. */
function half(r: Rect): { w: number; h: number; px: Float32Array } {
  const w = (r.x1 - r.x0) >> 1;
  const h = (r.y1 - r.y0) >> 1;
  const px = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = r.x0 + 2 * x;
      const sy = r.y0 + 2 * y;
      const i = sy * W + sx;
      px[y * w + x] = (strip.gray[i] + strip.gray[i + 1] + strip.gray[i + W] + strip.gray[i + W + 1]) / 4;
    }
  }
  return { w, h, px };
}

function blur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * radius + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -radius; x <= radius; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / n;
      s += src[y * w + Math.min(w - 1, x + radius + 1)] - src[y * w + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -radius; y <= radius; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
    }
  }
  return out;
}

function features(r: Rect) {
  const { w, h, px } = half(r);
  const b = blur(px, w, h, 1);
  let strong = 0;
  let coherentStrong = 0;
  let ink = 0;
  let n = 0;
  const gxs = new Float32Array(w * h);
  const gys = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = b[i + 1] - b[i - 1];
      const gy = b[i + w] - b[i - w];
      gxs[i] = gx;
      gys[i] = gy;
    }
  }
  // Structure tensor coherence over a 9x9 window (on half res).
  const jxx = blur(gxs.map((g) => g * g), w, h, 4);
  const jyy = blur(gys.map((g) => g * g), w, h, 4);
  const jxy = blur(gxs.map((g, i) => g * gys[i]), w, h, 4);
  const localMax = blur(px, w, h, 3); // mean as proxy; ink = clearly darker than local mean
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      n++;
      const mag = Math.hypot(gxs[i], gys[i]);
      const coh = Math.sqrt((jxx[i] - jyy[i]) ** 2 + 4 * jxy[i] ** 2) / (jxx[i] + jyy[i] + 1e-3);
      if (mag > 30) {
        strong++;
        if (coh < 0.75) coherentStrong++;
      }
      if (localMax[i] - px[i] > 35) ink++;
    }
  }
  // Coarse tonal structure: std of 32px block means.
  const blocks: number[] = [];
  for (let by = 0; by + 16 <= h; by += 16) {
    for (let bx = 0; bx + 16 <= w; bx += 16) {
      let s = 0;
      for (let y = by; y < by + 16; y++) for (let x = bx; x < bx + 16; x++) s += px[y * w + x];
      blocks.push(s / 256);
    }
  }
  const mean = blocks.reduce((a, c) => a + c, 0) / blocks.length;
  const coarseStd = Math.sqrt(blocks.reduce((a, c) => a + (c - mean) ** 2, 0) / blocks.length);
  return {
    edges: +(strong / n).toFixed(3),
    isoEdges: +(coherentStrong / n).toFixed(3),
    ink: +(ink / n).toFixed(3),
    coarseStd: +coarseStd.toFixed(1),
  };
}

for (const [clip, verdict] of Object.entries(judged)) {
  const v = m.video.find((c) => c.id === clip)!;
  console.log(verdict.padEnd(6), clip, JSON.stringify(features(v)));
}
