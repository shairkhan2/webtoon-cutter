import { config } from './config.ts';

export interface RowStats {
  /** 1 where the full-width row carries no visible content (gutter colour, flat fill, smooth fade). */
  flat: Uint8Array;
  /** Share of pixels on the row with a strong gradient. Used as the price of cutting there. */
  detail: Float32Array;
}

export interface CellMap {
  size: number;
  cols: number;
  rows: number;
  /** 1 where the cell has visible structure. */
  content: Uint8Array;
}

export function analyzeRows(gray: Uint8Array, width: number, height: number): RowStats {
  const c = config.rows;
  const flat = new Uint8Array(height);
  const detail = new Float32Array(height);
  const hist = new Int32Array(256);
  const maxOutliers = Math.max(2, Math.round(c.flatOutlierFrac * width));
  // Robust row range: ignore the darkest and brightest 0.5% of pixels (JPEG ringing, specks).
  const lowCount = Math.floor(width * 0.005);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    hist.fill(0);
    for (let x = 0; x < width; x++) hist[gray[row + x]]++;

    let cum = 0;
    let med = 0;
    let lo = -1;
    let hi = 255;
    for (let v = 0; v < 256; v++) {
      cum += hist[v];
      if (lo < 0 && cum > lowCount) lo = v;
      if (cum > width >> 1) {
        med = v;
        break;
      }
    }
    cum = 0;
    for (let v = 255; v >= 0; v--) {
      cum += hist[v];
      if (cum > lowCount) {
        hi = v;
        break;
      }
    }
    let outliers = 0;
    for (let v = 0; v < 256; v++) if (Math.abs(v - med) > c.flatDeviation) outliers += hist[v];

    let isFlat = outliers <= maxOutliers;
    if (!isFlat && hi - lo <= c.smoothRangeMax) {
      // Horizontal gradient fills: wide value range but no local steps.
      let maxStep = 0;
      for (let x = 2; x < width; x++) {
        const d = Math.abs(gray[row + x] - gray[row + x - 2]);
        if (d > maxStep) maxStep = d;
      }
      isFlat = maxStep <= c.smoothStep;
    }
    flat[y] = isFlat ? 1 : 0;

    if (y > 0 && y < height - 1) {
      let strong = 0;
      const up = row - width;
      const dn = row + width;
      for (let x = 1; x < width - 1; x++) {
        const g = Math.abs(gray[row + x + 1] - gray[row + x - 1]) + Math.abs(gray[dn + x] - gray[up + x]);
        if (g > c.detailGradient) strong++;
      }
      detail[y] = strong / width;
    }
  }
  return { flat, detail };
}

/** Coarse content map: one cell per `size`×`size` block. */
export function analyzeCells(gray: Uint8Array, width: number, height: number): CellMap {
  const size = config.cells.size;
  const cols = Math.ceil(width / size);
  const rows = Math.ceil(height / size);
  const content = new Uint8Array(cols * rows);
  const n = new Int32Array(cols);
  const sum = new Float64Array(cols);
  const sq = new Float64Array(cols);
  const mn = new Uint8Array(cols);
  const mx = new Uint8Array(cols);

  for (let cy = 0; cy < rows; cy++) {
    n.fill(0);
    sum.fill(0);
    sq.fill(0);
    mn.fill(255);
    mx.fill(0);
    const y1 = Math.min(height, (cy + 1) * size);
    for (let y = cy * size; y < y1; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const v = gray[row + x];
        const cx = (x / size) | 0;
        n[cx]++;
        sum[cx] += v;
        sq[cx] += v * v;
        if (v < mn[cx]) mn[cx] = v;
        if (v > mx[cx]) mx[cx] = v;
      }
    }
    for (let cx = 0; cx < cols; cx++) {
      const mean = sum[cx] / n[cx];
      const std = Math.sqrt(Math.max(0, sq[cx] / n[cx] - mean * mean));
      content[cy * cols + cx] = mx[cx] - mn[cx] > config.cells.rangeMin && std > config.cells.stdMin ? 1 : 0;
    }
  }
  return { size, cols, rows, content };
}

/** Prefix sums over flat rows so "is [a, b) entirely flat" is O(1). */
export function prefixSum(mask: ArrayLike<number>): Int32Array {
  const out = new Int32Array(mask.length + 1);
  for (let i = 0; i < mask.length; i++) out[i + 1] = out[i] + (mask[i] ? 1 : 0);
  return out;
}
