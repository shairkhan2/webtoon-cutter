import { config } from './config.ts';
import type { FrameLine, Interval, Rect } from './types.ts';

const SLOPE_STEP = 0.02;

interface Candidate {
  yLeft: number; // full-res strip row at x = 0
  slope: number;
  votes: number;
}

/**
 * Find straight borders between touching panels inside one content piece.
 *
 * 1. Hough-style voting at half resolution: each near-horizontal edge pixel votes for lines
 *    whose slope matches its gradient direction (|slope| <= maxSlope).
 * 2. Every peak is verified at full resolution: along the whole width the line must be either a
 *    thin stroke or gap that contrasts with both sides (most borders), or a hard edge between two
 *    different images. Support is required near both strip edges.
 * 3. Families of parallel lines (speed lines, blinds, stripes) are rejected.
 */
export function findFrameLines(gray: Uint8Array, width: number, piece: Interval, occluders: Rect[] = []): FrameLine[] {
  const f = config.frames;
  const pieceH = piece.y1 - piece.y0;
  if (pieceH < 0.35 * width) return [];

  const hw = width >> 1;
  const hh = pieceH >> 1;
  if (hh < 8) return [];
  const half = new Uint8Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    const r0 = (piece.y0 + 2 * y) * width;
    const r1 = r0 + width;
    for (let x = 0; x < hw; x++) {
      const i = 2 * x;
      half[y * hw + x] = (gray[r0 + i] + gray[r0 + i + 1] + gray[r1 + i] + gray[r1 + i + 1] + 2) >> 2;
    }
  }

  const nSlopes = Math.round((2 * f.maxSlope) / SLOPE_STEP) + 1;
  const offset = Math.ceil(f.maxSlope * hw) + 2;
  const accH = hh + 2 * offset;
  const acc = new Int32Array(nSlopes * accH);
  const magMin2 = 70 * 70;
  for (let y = 1; y < hh - 1; y++) {
    for (let x = 1; x < hw - 1; x++) {
      const i = y * hw + x;
      const gx =
        half[i - hw + 1] + 2 * half[i + 1] + half[i + hw + 1] - half[i - hw - 1] - 2 * half[i - 1] - half[i + hw - 1];
      const gy =
        half[i + hw - 1] + 2 * half[i + hw] + half[i + hw + 1] - half[i - hw - 1] - 2 * half[i - hw] - half[i - hw + 1];
      if (gx * gx + gy * gy < magMin2 || Math.abs(gx) > f.maxSlope * Math.abs(gy)) continue;
      const s = -gx / gy;
      const k0 = Math.round((s + f.maxSlope) / SLOPE_STEP);
      for (let k = Math.max(0, k0 - 2); k <= Math.min(nSlopes - 1, k0 + 2); k++) {
        const slope = k * SLOPE_STEP - f.maxSlope;
        const yl = Math.round(y - slope * x) + offset;
        if (yl >= 0 && yl < accH) acc[k * accH + yl]++;
      }
    }
  }

  // Peaks: 3-row sums above threshold, local maxima in a (±2 slope, ±4 row) neighbourhood.
  const minVotes = 0.45 * hw;
  const sum3 = (k: number, yl: number) =>
    acc[k * accH + yl] + (yl > 0 ? acc[k * accH + yl - 1] : 0) + (yl < accH - 1 ? acc[k * accH + yl + 1] : 0);
  const peaks: Candidate[] = [];
  for (let k = 0; k < nSlopes; k++) {
    for (let yl = 0; yl < accH; yl++) {
      const v = sum3(k, yl);
      if (v < minVotes) continue;
      let isMax = true;
      for (let dk = -2; dk <= 2 && isMax; dk++) {
        const kk = k + dk;
        if (kk < 0 || kk >= nSlopes) continue;
        for (let dy = -4; dy <= 4; dy++) {
          const yy = yl + dy;
          if ((dk || dy) && yy >= 0 && yy < accH && sum3(kk, yy) > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) {
        const slope = k * SLOPE_STEP - f.maxSlope;
        peaks.push({ yLeft: piece.y0 + 2 * (yl - offset), slope, votes: v });
      }
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);

  const margin = f.pieceMargin * width;
  const verified: FrameLine[] = [];
  const debug = process.env.WSC_DEBUG_FRAMES === '1';
  for (const p of peaks.slice(0, 60)) {
    const yRight = p.yLeft + p.slope * width;
    if (Math.min(p.yLeft, yRight) < piece.y0 + margin || Math.max(p.yLeft, yRight) > piece.y1 - margin) continue;
    const line = verifyLine(gray, width, piece, p, occluders);
    if (debug) console.log('peak', { yLeft: p.yLeft, yRight: Math.round(yRight), slope: +p.slope.toFixed(2), votes: p.votes, ok: !!line });
    if (line) verified.push(line);
  }

  // Merge near-duplicates (both edges of one stroke), keep the best.
  verified.sort((a, b) => b.score - a.score);
  const unique: FrameLine[] = [];
  for (const l of verified) {
    const dup = unique.find(
      (u) => Math.abs(u.yLeft - l.yLeft) <= f.maxStrokePx + 6 && Math.abs(u.yRight - l.yRight) <= f.maxStrokePx + 6,
    );
    if (!dup) unique.push(l);
  }

  // Parallel families are texture, not borders.
  const slopeOf = (l: FrameLine) => (l.yRight - l.yLeft) / width;
  return unique
    .filter((l) => {
      const near = unique.filter(
        (o) =>
          o !== l &&
          Math.abs(slopeOf(o) - slopeOf(l)) <= 0.04 &&
          Math.abs((o.yLeft + o.yRight) / 2 - (l.yLeft + l.yRight) / 2) <= 0.4 * width,
      );
      return near.length < f.maxParallel;
    })
    .sort((a, b) => a.yLeft + a.yRight - (b.yLeft + b.yRight));
}

/**
 * Balloons are often drawn over a border. Samples inside a dialogue zone are skipped rather than
 * counted as misses, as long as `minVisible` of the line stays visible.
 */
function verifyLine(gray: Uint8Array, width: number, piece: Interval, p: Candidate, occluders: Rect[]): FrameLine | null {
  const f = config.frames;
  const d = Math.ceil(f.maxStrokePx / 2) + 2;
  const step = 3;
  const samples = Math.floor((width - 4) / step);
  let best: FrameLine | null = null;

  for (let shift = -3; shift <= 3; shift++) {
    let n = 0;
    let hidden = 0;
    let dark = 0;
    let light = 0;
    let edge = 0;
    const darkVals: number[] = [];
    const lightVals: number[] = [];
    const ends = { dark: [0, 0, 0, 0], light: [0, 0, 0, 0], edge: [0, 0, 0, 0] }; // [leftHit, leftN, rightHit, rightN]
    for (let x = 2; x < width - 2; x += step) {
      const yc = Math.round(p.yLeft + shift + p.slope * x);
      if (yc - d - 5 < piece.y0 || yc + d + 5 >= piece.y1) continue;
      if (occluders.some((o) => x >= o.x0 && x < o.x1 && yc + d + 5 >= o.y0 && yc - d - 5 < o.y1)) {
        hidden++;
        continue;
      }
      let mn = 255;
      let mx = 0;
      for (let t = -2; t <= 2; t++) {
        const v = gray[(yc + t) * width + x];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      let above = 0;
      let below = 0;
      for (let t = 0; t < 5; t++) {
        above += gray[(yc - d - t) * width + x];
        below += gray[(yc + d + t) * width + x];
      }
      above /= 5;
      below /= 5;
      n++;
      const isDark = above - mn >= f.strokeContrast && below - mn >= f.strokeContrast;
      const isLight = mx - above >= f.strokeContrast && mx - below >= f.strokeContrast;
      const isEdge = Math.abs(above - below) >= f.edgeContrast;
      if (isDark) {
        dark++;
        darkVals.push(mn);
      }
      if (isLight) {
        light++;
        lightVals.push(mx);
      }
      if (isEdge) edge++;
      const side = x < 0.1 * width ? 0 : x > 0.9 * width ? 2 : -1;
      if (side >= 0) {
        ends.dark[side + 1]++;
        ends.light[side + 1]++;
        ends.edge[side + 1]++;
        if (isDark) ends.dark[side]++;
        if (isLight) ends.light[side]++;
        if (isEdge) ends.edge[side]++;
      }
    }
    if (n + hidden < 0.8 * samples || n < f.minVisible * samples) continue;
    // Each strip edge must support the line, unless most of that edge is behind a balloon.
    const endSamples = (0.1 * width) / step;
    const endOk = (hit: number, seen: number) => seen < 0.5 * endSamples || hit / seen >= 0.6;
    const endsOk = (e: number[]) =>
      (e[1] >= 0.5 * endSamples || e[3] >= 0.5 * endSamples) && endOk(e[0], e[1]) && endOk(e[2], e[3]);
    const consistent = (vals: number[]) => {
      if (vals.length < 2) return false;
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length);
      return sd <= 30;
    };
    const yLeft = p.yLeft + shift;
    const yRight = yLeft + p.slope * width;
    if (process.env.WSC_DEBUG_FRAMES === '1' && shift === 0) {
      const r2 = (v: number) => Math.round(v * 100) / 100;
      console.log('  verify', { n, hidden, dark: r2(dark / n), light: r2(light / n), edge: r2(edge / n), ends });
    }
    const options: FrameLine[] = [];
    if (dark / n >= f.strokeCoverage && endsOk(ends.dark) && consistent(darkVals)) {
      options.push({ yLeft, yRight, kind: 'stroke', score: dark / n });
    }
    if (light / n >= f.strokeCoverage && endsOk(ends.light) && consistent(lightVals)) {
      options.push({ yLeft, yRight, kind: 'stroke', score: light / n });
    }
    if (edge / n >= f.edgeCoverage && endsOk(ends.edge)) {
      options.push({ yLeft, yRight, kind: 'edge', score: edge / n - 0.1 });
    }
    for (const o of options) if (!best || o.score > best.score) best = o;
  }
  if (best) {
    best.yLeft = Math.round(best.yLeft);
    best.yRight = Math.round(best.yRight);
    best.score = Math.round(best.score * 1000) / 1000;
  }
  return best;
}
